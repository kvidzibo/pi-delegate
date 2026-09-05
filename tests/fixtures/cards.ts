import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import delegate from "../../delegate/index.ts";
import { CARD_STATE_TYPE } from "../../delegate/cards.ts";
import type { RunChildInput } from "../../delegate/spawn.ts";
import type { ChildResult } from "../../child-runtime/spawn.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text, italic: (text: string) => text };
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const success: ChildResult = { text: "**Review complete.**\n\nNo important findings.\n\nMore detail.\nLast detail.", model: "xai/grok-4.6", exitCode: 0, stderrTail: "" };

export async function cardProbe(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
	const entries: any[] = [];
	const runs: Array<{ input: RunChildInput; resolve: (result: ChildResult) => void }> = [];
	let failPersistence = false;
	const make = () => {
		let tool: any; const handlers = new Map<string, Function>();
		delegate({ ...pi, registerTool: (t: any) => { tool = t; }, registerCommand: () => {}, registerMessageRenderer: () => {},
			on: (name: string, fn: Function) => handlers.set(name, fn),
			appendEntry: (customType: string, data: any) => { if (failPersistence) throw new Error("disk error"); entries.push({ type: "custom", customType, data }); },
			sendMessage: () => { throw new Error("busy parent should not notify"); },
		} as unknown as ExtensionAPI, (input) => new Promise((resolve) => {
			runs.push({ input, resolve });
			input.signal?.addEventListener("abort", () => resolve({ text: "Cancelled by user", exitCode: 1, stopReason: "aborted", stderrTail: "" }), { once: true });
		}));
		return { tool, handlers };
	};
	const testCtx: any = { ...ctx, isIdle: () => false, hasUI: true,
		ui: { ...ctx.ui, setWidget: () => {}, setStatus: () => {}, notify: () => {} },
		sessionManager: { getSessionId: () => "card-probe", getSessionFile: () => undefined, getBranch: () => entries },
	};
	const first = make(); await first.handlers.get("session_start")?.({}, testCtx);
	assert.equal(first.tool.renderShell, "self", "background receipts must not inherit a success-green shell");
	const rows = new Map<string, any>();
	const row = (tool: any, id: string, args: object) => {
		let invalidations = 0;
		const context: any = { toolCallId: id, args, state: {}, expanded: false, isPartial: true, isError: false, invalidate: () => { invalidations++; } };
		let result: any;
		const render = (width = 100) => {
			const header = tool.renderCall(args, theme, context);
			const body = result ? tool.renderResult(result, { expanded: context.expanded, isPartial: context.isPartial }, theme, context) : undefined;
			const lines = [...header.render(width), ...(body?.render(width) ?? [])];
			assert.ok(lines.every((s: string) => visibleWidth(s) <= width), `row exceeds width ${width}`);
			return plain(lines.join("\n"));
		};
		const update = (next: any, partial = true) => { result = next; context.isPartial = partial; context.isError = next.details?.ok === false; render(); };
		const api = { render, update, context, invalidations: () => invalidations };
		rows.set(id, api); return api;
	};
	const launch = async (tool: any, id: string, options: object = {}) => {
		const args = { kind: "review", model: "xai/grok-4.6", task: "Review timeout and abort handling", background: true, ...options };
		const r = row(tool, id, args);
		const result = await tool.execute(id, args, undefined, (r: any) => rows.get(id).update(r), testCtx);
		r.update(result, false);
		entries.push({ type: "message", message: { role: "toolResult", toolName: "delegate", toolCallId: id, details: result.details } });
		return { row: r, result };
	};
	// A dead progress observer must not hide an accepted job or strand its archive.
	for (const throwAt of [1, 2]) {
		let updates = 0;
		const beforeRuns = runs.length;
		const accepted = await first.tool.execute(`throwing-${throwAt}`, {
			kind: "review", task: "mock observer", model: "xai/grok-4.6", background: true,
		}, undefined, () => { if (++updates === throwAt) throw new Error("dead observer"); }, testCtx);
		assert.equal(accepted.details.ok, true);
		assert.ok(accepted.details.jobId);
		assert.equal(runs.length, beforeRuns + 1);
		runs.at(-1)!.resolve(success);
		const collected = await first.tool.execute(`throwing-collect-${throwAt}`, { jobId: accepted.details.jobId }, undefined,
			() => { throw new Error("dead collector"); }, testCtx);
		assert.equal(collected.details.ok, true);
		assert.match(collected.content[0].text, /Review complete/);
		assert.ok(entries.some((e) => e.customType === CARD_STATE_TYPE && e.data.originToolCallId === `throwing-${throwAt}`));
	}
	const completedBeforeOriginal = entries.filter((e) => e.customType === CARD_STATE_TYPE).length;
	const original = await launch(first.tool, "origin");
	const jobId = original.result.details.jobId;
	assert.match(original.row.render(), /Task: Review timeout and abort handling/);
	assert.match(original.row.render(), /Running/);
	assert.equal((original.row.render().match(/grok-4.6/g) ?? []).length, 1);
	const child = runs.at(-1)!;
	child.input.onEvent?.({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "SECRET raw **File/line:** reasoning" } });
	assert.doesNotMatch(original.row.render(), /SECRET|File\/line/);
	child.input.onEvent?.({ type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash", args: { command: "cat > /tmp/test.mjs << 'EOF'" } });
	assert.match(original.row.render(), /executing command/);
	child.input.onEvent?.({ type: "tool_execution_end", toolCallId: "bash-1", toolName: "bash", isError: true });
	assert.doesNotMatch(original.row.render(), /test.mjs/);
	const peekArgs = { jobId, timeoutMs: 0 };
	const peekRow = row(first.tool, "peek", peekArgs);
	const peek = await first.tool.execute("peek", peekArgs, undefined, peekRow.update, testCtx); peekRow.update(peek, false);
	assert.match(peekRow.render(), /checked · running at check/);
	assert.doesNotMatch(peekRow.render(), /test.mjs|Task:|grok/);
	const before = original.row.invalidations();
	child.resolve(success);
	// Wait through the real scheduler/accounting, but do not collect through the tool yet.
	for (let attempt = 0; attempt < 100 && !entries.some((e) => e.customType === CARD_STATE_TYPE && e.data.originToolCallId === "origin"); attempt++) await new Promise((r) => setTimeout(r, 5));
	assert.equal(entries.filter((e) => e.customType === CARD_STATE_TYPE).length, completedBeforeOriginal + 1);
	assert.ok(original.row.invalidations() > before, "returned spawn must be invalidated at completion without a collect call");
	const completed = original.row.render();
	assert.match(completed, /✓ Finished/); assert.match(completed, /Review complete/);
	assert.doesNotMatch(completed, /Running|\*\*|test.mjs|Last detail/);
	original.row.context.expanded = true;
	assert.match(original.row.render(), /Last detail/); assert.match(original.row.render(), /✗ bash/);
	assert.match(original.row.render(), /Session:/);
	for (const width of [1, 2, 8, 16, 80]) original.row.render(width);
	const collectArgs = { jobId }; const collectRow = row(first.tool, "collect", collectArgs);
	const collected = await first.tool.execute("collect", collectArgs, undefined, collectRow.update, testCtx); collectRow.update(collected, false);
	assert.match(collectRow.render(), /result collected/); assert.doesNotMatch(collectRow.render(), /Review complete|test.mjs/);
	assert.equal(entries.filter((e) => e.customType === CARD_STATE_TYPE).length, completedBeforeOriginal + 1, "collect must not persist a duplicate card");
	assert.match(collected.content[0].text, /Last detail/, "parent still receives the full result");
	await first.handlers.get("session_shutdown")?.();

	const restored = make(); await restored.handlers.get("session_start")?.({}, testCtx);
	const oldRow = row(restored.tool, "origin", { kind: "review", task: "Review timeout and abort handling" }); oldRow.update(original.result, false);
	assert.match(oldRow.render(), /✓ Finished/); assert.doesNotMatch(oldRow.render(), /Running/);
	for (const id of ["seed-1", "seed-2"]) {
		const seed = await launch(restored.tool, id);
		runs.at(-1)!.resolve(success);
		await restored.tool.execute(`${id}-collect`, { jobId: seed.result.details.jobId }, undefined, undefined, testCtx);
	}
	const next = await launch(restored.tool, "new-origin");
	assert.equal(next.result.details.jobId, jobId, "fixture must exercise reused short job IDs");
	assert.match(oldRow.render(), /✓ Finished/); assert.match(next.row.render(), /Running/);
	const cancelledArgs = { jobId, cancel: true }; const cancelledRow = row(restored.tool, "cancel", cancelledArgs);
	const cancelled = await restored.tool.execute("cancel", cancelledArgs, undefined, cancelledRow.update, testCtx); cancelledRow.update(cancelled, false);
	assert.match(next.row.render(), /Cancelled/); assert.match(cancelledRow.render(), /Cancelled by user/);
	assert.equal(cancelled.details.ok, false);

	// Queued jobs have no child answer: cancel/wrap must still preserve their stop reason.
	const local = { kind: "recon", model: "local-qwen38/qwen38-q4km" };
	const blocker = await launch(restored.tool, "blocker", local);
	const failedCards: Array<{ id: string; row: any; result: any }> = [];
	for (const action of ["cancel", "wrap"]) {
		const id = `queued-${action}`;
		const queued = await launch(restored.tool, id, local);
		assert.match(queued.row.render(), /Queued — waiting for GPU/);
		const stopped = await restored.tool.execute(`${id}-control`, { jobId: queued.result.details.jobId, [action]: true }, undefined, undefined, testCtx);
		assert.equal(stopped.details.ok, false);
		assert.match(queued.row.render(), /Cancelled/);
		assert.match(queued.row.render(), /aborted/);
		assert.doesNotMatch(queued.row.render(), /no error details/);
		failedCards.push({ id, ...queued });
	}
	for (const [id, stderrTail, stopReason] of [["stderr-only", "Provider connection refused", "error"], ["reason-only", "", "hard_timeout"]]) {
		const failed = await launch(restored.tool, id);
		runs.at(-1)!.resolve({ text: "", stderrTail, stopReason, exitCode: 1 });
		for (let attempt = 0; attempt < 100 && !entries.some((e) => e.customType === CARD_STATE_TYPE && e.data.originToolCallId === id); attempt++) await new Promise((r) => setTimeout(r, 5));
		assert.ok(failed.row.render().includes(stderrTail || stopReason));
		assert.doesNotMatch(failed.row.render(), /no error details/);
		failedCards.push({ id, ...failed });
	}
	// Running control calls have transient activity labels and historical returned receipts.
	for (const action of ["wait", "wrap"]) {
		const args = { jobId: blocker.result.details.jobId, timeoutMs: 1, ...(action === "wrap" ? { wrap: true } : {}) };
		const r = row(restored.tool, `running-${action}`, args); const progress: string[] = [];
		const returned = await restored.tool.execute(`running-${action}`, args, undefined, (next: any) => { r.update(next); progress.push(r.render()); }, testCtx);
		r.update(returned, false);
		assert.ok(progress.some((text) => text.includes(action === "wrap" ? "wrapping up" : "waiting")));
		assert.match(r.render(), action === "wrap" ? /wrap requested/ : /running at check/);
		assert.doesNotMatch(r.render(), /Task:|grok|Recent tools/);
	}

	// Foreground error results use the returned tool details rather than the live card.
	const foregroundLaunch = launch(restored.tool, "foreground-failure", { background: false, timeoutMs: 2000 });
	runs.at(-1)!.resolve({ text: "", stderrTail: "", stopReason: "hard_timeout", exitCode: 1 });
	const foreground = await foregroundLaunch;
	assert.equal(foreground.result.details.ok, false);
	assert.match(foreground.row.render(), /hard_timeout/);

	// A failed persistence observer must not change outcomes or suppress accounting.
	failPersistence = true;
	const noSave = await launch(restored.tool, "no-save"); runs.at(-1)!.resolve(success);
	const noSaveResult = await restored.tool.execute("no-save-collect", { jobId: noSave.result.details.jobId }, undefined, undefined, testCtx);
	assert.equal(noSaveResult.details.ok, true);
	assert.match(noSave.row.render(), /✓ Finished/);
	assert.match(noSave.row.render(), /Could not save delegate display state/);
	failPersistence = false;
	await restored.handlers.get("session_shutdown")?.();
	const reloaded = make(); await reloaded.handlers.get("session_start")?.({}, testCtx);
	for (const failed of failedCards) {
		const r = row(reloaded.tool, failed.id, failed.row.context.args); r.update(failed.result, false);
		assert.match(r.render(), /Cancelled|Failed/);
		assert.doesNotMatch(r.render(), /no error details|live status unavailable/);
		assert.match(r.render(), /aborted|Provider connection refused|hard_timeout/);
	}
	const branchRow = row(reloaded.tool, "origin", original.row.context.args); branchRow.update(original.result, false);
	await reloaded.handlers.get("session_tree")?.({}, { ...testCtx, sessionManager: { ...testCtx.sessionManager, getBranch: () => [] } });
	assert.match(branchRow.render(), /Historical job — live status unavailable/);
	await reloaded.handlers.get("session_tree")?.({}, testCtx);
	assert.match(branchRow.render(), /✓ Finished/);
	await reloaded.handlers.get("session_shutdown")?.();
	return { liveCard: true, receipts: true, previews: true, restoration: true, cancellation: true, emptyFailures: true, noModelCalls: true };
}
