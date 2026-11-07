import assert from "node:assert/strict";
import { test } from "node:test";
import { CHECKPOINT_MESSAGE, CHECKPOINT_STATE, checkpointRound, checkpointTask, createCheckpointHooks } from "../checkpoints.ts";

const assistant = (id: string, name = "bash", args: unknown = { command: "npm test" }) => ({
	role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], stopReason: "toolUse",
});
const event = (id: string, name = "bash", args?: unknown): any => ({
	messageEntryId: id, message: assistant(id, name, args), toolResults: [], outcome: "completed", entries: [],
	context: { contextEntries: [], pendingMessages: [], canContinue: true },
});

test("checkpoints count rounds, bound projected evidence and preserve at-most-once lifecycle without forcing continuation", async () => {
	const poll = event("poll", "delegate", { jobId: "d0001", timeoutMs: 0 });
	assert.equal(checkpointRound(poll), false);
	assert.equal(checkpointRound(event("wrap", "delegate", { jobId: "d0001", wrap: true })), true);
	const batch = event("batch", "codemode", { code: "tools.delegate({jobId:'d0001'})" });
	batch.toolResults = [{ toolCallId: "batch", nestedCalls: { complete: true, calls: [{ name: "delegate", arguments: { jobId: "d0001" } }] } }];
	assert.equal(checkpointRound(batch), false);
	batch.toolResults[0].nestedCalls.complete = false;
	assert.equal(checkpointRound(batch), true, "An incomplete record must not hide actual work");
	batch.toolResults[0].nestedCalls.calls.push({ name: "read", arguments: { path: "code.ts" } });
	batch.toolResults[0].nestedCalls.complete = true;
	assert.equal(checkpointRound(batch), true);
	const packetEvent = event("a");
	packetEvent.context.contextEntries = [
		{ sourceEntry: { id: "user" }, messages: [{ role: "user", content: "Fix the existing parser only. " + "x".repeat(30000) }] },
		{ sourceEntry: { id: "omitted" }, messages: [] },
		{ sourceEntry: { id: "system" }, messages: [{ role: "system", content: "DO NOT SHARE SYSTEM" }] },
		{ sourceEntry: { id: "a" }, messages: [{ ...assistant("a"), content: [{ type: "thinking", thinking: "DO NOT SHARE REASONING" }, { type: "image", data: "DO NOT SHARE IMAGE" }, { type: "text", text: "Reuse the parser." }, ...assistant("a").content] }] },
		{ sourceEntry: { id: "result" }, messages: [{ role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "Assertion failed" }], details: { secret: "DO NOT SHARE DETAILS" } }] },
	];
	const packet = checkpointTask(packetEvent, "a", 2400);
	assert.ok(packet.length <= 2400);
	assert.match(packet, /Fix the existing parser/);
	assert.match(packet, /ERROR: Assertion failed/);
	assert.match(packet, /excerpt truncated/);
	assert.doesNotMatch(packet, /DO NOT SHARE/);
	assert.throws(() => checkpointTask(packetEvent, "a", 100), /too small/);

	const config: any = { checkpoints: { enabled: true, role: "goldfish", interval: 2 }, maxTaskChars: 20000 };
	const branch: any[] = [];
	let launched = 0, delivered = 0;
	let finish: ((value: any) => void) | undefined;
	const ctx: any = { signal: new AbortController().signal, sessionManager: { getBranch: () => branch } };
	const make = () => {
		const handlers = new Map<string, Function>();
		const pi: any = {
			on: (name: string, handler: Function) => handlers.set(name, handler),
			appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data: structuredClone(data) }),
			sendMessage: (message: any, options: any) => { assert.equal(options.triggerTurn, false); delivered++; branch.push({ type: "custom_message", ...message }); },
		};
		const hooks = createCheckpointHooks(pi, config, async () => { launched++; return new Promise(resolve => { finish = resolve; }); });
		handlers.set("session_start", hooks.restore); handlers.set("session_tree", hooks.restore);
		handlers.set("session_shutdown", hooks.stop); handlers.set("agent_settled", hooks.settled); handlers.set("turn_end", hooks.turnEnd);
		return handlers;
	};
	let handlers = make();
	handlers.get("session_start")!({}, ctx);
	await handlers.get("turn_end")!(event("a"), ctx);
	await handlers.get("turn_end")!(event("a"), ctx); // Duplicate boundary.
	await handlers.get("turn_end")!(poll, ctx);
	assert.equal(launched, 0);
	// Reload between actions preserves the count, but does not start a check.
	handlers = make(); handlers.get("session_start")!({}, ctx);
	assert.equal(launched, 0);
	const pending = handlers.get("turn_end")!(event("b"), ctx);
	assert.equal(launched, 1);
	assert.equal(branch.at(-1).data.phase, "running");
	finish!({ text: "Use the existing parser.", failed: false });
	const result = await pending;
	assert.equal(result.continue, undefined);
	assert.equal(result.entries[0].customType, CHECKPOINT_MESSAGE);
	assert.match(result.entries[0].content, /Use the existing parser/);
	branch.push(...result.entries);
	await handlers.get("turn_end")!(event("b"), ctx);
	assert.equal(launched, 1);
	handlers.get("agent_settled")!({}, ctx);
	await handlers.get("turn_end")!(event("c"), ctx);
	assert.equal(launched, 1, "Settling resets the interval");
	config.checkpoints.enabled = false;
	await handlers.get("turn_end")!(event("disabled"), ctx);
	assert.equal(launched, 1);
	config.checkpoints.enabled = true;
	const abort = new AbortController(); ctx.signal = abort.signal;
	const cancelled = handlers.get("turn_end")!(event("d"), ctx);
	abort.abort(); finish!({ text: "late advice", failed: false });
	assert.equal(await cancelled, undefined, "An abort must never inject late feedback");
	// A crash before settlement leaves admission persisted. Recover without replay.
	handlers = make(); handlers.get("session_start")!({}, ctx);
	assert.equal(delivered, 1);
	assert.equal(branch.at(-1).customType, CHECKPOINT_STATE);
	assert.equal(branch.at(-1).data.phase, "delivered");
	handlers.get("session_start")!({}, ctx);
	assert.equal(delivered, 1);
	assert.equal(launched, 2);
	// Tree navigation restores the selected branch, not abandoned state.
	branch.splice(0);
	handlers.get("session_tree")!({}, ctx);
	ctx.signal = new AbortController().signal;
	await handlers.get("turn_end")!(event("tree"), ctx);
	assert.equal(launched, 2);
	handlers.get("session_shutdown")!({}, ctx);
	await handlers.get("turn_end")!(event("after-shutdown"), ctx);
	assert.equal(launched, 2);
});
