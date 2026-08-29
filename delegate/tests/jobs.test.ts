import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChildResult } from "../../child-runtime/spawn.ts";
import { parseDelegateCall, JobScheduler, type JobRun } from "../jobs.ts";

const limits = { maxConcurrent: 4, maxLocalConcurrent: 1, maxQueued: 16 };
const ok: ChildResult = { text: "ok", exitCode: 0, stderrTail: "" };
const callConfig = { maxTaskChars: 20000, defaultTimeoutMs: 300000, maxTimeoutMs: 900000 };

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(fn: () => boolean, ms = 500): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < ms) {
		if (fn()) return;
		await sleep(5);
	}
	throw new Error("waitUntil timeout");
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function runOk(delay = 15): JobRun {
	return async (_job, signal) => {
		await Promise.race([
			sleep(delay),
			new Promise<void>((_, reject) => {
				if (signal.aborted) {
					reject(new Error("aborted"));
					return;
				}
				signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			}),
		]);
		if (signal.aborted) return { text: "", exitCode: 1, stderrTail: "", stopReason: "aborted" };
		return ok;
	};
}

test("parse spawn and collect modes", () => {
	const fg = parseDelegateCall({ kind: "recon", task: "map files" }, callConfig);
	assert.equal(fg.mode, "spawn");
	if (fg.mode !== "spawn") return;
	assert.equal(fg.background, false);
	assert.equal(fg.kind, "recon");
	assert.equal(fg.timeoutMs, 300000);

	const bg = parseDelegateCall({ kind: "implement", task: "edit", background: true, timeoutMs: 5000 }, callConfig);
	assert.equal(bg.mode, "spawn");
	if (bg.mode !== "spawn") return;
	assert.equal(bg.background, true);
	assert.equal(bg.timeoutMs, 5000);

	const peek = parseDelegateCall({ jobId: "d0001", timeoutMs: 0 }, callConfig);
	assert.deepEqual(peek, { mode: "collect", jobId: "d0001", peek: true, waitMs: 0 });

	const wait = parseDelegateCall({ jobId: "d0002" }, callConfig);
	assert.deepEqual(wait, { mode: "collect", jobId: "d0002", peek: false });

	assert.throws(
		() => parseDelegateCall({ jobId: "d0001", background: true }, callConfig),
		/cannot combine/,
	);
	assert.throws(() => parseDelegateCall({ kind: "recon" }, callConfig), /task is required/);
});

test("ten local jobs never overlap with maxLocalConcurrent 1", async () => {
	let current = 0;
	let maxSeen = 0;
	const scheduler = new JobScheduler(limits);
	const run: JobRun = async () => {
		current += 1;
		maxSeen = Math.max(maxSeen, current);
		await sleep(20);
		current -= 1;
		return ok;
	};
	const ids: string[] = [];
	for (let i = 0; i < 10; i++) {
		ids.push(
			scheduler.enqueue({
				kind: "recon",
				model: "local-qwen38/qwen38-q4km",
				local: true,
				task: `t${i}`,
				timeoutMs: 5000,
				run,
			}).id,
		);
	}
	assert.equal(scheduler.active().filter((job) => job.status === "running").length, 1);
	assert.equal(scheduler.active().filter((job) => job.status === "queued").length, 9);
	assert.ok(scheduler.active().some((job) => job.reason === "gpu"));
	await Promise.all(ids.map((id) => scheduler.wait(id)));
	assert.equal(maxSeen, 1);
	assert.equal(scheduler.active().length, 0);
});

test("hosted is not blocked by local gpu queue", async () => {
	const localGate = deferred();
	const hostedStarted = deferred();
	const scheduler = new JobScheduler({ ...limits, maxConcurrent: 3 });
	scheduler.enqueue({
		kind: "recon",
		model: "local-qwen38/qwen38-q4km",
		local: true,
		task: "local",
		timeoutMs: 5000,
		run: async () => {
			await localGate.promise;
			return ok;
		},
	});
	await waitUntil(() => scheduler.list().some((job) => job.local && job.status === "running"));
	scheduler.enqueue({
		kind: "recon",
		model: "local-qwen38/qwen38-q4km",
		local: true,
		task: "local-2",
		timeoutMs: 5000,
		run: runOk(10),
	});
	const hosted = scheduler.enqueue({
		kind: "implement",
		model: "openai-codex/gpt-5.6-luna",
		local: false,
		task: "hosted",
		timeoutMs: 5000,
		run: async () => {
			hostedStarted.resolve();
			await sleep(10);
			return ok;
		},
	});
	await hostedStarted.promise;
	const snap = scheduler.get(hosted.id);
	assert.equal(snap.status, "running");
	assert.equal(scheduler.list().filter((job) => job.status === "queued" && job.local)[0]?.reason, "gpu");
	localGate.resolve();
	await scheduler.wait(hosted.id);
	await scheduler.shutdown();
});

test("child run starts only after slot; timeout is not queue time", async () => {
	const starts: number[] = [];
	const gate = deferred();
	const scheduler = new JobScheduler(limits);
	scheduler.enqueue({
		kind: "recon",
		model: "local-qwen38/qwen38-q4km",
		local: true,
		task: "first",
		timeoutMs: 5000,
		run: async () => {
			starts.push(Date.now());
			await gate.promise;
			return ok;
		},
	});
	await waitUntil(() => starts.length === 1);
	const queuedAt = Date.now();
	const second = scheduler.enqueue({
		kind: "recon",
		model: "local-qwen38/qwen38-q4km",
		local: true,
		task: "second",
		timeoutMs: 5000,
		run: async () => {
			starts.push(Date.now());
			return ok;
		},
	});
	assert.equal(scheduler.get(second.id).status, "queued");
	await sleep(40);
	assert.equal(starts.length, 1);
	gate.resolve();
	await scheduler.wait(second.id);
	assert.equal(starts.length, 2);
	assert.ok(starts[1]! - queuedAt >= 30);
});

test("peek does not wait; wait timeout leaves job running", async () => {
	const gate = deferred();
	const scheduler = new JobScheduler(limits);
	const job = scheduler.enqueue({
		kind: "recon",
		model: "local-qwen38/qwen38-q4km",
		local: true,
		task: "hold",
		timeoutMs: 5000,
		run: async () => {
			await gate.promise;
			return ok;
		},
	});
	await waitUntil(() => scheduler.get(job.id).status === "running");
	const peeked = await scheduler.wait(job.id, { timeoutMs: 0 });
	assert.equal(peeked.status, "running");
	const timed = await scheduler.wait(job.id, { timeoutMs: 20 });
	assert.equal(timed.status, "running");
	gate.resolve();
	const done = await scheduler.wait(job.id);
	assert.equal(done.status, "done");
	assert.equal(done.answer, "ok");
});

test("maxQueued refuses extra waiting jobs", async () => {
	const scheduler = new JobScheduler({ maxConcurrent: 1, maxLocalConcurrent: 1, maxQueued: 2 });
	const gate = deferred();
	const run: JobRun = async () => {
		await gate.promise;
		return ok;
	};
	scheduler.enqueue({
		kind: "recon",
		model: "local-qwen38/qwen38-q4km",
		local: true,
		task: "run",
		timeoutMs: 5000,
		run,
	});
	scheduler.enqueue({
		kind: "recon",
		model: "local-qwen38/qwen38-q4km",
		local: true,
		task: "q1",
		timeoutMs: 5000,
		run,
	});
	scheduler.enqueue({
		kind: "recon",
		model: "local-qwen38/qwen38-q4km",
		local: true,
		task: "q2",
		timeoutMs: 5000,
		run,
	});
	assert.throws(
		() =>
			scheduler.enqueue({
				kind: "recon",
				model: "local-qwen38/qwen38-q4km",
				local: true,
				task: "q3",
				timeoutMs: 5000,
				run,
			}),
		/already queued/,
	);
	gate.resolve();
	await scheduler.shutdown();
});

test("shutdown drops queue and aborts running", async () => {
	const scheduler = new JobScheduler(limits);
	const gate = deferred();
	let aborted = false;
	scheduler.enqueue({
		kind: "recon",
		model: "local-qwen38/qwen38-q4km",
		local: true,
		task: "run",
		timeoutMs: 5000,
		run: async (_job, signal) => {
			await Promise.race([
				gate.promise,
				new Promise<void>((resolve) => {
					signal.addEventListener("abort", () => {
						aborted = true;
						resolve();
					});
				}),
			]);
			return { text: "", exitCode: 1, stderrTail: "", stopReason: "aborted" };
		},
	});
	await waitUntil(() => scheduler.list()[0]?.status === "running");
	const queued = scheduler.enqueue({
		kind: "recon",
		model: "local-qwen38/qwen38-q4km",
		local: true,
		task: "wait",
		timeoutMs: 5000,
		run: runOk(),
	});
	await scheduler.shutdown();
	assert.equal(aborted, true);
	assert.equal(scheduler.get(queued.id).status, "failed");
	assert.equal(scheduler.get(queued.id).stopReason, "aborted");
	assert.throws(
		() =>
			scheduler.enqueue({
				kind: "recon",
				model: "local-qwen38/qwen38-q4km",
				local: true,
				task: "late",
				timeoutMs: 5000,
				run: runOk(),
			}),
		/shutdown/,
	);
});

test("fg abort cancels queued job", async () => {
	const scheduler = new JobScheduler(limits);
	const gate = deferred();
	scheduler.enqueue({
		kind: "recon",
		model: "local-qwen38/qwen38-q4km",
		local: true,
		task: "hold",
		timeoutMs: 5000,
		run: async () => {
			await gate.promise;
			return ok;
		},
	});
	const ac = new AbortController();
	const queued = scheduler.enqueue({
		kind: "recon",
		model: "local-qwen38/qwen38-q4km",
		local: true,
		task: "fg",
		timeoutMs: 5000,
		run: runOk(),
		cancelOnAbort: ac.signal,
	});
	assert.equal(queued.status, "queued");
	ac.abort();
	await waitUntil(() => scheduler.get(queued.id).status === "failed");
	assert.equal(scheduler.get(queued.id).stopReason, "aborted");
	gate.resolve();
	await scheduler.shutdown();
});

test("collect wait abort does not kill a background job", async () => {
	const gate = deferred();
	const scheduler = new JobScheduler(limits);
	const job = scheduler.enqueue({
		kind: "recon",
		model: "local-qwen38/qwen38-q4km",
		local: true,
		task: "bg",
		timeoutMs: 5000,
		run: async () => {
			await gate.promise;
			return ok;
		},
	});
	await waitUntil(() => scheduler.get(job.id).status === "running");

	const already = new AbortController();
	already.abort();
	const peeked = await scheduler.wait(job.id, { signal: already.signal });
	assert.equal(peeked.status, "running");

	const ac = new AbortController();
	const waiting = scheduler.wait(job.id, { signal: ac.signal });
	ac.abort();
	assert.equal((await waiting).status, "running");
	assert.equal(scheduler.get(job.id).status, "running");

	gate.resolve();
	const done = await scheduler.wait(job.id);
	assert.equal(done.status, "done");
	await scheduler.shutdown();
});

test("fg abort kills a running local job; bg has no cancelOnAbort", async () => {
	const scheduler = new JobScheduler(limits);
	const ac = new AbortController();
	let sawAbort = false;
	const fg = scheduler.enqueue({
		kind: "recon",
		model: "local-qwen38/qwen38-q4km",
		local: true,
		task: "fg-run",
		timeoutMs: 5000,
		cancelOnAbort: ac.signal,
		run: async (_job, signal) => {
			await new Promise<void>((resolve) => {
				signal.addEventListener("abort", () => {
					sawAbort = true;
					resolve();
				});
			});
			return { text: "", exitCode: 1, stderrTail: "", stopReason: "aborted" };
		},
	});
	await waitUntil(() => scheduler.get(fg.id).status === "running");
	ac.abort();
	await waitUntil(() => scheduler.get(fg.id).status === "failed");
	assert.equal(sawAbort, true);
	assert.equal(scheduler.get(fg.id).stopReason, "aborted");
	await scheduler.shutdown();
});

test("fg plus bg local never overlap", async () => {
	let current = 0;
	let maxSeen = 0;
	const scheduler = new JobScheduler(limits);
	const run: JobRun = async (_job, signal) => {
		current += 1;
		maxSeen = Math.max(maxSeen, current);
		await Promise.race([
			sleep(20),
			new Promise<void>((resolve) => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			}),
		]);
		current -= 1;
		return ok;
	};
	const fg = scheduler.enqueue({
		kind: "recon",
		model: "local-qwen38/qwen38-q4km",
		local: true,
		task: "fg",
		timeoutMs: 5000,
		run,
		cancelOnAbort: new AbortController().signal,
	});
	const bg = scheduler.enqueue({
		kind: "recon",
		model: "local-qwen38/qwen38-q4km",
		local: true,
		task: "bg",
		timeoutMs: 5000,
		run,
	});
	await Promise.all([scheduler.wait(fg.id), scheduler.wait(bg.id)]);
	assert.equal(maxSeen, 1);
	await scheduler.shutdown();
});

test("onTerminal fires once after done, not on shutdown abort", async () => {
	const terminals: string[] = [];
	const scheduler = new JobScheduler({
		...limits,
		onTerminal: (snap) => terminals.push(`${snap.id}:${snap.status}:${snap.background}`),
	});
	const done = scheduler.enqueue({
		kind: "recon",
		model: "local-qwen38/qwen38-q4km",
		local: true,
		task: "ok",
		timeoutMs: 5000,
		background: true,
		run: runOk(10),
	});
	assert.equal(done.background, true);
	await scheduler.wait(done.id);
	assert.deepEqual(terminals, [`${done.id}:done:true`]);

	const blocked = new JobScheduler({
		...limits,
		onTerminal: (snap) => terminals.push(`shut:${snap.id}`),
	});
	const gate = deferred();
	blocked.enqueue({
		kind: "recon",
		model: "local-qwen38/qwen38-q4km",
		local: true,
		task: "run",
		timeoutMs: 5000,
		background: true,
		run: async (_job, signal) => {
			await Promise.race([
				gate.promise,
				new Promise<void>((resolve) => {
					signal.addEventListener("abort", () => resolve(), { once: true });
				}),
			]);
			return { text: "", exitCode: 1, stderrTail: "", stopReason: "aborted" };
		},
	});
	await waitUntil(() => blocked.list()[0]?.status === "running");
	blocked.enqueue({
		kind: "recon",
		model: "local-qwen38/qwen38-q4km",
		local: true,
		task: "queued",
		timeoutMs: 5000,
		background: true,
		run: runOk(),
	});
	const before = terminals.length;
	await blocked.shutdown();
	assert.equal(terminals.length, before);
	await scheduler.shutdown();
});

test("onTerminal throw still starts the next eligible job", async () => {
	let calls = 0;
	const hostedStarted = deferred();
	const localGate = deferred();
	const scheduler = new JobScheduler({
		maxConcurrent: 1,
		maxLocalConcurrent: 1,
		maxQueued: 16,
		onTerminal: () => {
			calls += 1;
			throw new Error("notify boom");
		},
	});
	scheduler.enqueue({
		kind: "recon",
		model: "local-qwen38/qwen38-q4km",
		local: true,
		task: "local",
		timeoutMs: 5000,
		background: true,
		run: async () => {
			await localGate.promise;
			return ok;
		},
	});
	await waitUntil(() => scheduler.list().some((job) => job.status === "running"));
	const hosted = scheduler.enqueue({
		kind: "implement",
		model: "openai-codex/gpt-5.6-luna",
		local: false,
		task: "hosted",
		timeoutMs: 5000,
		background: true,
		run: async () => {
			hostedStarted.resolve();
			return ok;
		},
	});
	assert.equal(scheduler.get(hosted.id).status, "queued");
	localGate.resolve();
	await hostedStarted.promise;
	assert.equal(scheduler.get(hosted.id).status === "running" || scheduler.get(hosted.id).status === "done", true);
	await scheduler.wait(hosted.id);
	assert.ok(calls >= 1);
	await scheduler.shutdown();
});

test("onChange throw still starts the next eligible job", async () => {
	let paints = 0;
	const hostedStarted = deferred();
	const localGate = deferred();
	const scheduler = new JobScheduler({
		...limits,
		maxConcurrent: 3,
		onChange: () => {
			paints += 1;
			if (paints === 1) throw new Error("widget boom");
		},
	});
	scheduler.enqueue({
		kind: "recon",
		model: "local-qwen38/qwen38-q4km",
		local: true,
		task: "local",
		timeoutMs: 5000,
		run: async () => {
			await localGate.promise;
			return ok;
		},
	});
	await waitUntil(() => scheduler.list().some((job) => job.status === "running"));
	const hosted = scheduler.enqueue({
		kind: "implement",
		model: "openai-codex/gpt-5.6-luna",
		local: false,
		task: "hosted",
		timeoutMs: 5000,
		run: async () => {
			hostedStarted.resolve();
			return ok;
		},
	});
	await hostedStarted.promise;
	assert.equal(scheduler.get(hosted.id).status === "running" || scheduler.get(hosted.id).status === "done", true);
	localGate.resolve();
	await scheduler.shutdown();
});
