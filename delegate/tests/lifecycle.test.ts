import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChildControl, ChildResult } from "../../child-runtime/spawn.ts";
import { JobScheduler, type JobRun } from "../jobs.ts";

const ok: ChildResult = { text: "collectible answer", exitCode: 0, stderrTail: "" };
const base = { kind: "recon" as const, model: "ollama/qwen3:8b", local: true, task: "test", timeoutMs: 1000 };

// Assert ownership directly rather than relying on nondeterministic garbage collection.
// A control callback closes over the subprocess, including uncapped assistant state.
function runtimeRefs(scheduler: JobScheduler, id: string) {
	const jobs = Reflect.get(scheduler, "jobs") as Array<{ id: string; run?: JobRun; control?: ChildControl }>;
	const job = jobs.find((item) => item.id === id);
	assert.ok(job);
	return job;
}

for (const outcome of ["success", "failure", "throw"] as const) {
	test(`terminal ${outcome} drops runtime closures but keeps collectible snapshots`, async () => {
		const scheduler = new JobScheduler({ maxConcurrent: 1, maxLocalConcurrent: 1, maxQueued: 1 });
		let lateControl: ((control: ChildControl) => void) | undefined;
		const job = scheduler.enqueue({
			...base,
			run: async (_handle, _signal, _onEvent, onControl) => {
				lateControl = onControl;
				onControl({ wrap: () => true });
				if (outcome === "throw") throw new Error("spawn failed");
				return outcome === "success" ? ok : { ...ok, exitCode: 1, stopReason: "error" };
			},
		});
		const done = await scheduler.wait(job.id);
		assert.equal(done.status, outcome === "success" ? "done" : "failed");
		assert.equal(runtimeRefs(scheduler, job.id).control, undefined);
		assert.equal(runtimeRefs(scheduler, job.id).run, undefined);
		assert.deepEqual(scheduler.get(job.id), done);
		assert.equal(done.answer, outcome === "throw" ? "spawn failed" : ok.text);
		lateControl?.({ wrap: () => true });
		assert.equal(runtimeRefs(scheduler, job.id).control, undefined, "late control cannot reattach after completion");
		await scheduler.shutdown();
	});
}

test("cancelled queued jobs release their runner without starting it", async () => {
	const scheduler = new JobScheduler({ maxConcurrent: 1, maxLocalConcurrent: 1, maxQueued: 1 });
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => { release = resolve; });
	scheduler.enqueue({ ...base, run: async () => { await blocked; return ok; } });
	let started = false;
	const queued = scheduler.enqueue({ ...base, run: async () => { started = true; return ok; } });
	assert.equal(queued.status, "queued");
	scheduler.cancel(queued.id);
	assert.equal(runtimeRefs(scheduler, queued.id).run, undefined);
	assert.equal(scheduler.get(queued.id).stopReason, "aborted");
	assert.equal(started, false);
	release();
	await scheduler.shutdown();
});

for (const action of ["cancel", "shutdown"] as const) {
	test(`${action} releases the running child's control and runner`, async () => {
		const scheduler = new JobScheduler({ maxConcurrent: 1, maxLocalConcurrent: 1, maxQueued: 1 });
		const job = scheduler.enqueue({
			...base,
			run: async (_handle, signal, _onEvent, onControl) => {
				onControl({ wrap: () => true });
				await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
				return { ...ok, exitCode: 1, stopReason: "aborted" };
			},
		});
		assert.ok(runtimeRefs(scheduler, job.id).control);
		if (action === "cancel") scheduler.cancel(job.id);
		else await scheduler.shutdown();
		const done = await scheduler.wait(job.id);
		assert.equal(done.status, "failed");
		assert.equal(runtimeRefs(scheduler, job.id).control, undefined);
		assert.equal(runtimeRefs(scheduler, job.id).run, undefined);
		await scheduler.shutdown();
	});
}
