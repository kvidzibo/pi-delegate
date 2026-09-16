import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { FileCapacityBroker, type CapacityBroker, type ResourceLease } from "../capacity.ts";
import { JobScheduler, type JobHandle, type JobRun, type SchedulerLimits } from "../jobs.ts";
import { readLeaseIdentity } from "../../child-runtime/lease.ts";

const group = { key: "same-local-server", capacity: 1 };
const local = { kind: "recon" as const, model: "local-qwen38/model-a", local: true, resourceGroup: group, task: "fixture", timeoutMs: 1000 };
const hosted = { ...local, model: "hosted/model", local: false };
const ok = { text: "Evidence.", exitCode: 0, stderrTail: "", stopReason: "stop" };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const linux = { skip: process.platform !== "linux" };
async function until(fn: () => boolean) {
	for (let i = 0; i < 300; i++) { if (fn()) return; await sleep(10); }
	throw new Error("Capacity scheduler condition timed out");
}

function fixture(t: TestContext) {
	const root = mkdtempSync("/tmp/pi-delegate-capacity-jobs-");
	const schedulers: JobScheduler[] = [], releases: Array<() => void> = [];
	t.after(async () => { for (const release of releases) release(); await Promise.all(schedulers.map(s => s.shutdown())); rmSync(root, { recursive: true, force: true }); });
	return {
		scheduler: (limits: Partial<SchedulerLimits> = {}, capacity: CapacityBroker = new FileCapacityBroker(root)) => {
			const scheduler = new JobScheduler({ maxConcurrent: 4, maxLocalConcurrent: 1, maxQueued: 4, ...limits, capacity, resourcePollMs: 10 });
			schedulers.push(scheduler); return scheduler;
		},
		hold: () => { const lease = new FileCapacityBroker(root).tryAcquire(group)!; assert.ok(lease); releases.push(() => lease.release()); return lease; },
		gate: () => {
			let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); releases.push(() => release());
			const starts: JobHandle[] = [];
			const run: JobRun = async (handle, signal) => {
				starts.push(handle); await held;
				return signal.aborted ? { ...ok, exitCode: 1, stopReason: "aborted" } : ok;
			};
			return { run, release, starts };
		},
	};
}
const refs = (scheduler: JobScheduler, id: string): any => Reflect.get(scheduler, "jobs").find((job: any) => job.id === id);

test("two schedulers share one resource despite different model IDs; waiting is not execution", linux, async t => {
	const f = fixture(t), a = f.scheduler(), b = f.scheduler(), first = f.gate(), second = f.gate();
	const one = a.enqueue({ ...local, run: first.run });
	const two = b.enqueue({ ...local, model: "ollama/different-model", run: second.run });
	assert.equal(one.status, "running"); assert.equal(two.status, "queued"); assert.equal(two.reason, "resource");
	assert.equal(second.starts.length, 0); assert.equal(refs(b, two.id).startedAt, undefined);
	assert.ok(first.starts[0].resourceLease); assert.doesNotThrow(() => readLeaseIdentity(first.starts[0].resourceLease!.fd));
	const peek = await b.wait(two.id, { timeoutMs: 15 }); assert.equal(peek.status, "queued");
	first.release(); await a.wait(one.id); await until(() => second.starts.length === 1);
	second.release(); assert.equal((await b.wait(two.id)).status, "done");
	assert.equal(a.get(one.id).resource?.state, "released"); assert.equal(refs(a, one.id).lease, undefined);
	assert.equal(Reflect.get(b, "resourceTimer"), undefined);
});

test("cancelled running jobs retain leases until their runners really close", linux, async t => {
	const f = fixture(t), a = f.scheduler(), b = f.scheduler(), first = f.gate(), second = f.gate();
	const one = a.enqueue({ ...local, run: first.run }), two = b.enqueue({ ...local, run: second.run });
	a.cancel(one.id); await sleep(35);
	assert.equal(a.get(one.id).status, "running"); assert.equal(b.get(two.id).status, "queued"); assert.equal(second.starts.length, 0);
	first.release(); assert.equal((await a.wait(one.id)).stopReason, "aborted");
	await until(() => second.starts.length === 1); second.release(); await b.wait(two.id);
});

test("hosted work and an independent resource bypass a busy local resource", linux, async t => {
	const f = fixture(t), external = f.hold(), scheduler = f.scheduler({ maxLocalConcurrent: 2 });
	const queued = scheduler.enqueue({ ...local, run: async () => ok });
	assert.equal(queued.reason, "resource");
	let hostedLease: unknown = "not called";
	const cloud = scheduler.enqueue({ ...hosted, run: async handle => { hostedLease = handle.resourceLease; return ok; } });
	assert.equal((await scheduler.wait(cloud.id)).status, "done"); assert.equal(hostedLease, undefined);
	const other = scheduler.enqueue({ ...local, resourceGroup: { key: "different-server", capacity: 1 }, run: async () => ok });
	assert.equal((await scheduler.wait(other.id)).status, "done"); assert.equal(scheduler.get(queued.id).status, "queued");
	scheduler.cancel(queued.id); external.release();
});

test("a conflicting capacity cannot hide indefinitely behind a busy waiter in the same group", linux, async t => {
	const f = fixture(t), external = f.hold(), scheduler = f.scheduler();
	const waiting = scheduler.enqueue({ ...local, run: async () => ok });
	const conflict = scheduler.enqueue({ ...local, resourceGroup: { ...group, capacity: 2 }, run: async () => { assert.fail("conflicting capacity started"); } });
	assert.equal(waiting.reason, "resource"); assert.equal(conflict.stopReason, "resource-error");
	scheduler.cancel(waiting.id); external.release();
});

test("parent-local limits still apply when shared resource capacity is larger", linux, async t => {
	const f = fixture(t), scheduler = f.scheduler(), first = f.gate(), second = f.gate();
	const resourceGroup = { ...group, capacity: 2 };
	const one = scheduler.enqueue({ ...local, resourceGroup, run: first.run });
	const two = scheduler.enqueue({ ...local, resourceGroup, run: second.run });
	assert.equal(two.reason, "gpu"); assert.equal(second.starts.length, 0);
	first.release(); await scheduler.wait(one.id); await until(() => second.starts.length === 1);
	second.release(); await scheduler.wait(two.id);
});

test("shared-resource queue obeys maxQueued and preserves acceptance order", linux, async t => {
	const f = fixture(t), external = f.hold(), scheduler = f.scheduler({ maxQueued: 2 });
	const started: string[] = [];
	const first = scheduler.enqueue({ ...local, task: "first", run: async () => { started.push("first"); return ok; } });
	const second = scheduler.enqueue({ ...local, task: "second", run: async () => { started.push("second"); return ok; } });
	assert.throws(() => scheduler.enqueue({ ...local, run: async () => { assert.fail("refused runner started"); } }), /already queued/);
	assert.equal(scheduler.list().length, 2);
	external.release(); await scheduler.wait(first.id); await scheduler.wait(second.id);
	assert.deepEqual(started, ["first", "second"]);
	const noQueue = f.scheduler({ maxQueued: 0 }); const held = f.hold();
	assert.throws(() => noQueue.enqueue({ ...local, run: async () => ok }), /already queued/);
	assert.equal(noQueue.list().length, 0); assert.equal(Reflect.get(noQueue, "resourceTimer"), undefined);
	held.release(); assert.equal((await noQueue.wait(noQueue.enqueue({ ...local, run: async () => ok }).id)).status, "done");
});

for (const action of ["cancel", "wrap", "shutdown"] as const) {
	test(`${action} removes an external-resource waiter without spawning or touching its holder`, linux, async t => {
		const f = fixture(t), external = f.hold(), scheduler = f.scheduler();
		const job = scheduler.enqueue({ ...local, run: async () => { assert.fail("queued runner started"); } });
		if (action === "shutdown") await scheduler.shutdown(); else scheduler[action](job.id);
		assert.equal((await scheduler.wait(job.id)).stopReason, "aborted"); assert.equal(refs(scheduler, job.id).run, undefined);
		assert.equal(Reflect.get(scheduler, "resourceTimer"), undefined); assert.doesNotThrow(() => readLeaseIdentity(external.inherited.fd));
	});
}

test("resource acquisition failure is explicit and cannot block unrelated hosted work", linux, async t => {
	const f = fixture(t); let fail = false;
	const scheduler = f.scheduler({}, { tryAcquire: () => { if (fail) throw new Error("coordination unavailable"); return; } });
	const localJob = scheduler.enqueue({ ...local, run: async () => { assert.fail("uncoordinated launch"); } });
	fail = true; const failed = await scheduler.wait(localJob.id);
	assert.equal(failed.status, "failed"); assert.equal(failed.stopReason, "resource-error"); assert.match(failed.answer!, /coordination unavailable/);
	assert.equal(failed.resource?.state, "not-acquired"); assert.equal(Reflect.get(scheduler, "resourceTimer"), undefined);
	const cloud = scheduler.enqueue({ ...hosted, run: async () => ok }); assert.equal((await scheduler.wait(cloud.id)).status, "done");
});

function fakeLease(release: () => void, patch: object = {}): ResourceLease {
	return { claim: { ...group, slot: 0, ...patch }, inherited: { fd: 999, dev: "1", ino: "1" }, release };
}

for (const outcome of ["success", "failure", "throw"] as const) {
	test(`terminal ${outcome} releases its lease exactly once`, linux, async t => {
		const f = fixture(t); let releases = 0;
		const scheduler = f.scheduler({}, { tryAcquire: () => fakeLease(() => { releases++; }) });
		const job = scheduler.enqueue({ ...local, run: async () => { if (outcome === "throw") throw new Error("spawn failure"); return outcome === "failure" ? { ...ok, exitCode: 1 } : ok; } });
		await scheduler.wait(job.id); await scheduler.wait(job.id); await scheduler.shutdown();
		assert.equal(releases, 1); assert.equal(refs(scheduler, job.id).lease, undefined);
		assert.equal(scheduler.get(job.id).resource?.state, "released");
	});
}

test("release failure stays visible without hiding the child outcome or stranding terminal callbacks", linux, async t => {
	const f = fixture(t), scheduler = f.scheduler({}, { tryAcquire: () => fakeLease(() => { throw new Error("close failed"); }) });
	const job = scheduler.enqueue({ ...local, run: async () => ok }); const done = await scheduler.wait(job.id);
	assert.equal(done.status, "done"); assert.equal(done.answer, ok.text); assert.equal(done.resource?.state, "release-unknown");
	assert.match(done.resourceError!, /close failed/); assert.equal(refs(scheduler, job.id).run, undefined);
});

test("a reentrant cancellation before acquisition returns cannot start work or leak the lease", linux, async t => {
	const f = fixture(t); let scheduler!: JobScheduler, releases = 0;
	scheduler = f.scheduler({}, { tryAcquire: () => { scheduler.cancel("d0001"); return fakeLease(() => { releases++; }); } });
	const job = scheduler.enqueue({ ...local, run: async () => { assert.fail("cancelled runner started"); } });
	assert.equal(job.status, "failed"); assert.equal(job.stopReason, "aborted"); assert.equal(releases, 1);
	assert.equal(job.resource?.state, "not-acquired"); assert.equal(refs(scheduler, job.id).lease, undefined);
});

test("a malformed broker claim cannot leak the acquired lease during validation", linux, async t => {
	const f = fixture(t); let releases = 0;
	const scheduler = f.scheduler({}, { tryAcquire: () => ({ ...fakeLease(() => { releases++; }),
		get claim(): never { throw new Error("broken claim"); },
	}) });
	const job = scheduler.enqueue({ ...local, run: async () => { assert.fail("malformed claim used"); } });
	assert.equal(job.stopReason, "resource-error"); assert.equal(releases, 1);
});

test("broker callbacks cannot mutate the job's resource specification", linux, async t => {
	const f = fixture(t); let releases = 0;
	const scheduler = f.scheduler({}, { tryAcquire: requested => {
		requested.capacity = 2;
		return fakeLease(() => { releases++; }, { capacity: requested.capacity });
	} });
	const job = scheduler.enqueue({ ...local, run: async () => { assert.fail("mutated specification used"); } });
	assert.equal(job.stopReason, "resource-error"); assert.equal(job.resource?.capacity, 1); assert.equal(releases, 1);
});

test("a mismatched broker claim is released and refused rather than used for another group", linux, async t => {
	const f = fixture(t); let releases = 0;
	const scheduler = f.scheduler({}, { tryAcquire: () => fakeLease(() => { releases++; }, { key: "wrong-resource" }) });
	const result = scheduler.enqueue({ ...local, run: async () => { assert.fail("wrong resource used"); } });
	assert.equal(result.stopReason, "resource-error"); assert.match(result.answer!, /mismatched resource claim/); assert.equal(releases, 1);
});

test("resource configuration cannot silently fall back to uncoordinated local execution", linux, async t => {
	const f = fixture(t), scheduler = f.scheduler();
	assert.throws(() => scheduler.enqueue({ ...local, resourceGroup: undefined, run: async () => ok }), /explicit key/);
	const plain = new JobScheduler({ maxConcurrent: 1, maxLocalConcurrent: 1, maxQueued: 1 });
	try { assert.throws(() => plain.enqueue({ ...local, run: async () => ok }), /requires a capacity broker/); }
	finally { await plain.shutdown(); }
});
