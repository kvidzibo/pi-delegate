import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createReadToolDefinition, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { installRuntimeGuard } from "../../child-runtime/guard.ts";
import { GUARD_COMMAND, type FinalizationProgress } from "../../child-runtime/guard-protocol.ts";
import { runPiChild } from "../../child-runtime/spawn.ts";
import { buildChildArgs, buildChildEnv } from "../../delegate/spawn.ts";

export async function finalizationProbe(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
	const handlers = new Map<string, Function>(), commands = new Map<string, any>(), tools = new Map<string, any>();
	const notices: any[] = [];
	let active: string[] = [];
	const api = { ...pi, registerCommand: (name: string, command: unknown) => commands.set(name, command),
		registerTool: (tool: any) => tools.set(tool.name, tool), on: (name: string, fn: Function) => handlers.set(name, fn),
		setActiveTools: (names: string[]) => { active = [...names]; }, getActiveTools: () => [...active],
	} as unknown as ExtensionAPI;
	const testCtx: any = { ...ctx, mode: "rpc", ui: { ...ctx.ui, notify: (text: string) => notices.push(JSON.parse(text)) } };
	const nonce = "fixture-runtime-guard-1234";
	installRuntimeGuard(api, { nonce, tools: ["read", "bash", "write", "edit", "grep", "find", "ls"] });
	await handlers.get("session_start")!({}, testCtx);
	assert.equal(notices.at(-1).event, "ready");
	assert.deepEqual([...tools.keys()], active);
	const original = createReadToolDefinition(ctx.cwd);
	for (const key of ["name", "label", "description", "parameters", "promptSnippet", "promptGuidelines"] as const) {
		assert.deepEqual(tools.get("read")[key], original[key], `preserve builtin ${key}`);
	}
	const source = join(ctx.cwd, "guard-read-fixture.txt"); writeFileSync(source, "fixture content");
	const read = await tools.get("read").execute("before", { path: source }, undefined, undefined, testCtx);
	assert.match(read.content[0].text, /fixture content/);

	const began = join(ctx.cwd, "guard-current-started"), finished = join(ctx.cwd, "guard-current-finished");
	const forbidden = join(ctx.cwd, "guard-forbidden-write");
	const current = tools.get("bash").execute("current", {
		command: `printf started > '${began}'; sleep 0.15; printf done > '${finished}'`,
	}, undefined, undefined, testCtx);
	try {
		for (let i = 0; i < 100 && !existsSync(began); i++) await delay(5);
		assert.ok(existsSync(began), "current tool must actually enter execution before finalization");
		// Capture an execution thunk before gate closure, like a cleared parallel-preflight call.
		const prepared = () => tools.get("write").execute("prepared", { path: forbidden, content: "must not happen" }, undefined, undefined, testCtx);
		await commands.get(GUARD_COMMAND).handler(nonce, testCtx);
		assert.equal(notices.at(-1).state.phase, "draining"); assert.deepEqual(active, []);
		await assert.rejects(prepared(), /finalization blocks/);
		// Repeated attempts ignoring the instruction are still blocked at the tool body.
		for (let i = 0; i < 3; i++) await assert.rejects(prepared(), /finalization blocks/);
		await current;
		assert.equal(readFileSync(finished, "utf8"), "done"); assert.equal(existsSync(forbidden), false);
		assert.equal(notices.at(-1).state.phase, "answering");
		await commands.get(GUARD_COMMAND).handler(nonce, testCtx);
		await assert.rejects(prepared(), /finalization blocks/);
	} finally { await current; await handlers.get("session_shutdown")!(); }

	// Real offline Pi subprocess: guard must load, receive early control and acknowledge enforcement.
	// beforePrompt always throws, so no initial task or model request can be sent.
	const model = "openai-codex/gpt-5.6-luna";
	const prompt = join(ctx.cwd, "runtime-guard-prompt.md"); writeFileSync(prompt, "Offline startup fixture; no model requests.");
	let acknowledged = false;
	const states: FinalizationProgress[] = [];
	const result = await runPiChild({ cwd: ctx.cwd, model, task: "MUST NOT BE SENT", hardTimeoutMs: 10000, maxOutputBytes: 65536,
		promptSourcePath: prompt, env: buildChildEnv(process.env),
		buildArgs: promptPath => buildChildArgs({ model, thinking: "off", tools: ["read", "bash"], promptPath,
			sessionFile: join(ctx.cwd, "runtime-guard-session.jsonl"), offline: true }),
		execution: { tools: ["read", "bash"], finalizeAfterMs: 0, finalizationGraceMs: 10000, startupTimeoutMs: 8000 },
		onControl: ctl => { assert.equal(ctl.wrap(), true); },
		onEvent: (event: any) => { if (event.type === "delegate_finalization") states.push(event.state); },
		beforePrompt: async () => {
			acknowledged = states.at(-1)?.phase === "answering";
			throw new Error("offline test stopped after enforced finalization acknowledgement");
		},
	});
	assert.equal(acknowledged, true, result.text);
	assert.equal(result.diag?.sawAssistant, false);
	assert.match(result.text, /offline test stopped after enforced finalization acknowledgement/);
	assert.equal(result.finalization?.phase, "answering");
	return { realGuardHandshake: true, currentToolDrained: true, preparedToolBlocked: true,
		metadataPreserved: true, promptWithheld: true, noModelCalls: true };
}
