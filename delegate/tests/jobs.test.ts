import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChildResult } from "../../child-runtime/spawn.ts";
import { parseDelegateCall, JobScheduler, type EnqueueInput, type JobRun } from "../jobs.ts";

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

function enq(
	input: Pick<EnqueueInput, "task" | "run"> & Partial<Omit<EnqueueInput, "task" | "run">>,
): EnqueueInput {
	return {
		kind: "recon",
		model: "local-qwen38/qwen38-q4km",
		local: true,
		timeoutMs: 5000,
		...input,
	};
}

function hosted(input: Pick<EnqueueInput, "task" | "run"> & Partial<Omit<EnqueueInput, "task" | "run">>): EnqueueInput {
	return enq({
		kind: "implement",
		model: "openai-codex/gpt-5.6-luna",
		local: false,
		...input,
	});
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

	const wrap = parseDelegateCall({ jobId: "d0003", wrap: true }, callConfig);
	assert.deepEqual(wrap, { mode: "collect", jobId: "d0003", peek: false, wrap: true });

	const cancel = parseDelegateCall({ jobId: "d0004", cancel: true }, callConfig);
	assert.deepEqual(cancel, { mode: "collect", jobId: "d0004", peek: false, cancel: true });

	const cancelPeek = parseDelegateCall({ jobId: "d0005", cancel: true, timeoutMs: 0 }, callConfig);
	assert.deepEqual(cancelPeek, { mode: "collect", jobId: "d0005", peek: true, waitMs: 0, cancel: true });

	const cancelWait = parseDelegateCall({ jobId: "d0006", cancel: true, timeoutMs: 50 }, callConfig);
	assert.deepEqual(cancelWait, { mode: "collect", jobId: "d0006", peek: false, waitMs: 50, cancel: true });

	assert.throws(
		() => parseDelegateCall({ jobId: "d0001", background: true }, callConfig),
		/cannot combine/,
	);
	assert.throws(
		() => parseDelegateCall({ jobId: "d0001", wrap: true, cancel: true }, callConfig),
		/wrap cannot combine/,
	);
	assert.throws(() => parseDelegateCall({ wrap: true }, callConfig), /wrap\/cancel require jobId/);
	assert.throws(
		() => parseDelegateCall({ jobId: "d0001", cancel: true, timeoutMs: -1 }, callConfig),
		/timeoutMs must be an integer/,
	);
	assert.throws(
		() => parseDelegateCall({ jobId: "d0001", task: "nope" }, callConfig),
		/spawn fields/,
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
		ids.push(scheduler.enqueue(enq({ task: `t${i}`, run })).id);
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
	scheduler.enqueue(
		enq({
			task: "local",
			run: async () => {
				await localGate.promise;
				return ok;
			},
		}),
	);
	await waitUntil(() => scheduler.list().some((job) => job.local && job.status === "running"));
	scheduler.enqueue(enq({ task: "local-2", run: runOk(10) }));
	const hostedJob = scheduler.enqueue(
		hosted({
			task: "hosted",
			run: async () => {
				hostedStarted.resolve();
				await sleep(10);
				return ok;
			},
		}),
	);
	await hostedStarted.promise;
	const snap = scheduler.get(hostedJob.id);
	assert.equal(snap.status, "running");
	assert.equal(scheduler.list().filter((job) => job.status === "queued" && job.local)[0]?.reason, "gpu");
	localGate.resolve();
	await scheduler.wait(hostedJob.id);
	await scheduler.shutdown();
});

test("child run starts only after slot; timeout is not queue time", async () => {
	const starts: number[] = [];
	const gate = deferred();
	const scheduler = new JobScheduler(limits);
	scheduler.enqueue(
		enq({
			task: "first",
			run: async () => {
				starts.push(Date.now());
				await gate.promise;
				return ok;
			},
		}),
	);
	await waitUntil(() => starts.length === 1);
	const queuedAt = Date.now();
	const second = scheduler.enqueue(
		enq({
			task: "second",
			run: async () => {
				starts.push(Date.now());
				return ok;
			},
		}),
	);
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
	const job = scheduler.enqueue(
		enq({
			task: "hold",
			run: async () => {
				await gate.promise;
				return ok;
			},
		}),
	);
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
	scheduler.enqueue(enq({ task: "run", run }));
	scheduler.enqueue(enq({ task: "q1", run }));
	scheduler.enqueue(enq({ task: "q2", run }));
	assert.throws(() => scheduler.enqueue(enq({ task: "q3", run })), /already queued/);
	gate.resolve();
	await scheduler.shutdown();
});

test("shutdown drops queue and aborts running", async () => {
	const scheduler = new JobScheduler(limits);
	const gate = deferred();
	let aborted = false;
	scheduler.enqueue(
		enq({
			task: "run",
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
		}),
	);
	await waitUntil(() => scheduler.list()[0]?.status === "running");
	const queued = scheduler.enqueue(enq({ task: "wait", run: runOk() }));
	await scheduler.shutdown();
	assert.equal(aborted, true);
	assert.equal(scheduler.get(queued.id).status, "failed");
	assert.equal(scheduler.get(queued.id).stopReason, "aborted");
	assert.throws(() => scheduler.enqueue(enq({ task: "late", run: runOk() })), /shutdown/);
});

test("fg abort cancels queued job", async () => {
	const scheduler = new JobScheduler(limits);
	const gate = deferred();
	scheduler.enqueue(
		enq({
			task: "hold",
			run: async () => {
				await gate.promise;
				return ok;
			},
		}),
	);
	const ac = new AbortController();
	const queued = scheduler.enqueue(enq({ task: "fg", run: runOk(), cancelOnAbort: ac.signal }));
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
	const job = scheduler.enqueue(
		enq({
			task: "bg",
			run: async () => {
				await gate.promise;
				return ok;
			},
		}),
	);
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
	const fg = scheduler.enqueue(
		enq({
			task: "fg-run",
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
		}),
	);
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
	const fg = scheduler.enqueue(enq({ task: "fg", run, cancelOnAbort: new AbortController().signal }));
	const bg = scheduler.enqueue(enq({ task: "bg", run }));
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
	const done = scheduler.enqueue(enq({ task: "ok", background: true, run: runOk(10) }));
	assert.equal(done.background, true);
	await scheduler.wait(done.id);
	assert.deepEqual(terminals, [`${done.id}:done:true`]);

	const blocked = new JobScheduler({
		...limits,
		onTerminal: (snap) => terminals.push(`shut:${snap.id}`),
	});
	const gate = deferred();
	blocked.enqueue(
		enq({
			task: "run",
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
		}),
	);
	await waitUntil(() => blocked.list()[0]?.status === "running");
	blocked.enqueue(enq({ task: "queued", background: true, run: runOk() }));
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
	scheduler.enqueue(
		enq({
			task: "local",
			background: true,
			run: async () => {
				await localGate.promise;
				return ok;
			},
		}),
	);
	await waitUntil(() => scheduler.list().some((job) => job.status === "running"));
	const hostedJob = scheduler.enqueue(
		hosted({
			task: "hosted",
			background: true,
			run: async () => {
				hostedStarted.resolve();
				return ok;
			},
		}),
	);
	assert.equal(scheduler.get(hostedJob.id).status, "queued");
	localGate.resolve();
	await hostedStarted.promise;
	assert.equal(scheduler.get(hostedJob.id).status === "running" || scheduler.get(hostedJob.id).status === "done", true);
	await scheduler.wait(hostedJob.id);
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
	scheduler.enqueue(
		enq({
			task: "local",
			run: async () => {
				await localGate.promise;
				return ok;
			},
		}),
	);
	await waitUntil(() => scheduler.list().some((job) => job.status === "running"));
	const hostedJob = scheduler.enqueue(
		hosted({
			task: "hosted",
			run: async () => {
				hostedStarted.resolve();
				return ok;
			},
		}),
	);
	await hostedStarted.promise;
	assert.equal(scheduler.get(hostedJob.id).status === "running" || scheduler.get(hostedJob.id).status === "done", true);
	localGate.resolve();
	await scheduler.shutdown();
});

test("quiet wait returns running; events postpone quiet", async () => {
	const gate = deferred();
	const scheduler = new JobScheduler(limits);
	let onEvent: ((event: unknown) => void) | undefined;
	const job = scheduler.enqueue(
		enq({
			task: "hold",
			run: async (_handle, _signal, emit) => {
				onEvent = emit;
				await gate.promise;
				return ok;
			},
		}),
	);
	await waitUntil(() => scheduler.get(job.id).status === "running" && Boolean(onEvent));
	const quiet = await scheduler.wait(job.id, { quietMs: 25 });
	assert.equal(quiet.status, "running");
	onEvent?.({ type: "tool_execution_start", toolName: "read", args: { path: "a.ts" } });
	const started = Date.now();
	const again = await scheduler.wait(job.id, { quietMs: 40 });
	assert.equal(again.status, "running");
	assert.ok(Date.now() - started >= 25);
	gate.resolve();
	await scheduler.wait(job.id);
	await scheduler.shutdown();
});

test("fg wait budget includes queue time", async () => {
	const gate = deferred();
	const scheduler = new JobScheduler(limits);
	scheduler.enqueue(
		enq({
			task: "hold",
			run: async () => {
				await gate.promise;
				return ok;
			},
		}),
	);
	const second = scheduler.enqueue(enq({ task: "queued", run: runOk() }));
	assert.equal(second.status, "queued");
	const timed = await scheduler.wait(second.id, { timeoutMs: 30 });
	assert.equal(timed.status, "queued");
	gate.resolve();
	await scheduler.shutdown();
});

test("wrap steers running job; queued wrap cancels", async () => {
	const gate = deferred();
	const scheduler = new JobScheduler(limits);
	let wrapped: string | undefined;
	let ready = false;
	const running = scheduler.enqueue(
		enq({
			task: "run",
			run: async (_job, _signal, _onEvent, onControl) => {
				onControl({
					wrap: (message) => {
						wrapped = message;
						return true;
					},
				});
				ready = true;
				await gate.promise;
				return ok;
			},
		}),
	);
	await waitUntil(() => ready);
	const queued = scheduler.enqueue(enq({ task: "later", run: runOk() }));
	const steered = scheduler.wrap(running.id, "wrap now");
	assert.equal(steered.wrapped, true);
	assert.equal(steered.status, "running");
	assert.equal(wrapped, "wrap now");
	const cancelled = scheduler.wrap(queued.id);
	assert.equal(cancelled.status, "failed");
	assert.equal(cancelled.stopReason, "aborted");
	gate.resolve();
	await scheduler.wait(running.id);
	await scheduler.shutdown();
});

test("quiet wait returns queued job without waiting forever", async () => {
	const gate = deferred();
	const scheduler = new JobScheduler(limits);
	scheduler.enqueue(
		enq({
			task: "hold",
			run: async () => {
				await gate.promise;
				return ok;
			},
		}),
	);
	const queued = scheduler.enqueue(enq({ task: "later", run: runOk() }));
	assert.equal(queued.status, "queued");
	assert.ok((queued.quietForMs ?? -1) >= 0);
	const timed = await scheduler.wait(queued.id, { quietMs: 25 });
	assert.equal(timed.status, "queued");
	assert.equal(timed.reason, "gpu");
	gate.resolve();
	await scheduler.shutdown();
});

test("promoteBackground detaches fg abort", async () => {
	const scheduler = new JobScheduler(limits);
	const ac = new AbortController();
	const gate = deferred();
	let sawAbort = false;
	const job = scheduler.enqueue(
		enq({
			task: "fg",
			cancelOnAbort: ac.signal,
			run: async (_job, signal) => {
				signal.addEventListener("abort", () => {
					sawAbort = true;
				});
				await gate.promise;
				return ok;
			},
		}),
	);
	await waitUntil(() => scheduler.get(job.id).status === "running");
	const bg = scheduler.promoteBackground(job.id);
	assert.equal(bg.background, true);
	ac.abort();
	await sleep(20);
	assert.equal(sawAbort, false);
	assert.equal(scheduler.get(job.id).status, "running");
	gate.resolve();
	await scheduler.wait(job.id);
	await scheduler.shutdown();
});
