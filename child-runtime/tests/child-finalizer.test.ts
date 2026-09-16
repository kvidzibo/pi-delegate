import assert from "node:assert/strict";
import { test } from "node:test";
import { ChildFinalizer, type FinalizerClock } from "../child-finalizer.ts";
import { GUARD_NOTICE, GUARD_REQUEST_ID, validateGuardedExecution, type GuardedExecution } from "../guard-protocol.ts";

class Clock implements FinalizerClock {
	now = 0;
	private next = 0;
	jobs = new Map<number, { at: number; fn: () => void }>();
	set = (fn: () => void, ms: number) => { const id = ++this.next; this.jobs.set(id, { at: this.now + ms, fn }); return id; };
	clear = (id: unknown) => { this.jobs.delete(id as number); };
	advance(ms: number) {
		const until = this.now + ms;
		while (true) {
			const next = [...this.jobs.entries()].filter(([, job]) => job.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
			if (!next) break;
			this.now = next[1].at; this.jobs.delete(next[0]); next[1].fn();
		}
		this.now = until;
	}
}
const nonce = "fixture-guard-1234";
const policy: GuardedExecution = { tools: ["read", "bash"], finalizeAfterMs: 0, finalizationGraceMs: 100, startupTimeoutMs: 50 };
const notice = (event = "ready", phase = "running", activeTools = 0, fields: object = {}) => ({
	type: "extension_ui_request", method: "notify", message: JSON.stringify({ type: GUARD_NOTICE, nonce, version: 1,
		event, tools: policy.tools, state: { phase, activeTools }, ...fields }),
});
function start(overrides: Partial<GuardedExecution> = {}, writes = true) {
	const clock = new Clock(), sent: any[] = [], steers: string[] = [], failures: any[] = [], states: any[] = [];
	const child = new ChildFinalizer({ ...policy, ...overrides }, nonce, {
		send: command => { sent.push(command); return writes; }, steer: text => { steers.push(text); return writes; },
		fail: (reason, text) => failures.push({ reason, text }), onState: state => states.push(state),
	}, clock);
	child.start("Finish now.");
	return { child, clock, sent, steers, failures, states };
}

test("readiness is required; RPC success is not enforcement acknowledgement", async () => {
	const { child, sent, steers, clock } = start();
	const ready = child.waitReady(new AbortController().signal);
	child.accept(notice()); await ready;
	child.markTaskSent(); child.request("Finish now.");
	assert.equal(sent.length, 1); assert.equal(steers.length, 0);
	child.accept({ type: "response", id: GUARD_REQUEST_ID, command: "prompt", success: true });
	assert.equal(child.snapshot().phase, "requested"); assert.equal(steers.length, 0);
	child.accept(notice("state", "draining", 2));
	assert.deepEqual(child.snapshot(), { phase: "draining", activeTools: 2, reason: "wrap" });
	assert.deepEqual(steers, ["Finish now."]);
	child.accept(notice("state", "answering", 0));
	child.dispose(); assert.equal(clock.jobs.size, 0);
});

test("early/repeated wrap waits for readiness and enforcement, and sends steering only after the task", async () => {
	const { child, sent, steers, failures, clock } = start();
	const ready = child.waitReady(new AbortController().signal);
	child.request("First request."); child.request("Ignored second request.");
	assert.equal(sent.length, 0);
	child.accept(notice());
	assert.equal(sent.length, 1);
	let prepared = false; void ready.then(() => { prepared = true; });
	await Promise.resolve(); assert.equal(prepared, false);
	child.accept(notice("state", "answering", 0)); await ready;
	assert.equal(steers.length, 0);
	child.markTaskSent(); assert.deepEqual(steers, ["First request."]);
	clock.advance(90); child.request("Must not extend grace."); clock.advance(10);
	assert.equal(failures.length, 1); assert.equal(failures[0].reason, "finalization_timeout");
	assert.equal(clock.jobs.size, 0);
});

test("execution budget begins at runtime start and is separate from finalization grace", () => {
	const { child, sent, failures, clock } = start({ finalizeAfterMs: 80 });
	child.accept(notice()); child.markTaskSent();
	clock.advance(79); assert.equal(sent.length, 0);
	clock.advance(1); assert.equal(sent.length, 1); assert.equal(child.snapshot().reason, "execution_budget");
	child.accept(notice("state", "answering", 0));
	clock.advance(99); assert.equal(failures.length, 0);
	clock.advance(1); assert.equal(failures[0].reason, "finalization_timeout");
});

test("settled work cannot be wrapped by the soft timer; an already-finalizing process still must exit", () => {
	const normal = start({ finalizeAfterMs: 80 });
	normal.child.accept(notice()); normal.child.settled(); normal.clock.advance(90);
	assert.equal(normal.sent.length, 0); assert.equal(normal.failures.length, 0);
	normal.clock.advance(10); assert.match(normal.failures[0].text, /shutdown grace/); normal.child.dispose();
	const wrapping = start();
	wrapping.child.accept(notice()); wrapping.child.request("finish"); wrapping.child.settled(); wrapping.clock.advance(100);
	assert.equal(wrapping.failures[0].reason, "finalization_timeout");
});

test("wrong nonce never unlocks startup; mismatched version/tool set fails closed", async () => {
	const wrongNonce = start();
	const pending = wrongNonce.child.waitReady(new AbortController().signal);
	wrongNonce.child.accept(notice("ready", "running", 0, { nonce: "wrong-nonce-1234" }));
	wrongNonce.clock.advance(50); await assert.rejects(pending, /startup stopped/);
	assert.equal(wrongNonce.failures[0].reason, "guard-error");
	for (const fields of [{ version: 2 }, { tools: ["read"] }, { tools: ["read", "read"] }]) {
		const invalid = start(); invalid.child.accept(notice("ready", "running", 0, fields));
		assert.equal(invalid.failures.length, 1); assert.equal(invalid.clock.jobs.size, 0);
	}
});

test("guard state cannot precede readiness, reopen, or admit more tools after acknowledgement", () => {
	const early = start(); early.child.accept(notice("state", "answering")); assert.equal(early.failures.length, 1);
	for (const [phase, count] of [["running", 0], ["draining", 2], ["answering", 1]] as const) {
		const bad = start(); bad.child.accept(notice()); bad.child.request("finish");
		bad.child.accept(notice("state", "draining", 1));
		bad.child.accept(notice("state", phase, count));
		assert.equal(bad.failures.length, 1); assert.equal(bad.failures[0].reason, "guard-error");
	}
});

test("failed control writes and correlated rejection fail promptly; unrelated responses do not", () => {
	const write = start({}, false); write.child.accept(notice()); write.child.request("finish");
	assert.equal(write.failures[0].reason, "guard-error");
	const reject = start(); reject.child.accept(notice()); reject.child.request("finish");
	reject.child.accept({ type: "response", id: "other", success: false }); assert.equal(reject.failures.length, 0);
	reject.child.accept({ type: "response", id: GUARD_REQUEST_ID, success: false, error: "missing command" });
	assert.match(reject.failures[0].text, /missing command/);
});

test("dispose aborts readiness waiters, releases timers and ignores late controls/events", async () => {
	const { child, clock, sent } = start({ finalizeAfterMs: 80 });
	const ready = child.waitReady(new AbortController().signal);
	child.dispose(); await assert.rejects(ready, /startup stopped/);
	child.start("finish"); child.settled(); child.accept(notice()); assert.equal(child.request("finish"), false);
	assert.equal(sent.length, 0); assert.equal(clock.jobs.size, 0);
});

test("guarded runtime policy validates timers and tools without selecting agent defaults", () => {
	assert.deepEqual(validateGuardedExecution(policy), policy);
	for (const bad of [null, [], ["custom"], ["read", "read"]]) {
		assert.throws(() => validateGuardedExecution({ ...policy, tools: bad as any }), /builtin tool list/);
	}
	for (const key of ["finalizeAfterMs", "finalizationGraceMs", "startupTimeoutMs"] as const) {
		for (const value of [-1, 0.5, NaN, Infinity, 2 ** 31]) {
			assert.throws(() => validateGuardedExecution({ ...policy, [key]: value }), /timer duration/);
		}
	}
	assert.throws(() => validateGuardedExecution({ ...policy, startupTimeoutMs: 0 }), /timer duration/);
	assert.throws(() => validateGuardedExecution({ ...policy, finalizationGraceMs: 0 }), /timer duration/);
});
