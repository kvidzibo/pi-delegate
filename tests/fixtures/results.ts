import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import delegate from "../../delegate/index.ts";
import { delegateTargetLine } from "../../delegate/display.ts";
import { CARD_STATE_TYPE } from "../../delegate/cards.ts";
import { NOTIFY_HOLD_MS } from "../../delegate/notify.ts";
import { truncateOutput } from "../../child-runtime/policy.ts";
import type { RunChildInput } from "../../delegate/spawn.ts";
import { DEFAULT_WRAP_MESSAGE, encodeRpc, type ChildControl, type ChildResult } from "../../child-runtime/spawn.ts";
import { mockChild, runMockPiChild } from "../../child-runtime/tests/helpers.ts";

async function wrappedResult(): Promise<ChildResult> {
	const proc = mockChild();
	let control!: ChildControl;
	const pending = runMockPiChild({ cwd: process.cwd(), model: "xai/grok-4.6", task: "mock wrap",
		hardTimeoutMs: 0, maxOutputBytes: 220, env: {}, buildArgs: () => [], spawnFn: () => proc,
		promptSourcePath: fileURLToPath(new URL("../../delegate/prompts/review.md", import.meta.url)),
		onControl: next => { control = next; },
	});
	const emit = (message: object) => proc.stdout!.write(encodeRpc({ type: "message_end", message }));
	emit({ role: "user", content: "Task: mock wrap" });
	emit({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Original report: " + "界".repeat(2000) }] });
	control.wrap();
	emit({ role: "user", content: DEFAULT_WRAP_MESSAGE });
	emit({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Correction: use B." }] });
	proc.stdout!.write(encodeRpc({ type: "agent_settled" }));
	const result = await pending;
	assert.match(result.text, /Original report:/);
	assert.match(result.text, /Wrap-up 1/);
	assert.match(result.text, /Correction: use B\./);
	assert.ok(Buffer.byteLength(result.text) <= 220);
	return result;
}

/** Exercise all returned result paths through the real factory, with no provider calls. */
export async function resultProbe(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
	let tool: any, busy = true;
	const handlers = new Map<string, Function>();
	const entries: any[] = [], notices: any[] = [];
	const runs: Array<{ input: RunChildInput; resolve: (result: ChildResult) => void }> = [];
	delegate({ ...pi, registerTool: (next: any) => { tool = next; }, registerCommand() {}, registerMessageRenderer() {},
		on: (name: string, handler: Function) => handlers.set(name, handler),
		appendEntry: (customType: string, data: any) => entries.push({ customType, data }),
		sendMessage: (message: any) => notices.push(message),
	} as unknown as ExtensionAPI, (input) => new Promise((resolve) => {
		runs.push({ input, resolve });
		input.signal?.addEventListener("abort", () => resolve({ text: "Cancelled", exitCode: 1, stopReason: "aborted", stderrTail: "" }), { once: true });
	}));
	const testCtx: any = { ...ctx, hasUI: true, isIdle: () => !busy,
		ui: { ...ctx.ui, setWidget() {}, setStatus() {} },
		sessionManager: { getSessionId: () => "result-probe", getSessionFile: () => undefined, getBranch: () => [] },
	};
	const model = "xai/grok-4.6";
	const success: ChildResult = { text: "Complete answer", model, exitCode: 0, stderrTail: "" };
	let seq = 0;
	const call = (params: object, signal?: AbortSignal, onUpdate?: (result: any) => void) =>
		tool.execute(`result-${++seq}`, params, signal, onUpdate, testCtx);
	const launch = (options: object = {}, signal?: AbortSignal) => call({ kind: "review", model, task: "Mock result contract", background: true, ...options }, signal);
	const pending = (result: any, status: string, callType: string, operation?: string) => {
		assert.equal(result.details.ok, true);
		assert.equal(result.isError, false);
		assert.equal(result.details.status, status);
		assert.equal(result.details.pending, true);
		assert.equal(result.details.terminal, false);
		assert.equal(result.details.background, true);
		assert.equal(result.details.callType, callType);
		assert.equal(result.details.operation, operation);
		assert.equal(result.details.answer, undefined);
		assert.equal(result.details.exitCode, undefined);
		assert.match(result.content[0].text, new RegExp(`bg ${result.details.jobId} ${status}`));
		assert.match(result.content[0].text, /quietForMs: \d+/);
		assert.match(result.content[0].text, /jobId waits, wrap:true wraps, cancel:true kills/);
		assert.ok(result.details.runId && result.details.sessionFile && result.details.originToolCallId);
	};
	await handlers.get("session_start")?.({}, testCtx);
	try {
		// Freeze the existing terminal return shapes, including intentional foreground/collect differences.
		for (const outcome of [success, await wrappedResult(), { ...success, model: undefined },
			{ ...success, model: "hosted/actual-model", text: "Partial answer", exitCode: 1, stopReason: "error" },
			{ ...success, text: "Partial limit", stopReason: "length" },
			{ ...success, text: "", stderrTail: "Provider unavailable", exitCode: 1, stopReason: "error" },
			{ ...success, text: "", exitCode: 1, stopReason: "hard_timeout" },
			{ ...success, text: "" },
			{ ...success, text: "界".repeat(24000) },
		]) {
			for (const background of [false, true]) {
				const launched = launch({ background, timeoutMs: 2000 });
				const run = runs.at(-1)!;
				let result: any;
				if (background) {
					const accepted = await launched;
					pending(accepted, "running", "spawn");
					run.resolve(outcome);
					result = await call({ jobId: accepted.details.jobId });
				} else {
					run.resolve(outcome);
					result = await launched;
				}
				const failed = outcome.exitCode !== 0 || outcome.stopReason === "length" || !outcome.text;
				const rawText = outcome.text || outcome.stderrTail || (background ? outcome.stopReason : undefined) || "(no output)";
				const text = truncateOutput(rawText, run.input.maxOutputBytes);
				const prefix = failed ? `delegate failed (${outcome.stopReason || outcome.exitCode}): ` : "";
				assert.equal(result.content[0].text, `${prefix}${delegateTargetLine("review", outcome.model || model)}\n\n${text}`);
				assert.equal(result.details.ok, !failed);
				assert.equal(result.isError, failed);
				assert.equal(result.details.model, outcome.model || model);
				assert.equal(result.details.status, failed ? "failed" : "done");
				assert.equal(result.details.exitCode, outcome.exitCode);
				assert.equal(result.details.stopReason, outcome.stopReason);
				assert.equal(result.details.stderrTail, outcome.stderrTail || undefined);
				assert.equal(result.details.background, background);
				assert.equal(result.details.callType, background ? "collect" : "spawn");
				assert.equal(result.details.operation, background ? "wait" : undefined);
				assert.equal(result.details.pending, background ? false : undefined);
				assert.equal(result.details.terminal, true);
				assert.equal(result.details.answer, outcome.text || (background ? rawText : text));
				assert.equal(entries.filter(e => e.customType === CARD_STATE_TYPE && e.data.runId === result.details.runId).length, 1);
			}
		}

		const earlyAbort = new AbortController(); earlyAbort.abort();
		const beforeAbort = runs.length;
		const abortedLaunch = await launch({ background: false }, earlyAbort.signal);
		assert.equal(runs.length, beforeAbort, "an already-aborted foreground call cannot start a child");
		assert.equal(abortedLaunch.details.ok, false); assert.equal(abortedLaunch.details.stopReason, "aborted");
		assert.equal(abortedLaunch.details.answer, "(no output)"); assert.equal(abortedLaunch.details.pending, undefined);

		// Live check-ins stay nonterminal; wrap steers without killing and peek ignores parent Esc.
		const accepted = await launch();
		const running = runs.at(-1)!;
		let wraps = 0;
		running.input.onControl?.({ wrap() { wraps++; return true; } });
		running.input.onEvent?.({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "one.ts" } });
		running.input.onEvent?.({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read" });
		running.input.onEvent?.({ type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash", args: { command: "echo mock" } });
		const aborted = new AbortController(); aborted.abort();
		for (const [args, operation] of [[{ timeoutMs: 0 }, "peek"], [{ timeoutMs: 1 }, "wait"], [{ wrap: true, timeoutMs: 1 }, "wrap"]] as const) {
			const result = await call({ jobId: accepted.details.jobId, ...args }, aborted.signal);
			pending(result, "running", "collect", operation);
			assert.match(result.content[0].text, /✓ read one.ts/);
			assert.match(result.content[0].text, /current: bash echo mock/);
			assert.equal(running.input.signal?.aborted, false);
			if (operation === "wrap") {
				assert.equal(result.details.wrapped, true); assert.equal(wraps, 1);
				assert.match(result.content[0].text, /wrap queued/);
			}
		}
		running.resolve(success);
		await call({ jobId: accepted.details.jobId });

		// Optional guarded runners distinguish request from enforcement in live receipts and terminal details.
		const guarded = await launch(); const guardedRun = runs.at(-1)!;
		for (const [state, expected] of [
			[{ phase: "requested", reason: "wrap" }, /enforcement not yet acknowledged/],
			[{ phase: "draining", reason: "wrap", activeTools: 1 }, /finalization enforced; 1 current tools draining/],
			[{ phase: "answering", reason: "wrap", activeTools: 0 }, /finalization enforced; waiting for the final answer/],
		] as const) {
			guardedRun.input.onEvent?.({ type: "delegate_finalization", state });
			const receipt = await call({ jobId: guarded.details.jobId, timeoutMs: 0 });
			assert.deepEqual(receipt.details.finalization, state); assert.match(receipt.content[0].text, expected);
		}
		guardedRun.resolve({ ...success, stopReason: "finalization_timeout", text: "Grace expired; partial evidence.",
			finalization: { phase: "answering", reason: "wrap", activeTools: 0 } });
		const guardResult = await call({ jobId: guarded.details.jobId });
		assert.equal(guardResult.details.ok, false); assert.equal(guardResult.details.stopReason, "finalization_timeout");
		assert.equal(guardResult.details.finalization.phase, "answering"); assert.match(guardResult.content[0].text, /partial evidence/);

		// A foreground timeout promotes rather than aborts; queue reason and cancellation survive.
		const foregroundSignal = new AbortController();
		const timed = await launch({ background: false, timeoutMs: 1000 }, foregroundSignal.signal);
		const timedRun = runs.at(-1)!;
		pending(timed, "running", "spawn");
		foregroundSignal.abort(); assert.equal(timedRun.input.signal?.aborted, false);
		timedRun.resolve(success); await call({ jobId: timed.details.jobId });
		const local = { kind: "recon", model: "local-qwen38/qwen38-q4km" };
		const blocker = await launch(local);
		for (const background of [true, false]) {
			const queued = await launch({ ...local, background, timeoutMs: 1000 });
			pending(queued, "queued", "spawn");
			assert.equal(queued.details.reason, "gpu"); assert.match(queued.content[0].text, /Waiting for gpu/);
			const peek = await call({ jobId: queued.details.jobId, timeoutMs: 0 });
			pending(peek, "queued", "collect", "peek");
			const stopped = await call({ jobId: queued.details.jobId, [background ? "cancel" : "wrap"]: true });
			assert.equal(stopped.details.ok, false); assert.equal(stopped.details.answer, "aborted");
			assert.equal(stopped.details.stopReason, "aborted"); assert.equal(stopped.details.pending, false);
		}
		const cancelled = await call({ jobId: blocker.details.jobId, cancel: true });
		assert.equal(cancelled.details.answer, "Cancelled"); assert.equal(cancelled.details.operation, "cancel");
		assert.equal(cancelled.details.ok, false); assert.equal(cancelled.details.stopReason, "aborted");

		// Every terminal collect above consumes its notice; a pending peek must not consume one.
		busy = false;
		await new Promise(resolve => setTimeout(resolve, NOTIFY_HOLD_MS * 2));
		assert.equal(notices.length, 0);
		const uncollected = await launch();
		await call({ jobId: uncollected.details.jobId, timeoutMs: 0 });
		runs.at(-1)!.resolve(success);
		for (let attempt = 0; attempt < 100 && !notices.length; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
		assert.equal(notices.length, 1); assert.equal(notices[0].details.jobId, uncollected.details.jobId);
		await call({ jobId: uncollected.details.jobId });
	} finally { await handlers.get("session_shutdown")?.(); }
	return { terminalContracts: true, pendingContracts: true, promotion: true, notificationConsumption: true, wrapPreservation: true, finalizationProgress: true, noModelCalls: true };
}
