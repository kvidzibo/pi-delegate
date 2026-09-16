import assert from "node:assert/strict";
import { test } from "node:test";
import { JobScheduler, type JobRun } from "../jobs.ts";
import type { ChildControl, ChildResult } from "../../child-runtime/spawn.ts";

const base = { kind: "recon" as const, model: "test/model", local: true, task: "fixture", timeoutMs: 1000 };
const ok: ChildResult = { text: "Available evidence.", exitCode: 0, stderrTail: "", stopReason: "stop" };

function setup() {
	const scheduler = new JobScheduler({ maxConcurrent: 1, maxLocalConcurrent: 1, maxQueued: 1 });
	let resolve!: (value: ChildResult) => void;
	let control!: (ctl: ChildControl) => void;
	let emit!: (event: unknown) => void;
	const run: JobRun = (_handle, _signal, onEvent, onControl) => { emit = onEvent; control = onControl; return new Promise(done => { resolve = done; }); };
	const job = scheduler.enqueue({ ...base, run });
	return { scheduler, job, control: (ctl: ChildControl) => control(ctl), emit: (event: unknown) => emit(event), finish: (value = ok) => resolve(value) };
}

test("wrap before control readiness is retained; accepted repeated wraps are idempotent", async t => {
	const { scheduler, job, control, finish } = setup();
	t.after(async () => { finish(); await scheduler.shutdown(); });
	const sent: string[] = [];
	scheduler.wrap(job.id, "first"); scheduler.wrap(job.id, "second");
	control({ wrap: message => { sent.push(message!); return true; } });
	assert.deepEqual(sent, ["first"]);
	scheduler.wrap(job.id, "third"); assert.deepEqual(sent, ["first"]);
	finish(); await scheduler.wait(job.id);
	control({ wrap: () => { assert.fail("late controls must not be called"); } });
});

test("reentrant wrap observers cannot dispatch a second control while acceptance is in progress", async t => {
	const { scheduler, job, control, finish } = setup();
	t.after(async () => { finish(); await scheduler.shutdown(); });
	let calls = 0;
	control({ wrap: () => { if (++calls === 1) scheduler.wrap(job.id); return true; } });
	scheduler.wrap(job.id); assert.equal(calls, 1);
});

test("refused early controls can be delivered when a later ready control arrives", async t => {
	const { scheduler, job, control, finish } = setup();
	t.after(async () => { finish(); await scheduler.shutdown(); });
	control({ wrap: () => false }); scheduler.wrap(job.id, "first");
	let sent = ""; control({ wrap: message => { sent = message!; return true; } });
	assert.equal(sent, "first");
});

test("guard progress snapshots distinguish requested and enforced finalization and are not mutable aliases", async t => {
	const { scheduler, job, emit, finish } = setup();
	t.after(async () => { finish(); await scheduler.shutdown(); });
	emit({ type: "delegate_finalization", state: { phase: "requested", reason: "wrap" } });
	assert.equal(scheduler.get(job.id).finalization?.phase, "requested");
	emit({ type: "delegate_finalization", state: { phase: "draining", reason: "wrap", activeTools: 1 } });
	const snapshot = scheduler.get(job.id); assert.equal(snapshot.finalization?.phase, "draining");
	snapshot.finalization!.phase = "running";
	assert.equal(scheduler.get(job.id).finalization?.phase, "draining");
	emit({ type: "delegate_finalization", state: { phase: "invented", activeTools: -1 } });
	assert.equal(scheduler.get(job.id).finalization?.phase, "draining");
	finish({ ...ok, finalization: { phase: "answering", reason: "wrap", activeTools: 0 } });
	assert.equal((await scheduler.wait(job.id)).finalization?.phase, "answering");
});

test("scheduler preserves detached context receipts and classifies a zero-exit context limit as failed", async t => {
	const { scheduler, job, emit, finish } = setup();
	t.after(async () => { finish(); await scheduler.shutdown(); });
	const finalization = { phase: "requested" as const, reason: "context_budget" as const,
		headroom: { policyId: "a".repeat(64), phase: "limited" as const, limited: true, clippedToolResults: 1 } };
	emit({ type: "delegate_finalization", state: finalization });
	finalization.headroom.clippedToolResults = 99;
	const snapshot = scheduler.get(job.id); assert.equal(snapshot.finalization?.headroom?.clippedToolResults, 1);
	snapshot.finalization!.headroom!.clippedToolResults = 88;
	assert.equal(scheduler.get(job.id).finalization?.headroom?.clippedToolResults, 1);
	finish({ ...ok, stopReason: "context_budget", finalization: { ...snapshot.finalization!, headroom: { ...snapshot.finalization!.headroom!, clippedToolResults: 1 } } });
	const result = await scheduler.wait(job.id); assert.equal(result.status, "failed"); assert.equal(result.answer, ok.text);
	assert.equal(result.finalization?.headroom?.clippedToolResults, 1);
});

for (const action of ["cancel", "shutdown"] as const) {
	test(`${action} cannot reattach late control or dispatch another wrap`, async t => {
		const { scheduler, job, control, finish } = setup();
		t.after(async () => { finish(); await scheduler.shutdown(); });
		const shutdown = action === "shutdown" ? scheduler.shutdown() : undefined;
		if (action === "cancel") scheduler.cancel(job.id);
		control({ wrap: () => { assert.fail("cancelled jobs cannot regain control"); } });
		scheduler.wrap(job.id); finish({ ...ok, stopReason: "aborted" });
		const result = await scheduler.wait(job.id);
		assert.equal(result.status, "failed"); assert.equal(result.stopReason, "aborted"); assert.equal(result.answer, ok.text);
		await shutdown;
	});
}

test("a completed child outcome must not be rewritten by cancellation during archival awaits", async t => {
	// The native runner has closed; only its asynchronous post-processing is outstanding.
	// Cancellation classification belongs to that runner, not its scheduler's later return time.
	const { scheduler, job, finish } = setup();
	t.after(async () => { finish(); await scheduler.shutdown(); });
	scheduler.cancel(job.id); finish({ ...ok, diag: { command: "pi", args: [], hardTimeoutMs: 0,
		durationMs: 1, eventCount: 1, events: ["agent_settled"], sawAssistant: true } });
	assert.equal((await scheduler.wait(job.id)).status, "done");
});

test("a runtime-reported earlier failure retains precedence over a later cancellation", async t => {
	const { scheduler, job, finish } = setup();
	t.after(async () => { finish(); await scheduler.shutdown(); });
	scheduler.cancel(job.id); finish({ ...ok, stopReason: "guard-error" });
	assert.equal((await scheduler.wait(job.id)).stopReason, "guard-error");
});
