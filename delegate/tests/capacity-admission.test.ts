import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { JobScheduler } from "../jobs.ts";
import type { CapacityBroker } from "../capacity.ts";
import type { LocalAdmission } from "../local-control.ts";

const group = { key: "admission-fixture", capacity: 1 };
const local = { kind: "recon" as const, model: "local-qwen38/fixture", local: true, resourceGroup: group, task: "fixture", timeoutMs: 1000 };
const ok = { text: "Evidence.", exitCode: 0, stderrTail: "", stopReason: "stop" };
function fixture(t: TestContext, admission: LocalAdmission, releaseFails = false) {
	let held = false, acquisitions = 0, releases = 0;
	const capacity: CapacityBroker = { tryAcquire: () => {
		if (held) return;
		held = true; acquisitions++;
		return { claim: { ...group, slot: 0 }, inherited: { fd: 999, dev: "1", ino: "1" }, release: () => {
			releases++; if (releaseFails) throw new Error("uncertain capacity close"); held = false;
		} };
	} };
	const scheduler = new JobScheduler({ maxConcurrent: 2, maxLocalConcurrent: 1, maxQueued: 2,
		capacity, localAdmission: admission, resourcePollMs: 60000 });
	t.after(() => scheduler.shutdown());
	return { scheduler, capacity, held: () => held, acquisitions: () => acquisitions, releases: () => releases };
}

for (const mode of ["deny", "throw", "malformed"] as const) {
	test(`local ${mode} releases provisional shared capacity before leaving a waiter`, async t => {
		const f = fixture(t, { enabled: () => true, acquire: () => {
			if (mode === "throw") throw new Error("admission unavailable");
			return mode === "malformed" ? 42 as unknown as () => void : undefined;
		} });
		const job = f.scheduler.enqueue({ ...local, run: async () => { assert.fail("unadmitted worker ran"); } });
		assert.equal(job.status, "queued"); assert.equal(job.resource?.state, "waiting");
		assert.equal(f.held(), false); assert.equal(f.releases(), 1);
		if (mode !== "deny") {
			assert.equal(job.reason, "local-unavailable");
			assert.match(job.recordingError!, mode === "throw" ? /admission unavailable/ : /Invalid local admission reservation/);
		}
		const other = f.capacity.tryAcquire(group); assert.ok(other, "another parent must not be blocked by a paused job"); other.release();
		const cloud = f.scheduler.enqueue({ ...local, local: false, model: "hosted/fixture", run: async () => ok });
		assert.equal((await f.scheduler.wait(cloud.id)).status, "done");
		f.scheduler.cancel(job.id);
	});
}

for (const action of ["cancel", "shutdown"] as const) {
	test(`reentrant ${action} during local admission cannot resurrect work or leak either ownership`, async t => {
		let scheduler!: JobScheduler, localReleases = 0, starts = 0;
		const f = fixture(t, { enabled: () => true, acquire: () => {
			if (action === "cancel") scheduler.cancel("d0001"); else void scheduler.shutdown();
			return () => { localReleases++; };
		} });
		scheduler = f.scheduler;
		const job = scheduler.enqueue({ ...local, run: async () => { starts++; return ok; } });
		assert.equal((await scheduler.wait(job.id)).stopReason, "aborted");
		assert.equal(starts, 0); assert.equal(localReleases, 1); assert.equal(f.releases(), 1); assert.equal(f.held(), false);
	});
}

test("uncertain provisional capacity release fails closed rather than retrying a lease leak", async t => {
	const f = fixture(t, { enabled: () => true, acquire: () => undefined }, true);
	const job = f.scheduler.enqueue({ ...local, run: async () => { assert.fail("unadmitted worker ran"); } });
	assert.equal(job.status, "failed"); assert.equal(job.stopReason, "resource-error");
	assert.equal(job.resource?.state, "release-unknown"); assert.match(job.resourceError!, /uncertain capacity close/);
	assert.equal(f.releases(), 1); assert.equal(Reflect.get(f.scheduler, "resourceTimer"), undefined);
	f.scheduler.refreshLocalState(); assert.equal(f.acquisitions(), 1); assert.equal(f.releases(), 1);
});

test("OFF after capacity acquisition releases the provisional descriptor without local admission", t => {
	let enabled = true, released = 0, admitted = 0;
	const scheduler = new JobScheduler({ maxConcurrent: 1, maxLocalConcurrent: 1, maxQueued: 1,
		localAdmission: { enabled: () => enabled, acquire: () => { admitted++; return () => {}; } },
		capacity: { tryAcquire: () => { enabled = false; return { claim: { ...group, slot: 0 }, inherited: { fd: 999, dev: "1", ino: "1" }, release: () => { released++; } }; } },
	});
	t.after(() => scheduler.shutdown());
	const job = scheduler.enqueue({ ...local, run: async () => { assert.fail("OFF worker ran"); } });
	assert.equal(job.status, "queued"); assert.equal(job.reason, "local-off"); assert.equal(admitted, 0); assert.equal(released, 1);
	assert.equal(Reflect.get(scheduler, "resourceTimer"), undefined);
});

test("failed rollback before retaining the capacity grant is explicit and not retried", t => {
	let enabled = true, releases = 0, attempts = 0;
	const scheduler = new JobScheduler({ maxConcurrent: 1, maxLocalConcurrent: 1, maxQueued: 1,
		localAdmission: { enabled: () => enabled, acquire: () => { assert.fail("OFF admission attempted"); } },
		capacity: { tryAcquire: () => {
			attempts++; enabled = false;
			return { claim: { ...group, slot: 0 }, inherited: { fd: 999, dev: "1", ino: "1" }, release: () => { releases++; throw new Error("rollback failed"); } };
		} },
	});
	t.after(() => scheduler.shutdown());
	const job = scheduler.enqueue({ ...local, run: async () => { assert.fail("OFF worker ran"); } });
	assert.equal(job.status, "failed"); assert.equal(job.stopReason, "resource-error");
	assert.equal(job.resource?.state, "release-unknown"); assert.match(job.resourceError!, /rollback failed/);
	enabled = true; scheduler.refreshLocalState();
	assert.equal(attempts, 1); assert.equal(releases, 1);
});

test("capacity waiters do not reserve local activity and rejected excess waiters retain no lease", t => {
	let admissions = 0;
	const f = fixture(t, { enabled: () => true, acquire: () => { admissions++; return undefined; } });
	const external = f.capacity.tryAcquire(group)!;
	const first = f.scheduler.enqueue({ ...local, run: async () => { assert.fail("unadmitted worker ran"); } });
	assert.equal(admissions, 0); assert.equal(first.reason, "resource");
	external.release(); f.scheduler.refreshLocalState();
	assert.equal(admissions, 1); assert.equal(f.held(), false);
	f.scheduler.enqueue({ ...local, run: async () => { assert.fail("unadmitted worker ran"); } });
	assert.throws(() => f.scheduler.enqueue({ ...local, run: async () => ok }), /already queued/);
	assert.equal(f.scheduler.active().length, 2); assert.equal(f.held(), false);
	assert.equal(f.acquisitions(), f.releases());
});

test("admitted cancellation holds both reservations until runner closure", async t => {
	let finish!: () => void, localReleases = 0;
	const closing = new Promise<void>(resolve => { finish = resolve; });
	t.after(() => finish());
	const f = fixture(t, { enabled: () => true, acquire: () => () => { localReleases++; } });
	const job = f.scheduler.enqueue({ ...local, run: async (_handle, signal) => { await closing; return { ...ok, stopReason: signal.aborted ? "aborted" : "stop" }; } });
	f.scheduler.cancel(job.id);
	assert.equal(f.scheduler.get(job.id).status, "running"); assert.equal(f.held(), true); assert.equal(localReleases, 0);
	finish(); assert.equal((await f.scheduler.wait(job.id)).stopReason, "aborted");
	assert.equal(f.held(), false); assert.equal(f.releases(), 1); assert.equal(localReleases, 1);
});

test("both release warnings survive without changing a completed report", async t => {
	const f = fixture(t, { enabled: () => true, acquire: () => () => { throw new Error("uncertain local release"); } }, true);
	const job = f.scheduler.enqueue({ ...local, run: async () => ok });
	const done = await f.scheduler.wait(job.id);
	assert.equal(done.status, "done"); assert.equal(done.answer, ok.text);
	assert.match(done.resourceError!, /uncertain capacity close/); assert.match(done.recordingError!, /activity cleanup failed/);
});
