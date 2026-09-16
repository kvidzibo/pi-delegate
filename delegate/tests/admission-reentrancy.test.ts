import assert from "node:assert/strict";
import { test } from "node:test";
import { JobScheduler } from "../jobs.ts";

const local = { kind: "recon" as const, model: "local-qwen38/fixture", local: true, task: "fixture", timeoutMs: 1000 };
const ok = { text: "Evidence.", exitCode: 0, stderrTail: "", stopReason: "stop" };
for (const action of ["cancel", "shutdown", "cancel-release-error"] as const) {
	test(`local admission ${action} cannot resurrect a stopped job`, async t => {
		let scheduler!: JobScheduler, releases = 0, starts = 0;
		scheduler = new JobScheduler({ maxConcurrent: 1, maxLocalConcurrent: 1, maxQueued: 1,
			localAdmission: { enabled: () => true, acquire: () => {
				if (action === "shutdown") void scheduler.shutdown(); else scheduler.cancel("d0001");
				return () => { releases++; if (action === "cancel-release-error") throw new Error("uncertain reservation"); };
			} },
		});
		t.after(() => scheduler.shutdown());
		const job = scheduler.enqueue({ ...local, run: async () => { starts++; return ok; } });
		const done = await scheduler.wait(job.id);
		assert.equal(done.stopReason, "aborted"); assert.equal(done.status, "failed");
		assert.equal(releases, 1); assert.equal(starts, 0);
		if (action === "cancel-release-error") assert.match(done.recordingError!, /activity cleanup failed/);
	});
}

test("malformed local admission cannot authorize a runner", async t => {
	let starts = 0;
	const scheduler = new JobScheduler({ maxConcurrent: 1, maxLocalConcurrent: 1, maxQueued: 1,
		localAdmission: { enabled: () => true, acquire: () => 42 as unknown as () => void },
	});
	t.after(() => scheduler.shutdown());
	const job = scheduler.enqueue({ ...local, run: async () => { starts++; return ok; } });
	assert.equal(job.status, "queued"); assert.equal(job.reason, "local-unavailable");
	assert.match(job.recordingError!, /Invalid local admission reservation/); assert.equal(starts, 0);
});
