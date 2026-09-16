import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { JobScheduler } from "../../delegate/jobs.ts";
import { isFailedChildResult } from "../policy.ts";
import { DEFAULT_WRAP_MESSAGE, encodeRpc, type ChildControl, type RunPiChildInput } from "../spawn.ts";
import { GUARD_ENV, GUARD_NOTICE, GUARD_REQUEST_ID, type GuardConfig } from "../guard-protocol.ts";
import { mockChild, runMockPiChild } from "./helpers.ts";
import { headroomPolicyId } from "../headroom.ts";
import { HEADROOM_EXIT_CODE, HEADROOM_STDERR_PREFIX } from "../headroom-protocol.ts";

const PROMPT = fileURLToPath(new URL("../../delegate/prompts/recon.md", import.meta.url));
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function start(t: TestContext, overrides: Partial<RunPiChildInput> = {}) {
	const proc = mockChild();
	let config!: GuardConfig, control!: ChildControl;
	let args: string[] = [];
	const states: any[] = [];
	const pending = runMockPiChild({
		cwd: process.cwd(), model: "test/model", task: "guard fixture", hardTimeoutMs: 0,
		maxOutputBytes: 65536, promptSourcePath: PROMPT, env: {}, buildArgs: () => ["--mode", "rpc"],
		execution: { tools: ["read", "bash"], finalizeAfterMs: 0, finalizationGraceMs: 1000, startupTimeoutMs: 1000 },
		spawnFn: (_command, argv, options) => { config = JSON.parse(options.env![GUARD_ENV]!); args = argv; return proc; },
		onControl: value => { control = value; }, onEvent: (event: any) => { if (event.type === "delegate_finalization") states.push(event.state); },
		...overrides,
	});
	t.after(async () => { proc.close(1); await pending; });
	const emit = (event: object) => proc.stdout!.write(encodeRpc(event as any));
	const guard = (event: string, phase = "running", activeTools = 0, fields: object = {}) => emit({ type: "extension_ui_request", method: "notify",
		message: JSON.stringify({ type: GUARD_NOTICE, version: 1, nonce: config.nonce, event,
			tools: config.tools, state: { phase, activeTools }, ...(event === "ready" && config.headroom ? {
				headroom: { policyId: headroomPolicyId(config.headroom), phase: "ready", limited: false },
			} : {}), ...fields }),
	});
	const answer = (text: string, fields: object = {}) => emit({ type: "message_end", message: {
		role: "assistant", provider: "test", model: "model", stopReason: "stop", content: [{ type: "text", text }], ...fields,
	} });
	return { proc, pending, args, config, states, emit, guard, answer, wrap: () => control.wrap(),
		ready: async () => {
			guard("ready");
			// Flush startup promises without yielding to unrelated deadline timers on busy CI hosts.
			for (let i = 0; i < 20 && !proc.stdinBytes.includes('"id":"p1"'); i++) await Promise.resolve();
			assert.ok(proc.stdinBytes.includes('"id":"p1"'));
			emit({ type: "message_end", message: { role: "user", content: "Task: guard fixture" } });
		},
		deliverWrap: () => emit({ type: "message_end", message: { role: "user", content: DEFAULT_WRAP_MESSAGE } }),
		settle: () => emit({ type: "agent_settled" }),
	};
}

test("guarded spawn loads only an explicit private guard in addition to caller args and withholds its task", async t => {
	const child = start(t);
	assert.ok(child.args.includes("--no-extensions"));
	assert.match(child.args[child.args.indexOf("--extension") + 1], /child-runtime\/guard\.ts$/);
	assert.equal(child.proc.stdinBytes, "");
	await child.ready(); assert.match(child.proc.stdinBytes, /"id":"p1"/);
	child.answer("Complete."); child.settle();
	const result = await child.pending;
	assert.equal(result.text, "Complete."); assert.equal(result.stopReason, "stop");
	assert.equal(result.finalization?.phase, "running");
});

test("wrap before guard readiness is retained and acknowledged before task dispatch", async t => {
	const child = start(t);
	assert.equal(child.wrap(), true); assert.equal(child.wrap(), true); assert.equal(child.proc.stdinBytes, "");
	child.guard("ready"); await tick();
	assert.match(child.proc.stdinBytes, /delegate-runtime-finalize/); assert.equal(child.proc.stdinBytes.includes('"id":"p1"'), false);
	child.guard("state", "answering"); await tick();
	assert.ok(child.proc.stdinBytes.indexOf('"id":"p1"') < child.proc.stdinBytes.indexOf('"type":"steer"'));
	assert.equal(child.proc.stdinBytes.match(/"type":"steer"/g)?.length, 1);
	child.deliverWrap(); child.answer("Stopped before investigation."); child.settle();
	const result = await child.pending;
	assert.equal(result.finalization?.phase, "answering"); assert.equal(result.finalization?.reason, "wrap");
	assert.match(result.text, /Stopped before investigation/);
});

test("wrap during the caller startup handshake is acknowledged before task dispatch", async t => {
	let release!: () => void; const handshake = new Promise<void>(resolve => { release = resolve; });
	const child = start(t, { beforePrompt: () => handshake });
	child.guard("ready"); await tick(); assert.equal(child.proc.stdinBytes.includes('"id":"p1"'), false);
	child.wrap(); release(); await tick();
	assert.equal(child.proc.stdinBytes.includes('"id":"p1"'), false);
	child.guard("state", "answering"); await tick();
	assert.equal(child.proc.stdinBytes.includes('"id":"p1"'), true);
	child.deliverWrap(); child.answer("Stopped before investigation."); child.settle();
	assert.equal((await child.pending).finalization?.phase, "answering");
});

test("manual finalization distinguishes request from acknowledgement and preserves the preceding report", async t => {
	const child = start(t); await child.ready(); child.answer("Original report.");
	child.wrap();
	assert.equal(child.states.at(-1).phase, "requested"); assert.equal(child.proc.stdinBytes.includes('"type":"steer"'), false);
	child.guard("state", "draining", 1); assert.equal(child.states.at(-1).phase, "draining");
	child.guard("state", "answering", 0); child.deliverWrap(); child.answer("Acknowledged."); child.settle();
	const result = await child.pending;
	assert.equal(isFailedChildResult(result), false);
	assert.match(result.text, /Original report\./); assert.match(result.text, /Wrap-up 1.*\nAcknowledged/s);
});

test("a missing guard refuses dispatch and releases a queued scheduler slot", async t => {
	const scheduler = new JobScheduler({ maxConcurrent: 1, maxLocalConcurrent: 1, maxQueued: 1 });
	t.after(() => scheduler.shutdown());
	const child = start(t, { execution: { tools: ["read"], finalizeAfterMs: 0, finalizationGraceMs: 100, startupTimeoutMs: 15 } });
	const base = { kind: "recon" as const, model: "test/model", local: true, task: "guard", timeoutMs: 1000 };
	const first = scheduler.enqueue({ ...base, run: () => child.pending });
	const second = scheduler.enqueue({ ...base, run: async () => ({ text: "Next.", exitCode: 0, stderrTail: "" }) });
	assert.equal(second.status, "queued");
	const failed = await scheduler.wait(first.id);
	assert.equal(failed.stopReason, "guard-error"); assert.equal(failed.status, "failed");
	assert.equal(child.proc.stdinBytes.includes('"id":"p1"'), false);
	assert.equal((await scheduler.wait(second.id)).answer, "Next.");
});

test("ignored finalization times out without losing available evidence before acknowledgement", async t => {
	const child = start(t, { maxOutputBytes: 220,
		execution: { tools: ["read"], finalizeAfterMs: 0, finalizationGraceMs: 20, startupTimeoutMs: 1000 } });
	await child.ready(); child.answer("Original report."); child.wrap();
	const result = await child.pending;
	assert.equal(result.stopReason, "finalization_timeout"); assert.equal(isFailedChildResult(result), true);
	assert.match(result.text, /^Child finalization grace expired/); assert.match(result.text, /Original report/);
	assert.ok(Buffer.byteLength(result.text) <= 220);
});

test("budget finalization reports budget exhaustion even when the child returns normally", async t => {
	const child = start(t, { execution: { tools: ["read"], finalizeAfterMs: 20, finalizationGraceMs: 1000, startupTimeoutMs: 1000 } });
	await child.ready(); child.answer("Existing findings.");
	await sleep(35); assert.equal(child.states.at(-1).reason, "execution_budget");
	child.guard("state", "answering"); child.deliverWrap(); child.answer("Final partial findings."); child.settle();
	const result = await child.pending;
	assert.equal(result.exitCode, 0); assert.equal(result.stopReason, "execution_budget"); assert.equal(isFailedChildResult(result), true);
	assert.match(result.text, /^Child execution budget exhausted/); assert.match(result.text, /Existing findings/); assert.match(result.text, /Final partial findings/);
});

test("a provider failure during budget finalization remains the primary error", async t => {
	const child = start(t, { execution: { tools: ["read"], finalizeAfterMs: 20, finalizationGraceMs: 1000, startupTimeoutMs: 1000 } });
	await child.ready(); child.answer("Existing findings."); await sleep(35);
	child.guard("state", "answering"); child.deliverWrap(); child.answer("", { stopReason: "error", errorMessage: "Provider unavailable" }); child.settle();
	const result = await child.pending;
	assert.equal(result.stopReason, "error"); assert.match(result.text, /^Provider unavailable/); assert.match(result.text, /Existing findings/);
});

for (const cause of ["hard_timeout", "aborted"] as const) {
	test(`${cause} after acknowledged wrap preserves partial evidence and wins over later controls`, async t => {
		const signal = new AbortController();
		const child = start(t, { signal: signal.signal, hardTimeoutMs: cause === "hard_timeout" ? 25 : 0 });
		await child.ready(); child.answer("Original report."); child.wrap(); child.guard("state", "draining", 1); child.deliverWrap();
		if (cause === "aborted") signal.abort();
		const result = await child.pending;
		assert.equal(result.stopReason, cause); assert.match(result.text, /Original report/); assert.equal(child.wrap(), false);
	});
}

test("pre-aborted guarded startup does not arm late timers or dispatch commands", async t => {
	const signal = new AbortController(); signal.abort();
	const child = start(t, { signal: signal.signal });
	assert.equal((await child.pending).stopReason, "aborted");
	assert.equal(child.proc.stdinBytes.includes('"id":"p1"'), false);
});

test("an unfinished final-answer stream is retained and labelled, alongside the completed report", async t => {
	const signal = new AbortController(); const child = start(t, { signal: signal.signal });
	await child.ready(); child.answer("Original report."); child.wrap(); child.guard("state", "answering"); child.deliverWrap();
	child.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	child.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "PRIVATE thinking" } });
	child.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Unfinished correction." } });
	signal.abort(); const result = await child.pending;
	assert.equal(result.stopReason, "aborted"); assert.match(result.text, /Original report/);
	assert.match(result.text, /incomplete streamed response.*\nUnfinished correction/s); assert.doesNotMatch(result.text, /PRIVATE/);
	assert.deepEqual(result.evidence, { source: "rpc", taskSent: true, agentSettled: false, finalizedMessages: 1,
		retainedResponses: 1, omittedPhases: 0, unansweredWrap: true, openResponse: true, partialResponseRetained: true });
});

test("an open stream without a delivered wrap retains the last finalized report", async t => {
	const child = start(t); await child.ready(); child.answer("Original report.");
	child.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	child.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Unfinished correction." } });
	child.proc.close(0); const result = await child.pending;
	assert.equal(result.stopReason, "incomplete-output"); assert.match(result.text, /Original report/);
	assert.match(result.text, /incomplete streamed response.*\nUnfinished correction/s);
});

for (const cause of ["aborted", "hard_timeout", "finalization_timeout"] as const) {
	test(`${cause} before wrap delivery preserves completed and unfinished responses`, async t => {
		const signal = new AbortController();
		const child = start(t, { signal: signal.signal, hardTimeoutMs: cause === "hard_timeout" ? 20 : 0,
			execution: { tools: ["read"], finalizeAfterMs: 0, finalizationGraceMs: cause === "finalization_timeout" ? 20 : 1000, startupTimeoutMs: 1000 } });
		await child.ready(); child.answer("Original report."); child.wrap(); child.guard("state", "answering");
		child.emit({ type: "message_start", message: { role: "assistant", content: [] } });
		child.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Unfinished correction." } });
		if (cause === "aborted") signal.abort();
		const result = await child.pending;
		assert.equal(result.stopReason, cause); assert.match(result.text, /Original report/); assert.match(result.text, /Unfinished correction/);
		assert.match(result.text, /incomplete streamed response/); assert.doesNotMatch(result.text, /Wrap-up 1/);
	});
}

test("an unfinished retry preserves the latest finalized provider error and its evidence", async t => {
	const child = start(t); await child.ready();
	child.answer("Prior partial findings.", { stopReason: "error", errorMessage: "Provider unavailable" });
	child.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	child.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Retry incomplete." } });
	child.proc.close(0); const result = await child.pending;
	assert.equal(result.stopReason, "error"); assert.match(result.text, /^Provider unavailable/);
	assert.match(result.text, /Prior partial findings/); assert.match(result.text, /Retry incomplete/);
});

for (const prior of [false, true]) {
	test(`an open thinking-only turn cannot look complete (prior report: ${prior})`, async t => {
		const child = start(t); await child.ready(); if (prior) child.answer("Original report.");
		child.emit({ type: "message_start", message: { role: "assistant", content: [] } });
		child.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "PRIVATE thinking" } });
		child.proc.close(0); const result = await child.pending;
		assert.equal(result.stopReason, "incomplete-output"); assert.equal(result.diag?.sawAssistant, true);
		assert.match(result.text, /incomplete streamed response/); assert.doesNotMatch(result.text, /PRIVATE/);
		assert.equal(result.evidence?.finalizedMessages, prior ? 1 : 0); assert.equal(result.evidence?.retainedResponses, prior ? 1 : 0);
		assert.equal(result.evidence?.openResponse, true); assert.equal(result.evidence?.partialResponseRetained, true);
		if (prior) assert.match(result.text, /Original report/);
	});
}

test("a stream retains its starting phase if a wrap echo arrives before message_end", async t => {
	const signal = new AbortController(); const child = start(t, { signal: signal.signal });
	await child.ready(); child.answer("Original report.");
	child.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	child.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "In-flight task response." } });
	child.wrap(); child.guard("state", "answering"); child.deliverWrap(); signal.abort();
	const result = await child.pending;
	assert.match(result.text, /Task response \(incomplete streamed response\):\nIn-flight task response/);
	assert.doesNotMatch(result.text, /Wrap-up 1 \(incomplete streamed response\)/);
	assert.match(result.text, /Wrap-up 1: \[No assistant message received\]/);
});

test("a zero exit with only an open stream is not mistaken for a complete answer", async t => {
	const child = start(t); await child.ready();
	child.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	child.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Incomplete text" } });
	child.proc.close(0); const result = await child.pending;
	assert.equal(result.stopReason, "incomplete-output"); assert.equal(isFailedChildResult(result), true);
	assert.match(result.text, /before its assistant response was finalized/); assert.match(result.text, /Incomplete text/);
});

test("deadline termination holds the scheduler slot until the child really closes", async t => {
	const child = start(t, { execution: { tools: ["read"], finalizeAfterMs: 0, finalizationGraceMs: 20, startupTimeoutMs: 1000 } });
	const close = child.proc.close; child.proc.close = () => {};
	const scheduler = new JobScheduler({ maxConcurrent: 1, maxLocalConcurrent: 1, maxQueued: 1 });
	const base = { kind: "recon" as const, model: "test/model", local: true, task: "hung child", timeoutMs: 1000 };
	const first = scheduler.enqueue({ ...base, run: () => child.pending });
	const second = scheduler.enqueue({ ...base, run: async () => ({ text: "Next", exitCode: 0, stderrTail: "" }) });
	try {
		await child.ready(); child.wrap(); child.guard("state", "draining", 1); await sleep(35);
		assert.deepEqual(child.proc.signals, ["SIGTERM"]);
		assert.equal(scheduler.get(first.id).status, "running"); assert.equal(scheduler.get(second.id).status, "queued");
		close(1);
		assert.equal((await scheduler.wait(first.id)).stopReason, "finalization_timeout");
		assert.equal((await scheduler.wait(second.id)).answer, "Next");
	} finally { child.proc.close = close; close(1); await child.pending; await scheduler.shutdown(); }
});

const headroom = { maxInputBytes: 65536, maxToolResultBytes: 512, maxToolBatchBytes: 768, reserveTokens: 4096 };
const contextExecution = { tools: ["read"], finalizeAfterMs: 0, finalizationGraceMs: 1000, startupTimeoutMs: 1000, headroom };

test("context-limited normal exit preserves preceding reports and exposes incomplete context", async t => {
	const child = start(t, { execution: contextExecution }); await child.ready(); child.answer("Original report.");
	child.guard("headroom", "running", 0, { headroom: { policyId: headroomPolicyId(headroom), phase: "limited", limited: true,
		inputBytes: 1000, inputLimitBytes: 2000, reservedTokens: 4096, clippedToolResults: 1 } });
	assert.equal(child.states.at(-1).phase, "requested"); assert.equal(child.states.at(-1).reason, "context_budget");
	child.guard("state", "answering"); child.deliverWrap(); child.answer("Final report."); child.settle();
	const result = await child.pending;
	assert.equal(result.stopReason, "context_budget"); assert.equal(isFailedChildResult(result), true);
	assert.match(result.text, /^Child context budget reached/); assert.match(result.text, /Original report/); assert.match(result.text, /Final report/);
	assert.equal(result.finalization?.headroom?.clippedToolResults, 1);
});

test("correlated context refusal preserves completed and open-stream evidence", async t => {
	const child = start(t, { execution: contextExecution }); await child.ready(); child.answer("Original report.");
	child.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	child.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Open partial." } });
	child.guard("headroom", "running", 0, { headroom: { policyId: headroomPolicyId(headroom), phase: "refused", limited: true, detail: "Non-tool context cannot fit." } });
	const result = await child.pending;
	assert.equal(result.stopReason, "context_budget"); assert.match(result.text, /Non-tool context cannot fit/);
	assert.match(result.text, /Original report/); assert.match(result.text, /Open partial/); assert.equal(result.finalization?.headroom?.phase, "refused");
});

for (const ready of [false, true]) {
	test(`context refusal exit-code fallback works without an RPC receipt (ready: ${ready})`, async t => {
		const child = start(t, { execution: contextExecution });
		if (ready) { await child.ready(); child.answer("Prior report."); }
		child.proc.close(HEADROOM_EXIT_CODE); const result = await child.pending;
		assert.equal(result.stopReason, "context_budget"); assert.equal(result.finalization?.headroom?.phase, "refusal-exit");
		assert.match(result.text, /RPC receipt was unavailable/); if (ready) assert.match(result.text, /Prior report/);
	});
}

test("stderr refusal latches the cause but drains preceding stdout reports before process closure", async t => {
	const signal = new AbortController();
	const child = start(t, { execution: contextExecution, signal: signal.signal }); await child.ready();
	const close = child.proc.close; child.proc.close = () => {};
	try {
		const line = `${HEADROOM_STDERR_PREFIX}${JSON.stringify({ nonce: child.config.nonce,
			headroom: { policyId: headroomPolicyId(headroom), phase: "refused", limited: true, detail: "Cannot fit." } })}\n`;
		child.proc.stderr!.write(line.slice(0, 15)); child.proc.stderr!.write(line.slice(15));
		// Different pipes can be read out of generation order. Neither the later abort nor a
		// later terminal notification may discard an earlier completed report still in stdout.
		signal.abort(); child.answer("Buffered preceding report.");
		close(HEADROOM_EXIT_CODE);
		const result = await child.pending;
		assert.equal(result.stopReason, "context_budget"); assert.equal(result.finalization?.headroom?.phase, "refused");
		assert.match(result.text, /Buffered preceding report/); assert.match(result.text, /Cannot fit/);
	} finally { child.proc.close = close; close(1); }
});

test("uncorrelated or oversized stderr diagnostics cannot assert a context refusal", async t => {
	const child = start(t, { execution: contextExecution }); await child.ready();
	child.proc.stderr!.write("x".repeat(5000) + "\n" + HEADROOM_STDERR_PREFIX + JSON.stringify({ nonce: "different-child-nonce",
		headroom: { policyId: headroomPolicyId(headroom), phase: "refused", limited: true } }) + "\n");
	child.answer("Normal report."); child.settle();
	assert.equal((await child.pending).stopReason, "stop");
});

test("an unconfigured reserved exit code does not claim context enforcement", async t => {
	const child = start(t); await child.ready(); child.answer("Report."); child.proc.close(HEADROOM_EXIT_CODE);
	const result = await child.pending; assert.notEqual(result.stopReason, "context_budget"); assert.equal(result.finalization?.headroom, undefined);
});

test("correlated guard command rejection fails immediately with its explanation", async t => {
	const child = start(t); await child.ready(); child.answer("Original report."); child.wrap();
	child.emit({ type: "response", id: GUARD_REQUEST_ID, command: "prompt", success: false, error: "guard command absent" });
	const result = await child.pending;
	assert.equal(result.stopReason, "guard-error"); assert.match(result.text, /guard command absent/); assert.match(result.text, /Original report/);
});
