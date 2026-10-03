import type { HistoricalCase } from "./cases.ts";

export const hardCases: HistoricalCase[] = [
	{
		id: "queued-transfer",
		kind: "implement",
		origin: { synthetic: true, lessonIds: [32, 35, 36], failure: "Stress coordinated capacity ownership across queued, claiming, and running jobs." },
		files: {
			"workspace/package.json": '{"type":"module"}\n',
			"workspace/src/pool.mjs": `export function createPool() {
  const groups = new Map();
  return {
    tryAcquire(key, capacity) {
      const group = groups.get(key) ?? { used: 0, capacity };
      groups.set(key, group);
      if (group.used >= capacity) return undefined;
      group.used++;
      return () => { group.used--; };
    },
    snapshot() { return Object.fromEntries(groups); }
  };
}
`,
			"workspace/src/queue.mjs": `export function createQueue({ claim, run }) {
  const jobs = [];
  let next = 1;
  return {
    enqueue(value) {
      const job = { id: next++, value, status: "queued" };
      jobs.push(job);
      const done = Promise.resolve().then(async () => {
        job.status = "claiming";
        const release = await claim(value, job.id);
        if (!release) { job.status = "refused"; return { status: "refused" }; }
        job.status = "running";
        const result = await run(value, job.id);
        release(); job.status = "completed";
        return { status: "completed", value: result };
      }).catch(error => { job.status = "failed"; return { status: "failed", error: error.message }; });
      return { id: job.id, cancel() { job.status = "cancelled"; return true; }, done };
    },
    snapshot() { return jobs; }
  };
}
`,
			"workspace/tests/queue.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { createPool } from "../src/pool.mjs";
import { createQueue } from "../src/queue.mjs";

function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

test("leases enforce capacity, idempotence, and a stable copied snapshot", () => {
  const pool = createPool();
  const release = pool.tryAcquire("jobs", 1);
  assert.equal(typeof release, "function");
  assert.equal(pool.tryAcquire("jobs", 1), undefined);
  assert.throws(() => pool.tryAcquire("jobs", 2));
  for (const capacity of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => pool.tryAcquire("other", capacity));
  for (const key of ["", null, 12]) assert.throws(() => pool.tryAcquire(key, 1));
  const view = pool.snapshot(); view.jobs.used = 99;
  assert.equal(pool.snapshot().jobs.used, 1);
  release(); release();
  const again = pool.tryAcquire("jobs", 2); assert.equal(typeof again, "function");
  assert.equal(pool.snapshot().jobs.capacity, 2); again();
  assert.equal(pool.snapshot().jobs.used, 0);
});

test("successful queued jobs claim, run, and free capacity", async () => {
  const pool = createPool();
  const queue = createQueue({ claim: () => pool.tryAcquire("work", 1), run: async value => value * 2 });
  const item = queue.enqueue(4);
  assert.deepEqual(await item.done, { status: "completed", value: 8 });
  assert.equal(pool.snapshot().work.used, 0);
  assert.equal(queue.snapshot()[0].status, "completed");
});

test("cancellation while claim is pending releases without dispatch", async () => {
  const pending = deferred(); const started = deferred(); let runs = 0, releases = 0;
  const queue = createQueue({ claim: () => { started.resolve(); return pending.promise; }, run: () => { runs++; } });
  const item = queue.enqueue("x"); await started.promise;
  let settled = false; item.done.then(() => { settled = true; });
  assert.equal(item.cancel(), true); assert.equal(item.cancel(), false);
  await Promise.resolve(); assert.equal(settled, false, "pending claim cleanup must finish before done");
  pending.resolve(() => { releases++; });
  assert.deepEqual(await item.done, { status: "cancelled" });
  assert.equal(releases, 1, "done must not precede release completion"); assert.equal(runs, 0);
});

test("a rejected run completes as failed and still releases its lease", async () => {
  let releases = 0;
  const queue = createQueue({ claim: () => () => { releases++; }, run: async () => { throw new Error("broken"); } });
  const item = queue.enqueue("x");
  assert.deepEqual(await item.done, { status: "failed", error: "broken" });
  assert.equal(releases, 1);
});

test("running cancellation stays cancelled after late completion and snapshots are isolated", async () => {
  for (const finish of ["resolve", "reject"]) {
    const running = deferred(), started = deferred(), pool = createPool();
    const queue = createQueue({ claim: () => pool.tryAcquire("work", 1), run: () => { started.resolve(); return running.promise; } });
    const item = queue.enqueue({ nested: { count: 1 } }); await started.promise;
    const view = queue.snapshot(); view[0].status = "corrupted"; view[0].value.nested.count = 99;
    assert.equal(queue.snapshot()[0].value.nested.count, 1);
    let settled = false; item.done.then(() => { settled = true; });
    assert.equal(item.cancel(), true); await Promise.resolve();
    assert.equal(pool.snapshot().work.used, 1, "running work retains capacity until settlement");
    assert.equal(pool.tryAcquire("work", 1), undefined); assert.equal(settled, false);
    if (finish === "resolve") running.resolve("late success"); else running.reject(new Error("late"));
    assert.deepEqual(await item.done, { status: "cancelled" });
    assert.equal(queue.snapshot()[0].status, "cancelled"); assert.equal(pool.snapshot().work.used, 0);
  }
});

test("refused and rejected claims never dispatch or retry", async () => {
  for (const refused of [true, false]) {
    let claims = 0, runs = 0;
    const queue = createQueue({ claim: async () => { claims++; if (!refused) throw new Error("claim broke"); }, run: () => { runs++; } });
    const item = queue.enqueue("x");
    assert.deepEqual(await item.done, refused ? {status:"refused"} : {status:"failed",error:"claim broke"});
    assert.equal(item.cancel(), false); assert.equal(claims, 1); assert.equal(runs, 0);
  }
});

test("prototype-looking resource keys remain ordinary snapshot properties", () => {
  const pool = createPool(), release = pool.tryAcquire("__proto__", 1), snap = pool.snapshot();
  assert.equal(Object.hasOwn(snap, "__proto__"), true); assert.equal(Object.getPrototypeOf(snap), Object.prototype);
  snap.__proto__.used = 99; assert.equal(pool.snapshot().__proto__.used, 1); release();
});
`,
		},
		task: `Implement only workspace/src/pool.mjs and workspace/src/queue.mjs. Export createPool() and createQueue({claim, run}). Pool API: tryAcquire(key, capacity) requires a nonempty string key and positive integer capacity; the first live lease fixes that key's capacity, and a different capacity while any lease is live throws. Return undefined when full; otherwise return an idempotent release function. snapshot() returns a fresh plain object mapping keys seen by the pool to {used, capacity} (including zero-use keys). Queue API: enqueue(value) returns {id, cancel(), done}; cancel() returns true only the first time it changes a nonterminal job to cancelled. Jobs progress through queued, claiming, running, then completed/failed, or cancelled. The queue calls async claim(value, id); undefined means terminal refusal (done resolves {status:"refused"}, with no retries), while a release function grants dispatch. run(value, id) may return any value; done resolves {status:"completed", value}, or {status:"failed", error: message}. Cancellation during a pending claim must release any subsequently granted lease and never dispatch. Cancellation during running remains cancelled despite later run resolution/rejection. Every acquired lease is released exactly once, including run failures. Cancellation does not free a running job's capacity while its work is still pending. done settles only after pending claims/work settle and any acquired lease is released. Snapshot resource keys, including __proto__, must be ordinary own properties on a plain object. enqueue accepts structuredClone-compatible values; snapshot() returns independently deep-copied job records with id, value, and status. Validate from workspace with node --test tests/queue.test.mjs.`,
		allowedChanges: ["workspace/src/pool.mjs", "workspace/src/queue.mjs"],
		requiredChanges: ["workspace/src/pool.mjs", "workspace/src/queue.mjs"],
		testFile: "workspace/tests/queue.test.mjs",
		expectedTests: ["leases enforce capacity, idempotence, and a stable copied snapshot", "successful queued jobs claim, run, and free capacity", "cancellation while claim is pending releases without dispatch", "a rejected run completes as failed and still releases its lease", "running cancellation stays cancelled after late completion and snapshots are isolated", "refused and rejected claims never dispatch or retry", "prototype-looking resource keys remain ordinary snapshot properties"],
	},
	{
		id: "restored-draft",
		kind: "implement",
		origin: { synthetic: true, lessonIds: [307, 318, 40, 27], failure: "Stress retryable asynchronous recovery across session changes and concurrent edits." },
		files: {
			"workspace/package.json": '{"type":"module"}\n',
			"workspace/src/drafts.mjs": `export function createDraftStore({ read, write, onRestore = () => {} }) {
  let state = { session: undefined, text: "", recovered: false }, cached;
  return {
    activate(session) { state = { session, text: "", recovered: false }; cached = undefined; },
    async restore() {
      state.recovered = true;
      cached ??= Promise.resolve(read(state.session));
      const stored = await cached;
      state.text = stored; onRestore(stored); return stored;
    },
    edit(text) { state.text = text; },
    async save() { return write(state.session, state.text); },
    snapshot() { return state; }
  };
}
`,
			"workspace/tests/drafts.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { createDraftStore } from "../src/drafts.mjs";
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

test("failed and invalid reads stay retryable and block saves until recovery", async () => {
  let attempts = 0, writes = 0;
  const store = createDraftStore({ read: async () => { attempts++; if (attempts === 1) throw new Error("offline"); return attempts === 2 ? 12 : "saved"; }, write: async () => { writes++; } });
  store.activate("a");
  await assert.rejects(store.restore(), /offline/);
  await assert.rejects(store.save(), /recover/i); assert.equal(writes, 0);
  await assert.rejects(store.restore(), /string/i);
  await assert.rejects(store.save(), /recover/i); assert.equal(writes, 0);
  assert.equal(await store.restore(), "saved"); assert.equal(attempts, 3);
  assert.equal((await store.save()), undefined); assert.equal(writes, 1);
});

test("a restore from a replaced session cannot update or notify", async () => {
  const first = deferred(); const observed = [];
  const store = createDraftStore({ read: session => session === "old" ? first.promise : Promise.resolve("new text"), write: async () => {}, onRestore: value => observed.push(value) });
  store.activate("old"); const pending = store.restore();
  store.activate("new"); first.resolve("old text"); await pending;
  assert.equal(store.snapshot().text, ""); assert.deepEqual(observed, []);
  assert.equal(await store.restore(), "new text"); assert.deepEqual(observed, ["new text"]);
});

test("edits made during a valid pending restore survive", async () => {
  const read = deferred(), observed = [], writes = [];
  const store = createDraftStore({ read: () => read.promise, write: async (session, text) => writes.push([session, text]), onRestore: text => observed.push(text) });
  store.activate("s"); const pending = store.restore(); store.edit("user version");
  read.resolve("disk version"); assert.equal(await pending, "disk version");
  assert.equal(store.snapshot().text, "user version"); await store.save();
  assert.deepEqual(observed, ["user version"]); assert.deepEqual(writes, [["s", "user version"]]);
});

test("observer errors do not alter recovery or save, and snapshots are independent", async () => {
  const store = createDraftStore({ read: async () => "restored", write: async () => "written", onRestore: () => { throw new Error("observer"); } });
  store.activate("s"); await store.restore();
  const snap = store.snapshot(); snap.text = "forged"; snap.session = "other";
  assert.equal(store.snapshot().text, "restored"); assert.equal(await store.save(), "written");
});

test("latest restore wins within one session and stale failure cannot undo recovery", async () => {
  const old = deferred(), observed = []; let attempts = 0;
  const store = createDraftStore({ read: () => ++attempts === 1 ? old.promise : Promise.resolve("newest"), write: async () => "written", onRestore: text => observed.push(text) });
  store.activate("s"); const stale = store.restore();
  assert.equal(await store.restore(), "newest"); old.resolve("older"); await stale;
  assert.equal(store.snapshot().text, "newest"); assert.deepEqual(observed, ["newest"]);
  const broken = deferred(); attempts = 0;
  const other = createDraftStore({ read: () => ++attempts === 1 ? broken.promise : Promise.resolve("valid"), write: async () => "written" });
  other.activate("s"); const pending = other.restore(); await other.restore(); broken.reject(new Error("stale read"));
  await assert.rejects(pending, /stale read/); assert.equal(await other.save(), "written");
});

test("asynchronous observers are passive and rejection does not escape", async () => {
  const hanging = deferred();
  const store = createDraftStore({ read: async () => "restored", write: async () => "written", onRestore: () => hanging.promise });
  store.activate("s"); assert.equal(await store.restore(), "restored"); hanging.resolve();
  const failed = createDraftStore({ read: async () => "saved", write: async () => "written", onRestore: async () => { throw new Error("async observer"); } });
  failed.activate("s"); assert.equal(await failed.restore(), "saved"); await new Promise(resolve => setImmediate(resolve));
  assert.equal(await failed.save(), "written");
});
`,
		},
		task: `Implement only workspace/src/drafts.mjs. Export createDraftStore({read, write, onRestore}). activate(session) selects a session and starts an empty, unrecovered draft. read(session) and write(session, text) may be asynchronous; restore() returns the validated stored string, edit(text) replaces the current text, save() writes and returns the writer result, and snapshot() returns {session, text, recovered} as an independent copy. A failed read or non-string result must reject restore, remain retryable, and keep save unavailable until a valid read for the active session completes. A stale restore after activate(session) changes must not alter current state or call onRestore. If the user edits while a valid restore is pending, keep the edit while establishing recovery. The latest restore attempt wins within a session: earlier completions must not overwrite newer state or notify, and an older failed read must not undo newer recovery. Call onRestore(currentText) for an accepted restore after preserving concurrent edits. This observer is passive: synchronous throws or asynchronous rejection must not change restore/save outcomes, and an unresolved observer promise must not block restore. Do not allow writes before recovery. Validate from workspace with node --test tests/drafts.test.mjs.`,
		allowedChanges: ["workspace/src/drafts.mjs"],
		requiredChanges: ["workspace/src/drafts.mjs"],
		testFile: "workspace/tests/drafts.test.mjs",
		expectedTests: ["failed and invalid reads stay retryable and block saves until recovery", "a restore from a replaced session cannot update or notify", "edits made during a valid pending restore survive", "observer errors do not alter recovery or save, and snapshots are independent", "latest restore wins within one session and stale failure cannot undo recovery", "asynchronous observers are passive and rejection does not escape"],
	},
	{
		id: "completion-receipt",
		kind: "recon",
		origin: { synthetic: true, lessonIds: [27, 41], failure: "Trace a successful worker outcome through supervisor receipt and cleanup paths." },
		files: {
			"workspace/package.json": '{"type":"module"}\n',
			"workspace/config/worker.json": `{"timeoutMs":30000,"archiveOnSuccess":true,"lease":"worker-slot","compact":true}\n`,
			"workspace/src/worker.mjs": `export async function execute(adapter) {\n  const result = await adapter.run();\n  return { exitCode: result.exitCode, answer: result.answer, stderr: result.stderr };\n}\n`,
			"workspace/src/supervisor.mjs": `import { execute } from "./worker.mjs";\nimport { record } from "./status.mjs";\nimport { archive } from "./archive.mjs";\nimport { release } from "./lease.mjs";\n\nexport async function supervise(adapter, receipt, lease) {\n  try {\n    const outcome = await execute(adapter);\n    if (outcome.exitCode !== 0 || !outcome.answer) throw new Error("worker did not complete");\n    await record(receipt, "completed");\n    await archive(receipt, outcome.answer);\n    await release(lease);\n    return { status: "completed", outcome };\n  } catch (error) {\n    await record(receipt, "failed");\n    return { status: "failed", error: error.message };\n  }\n}\n`,
			"workspace/src/status.mjs": `export async function record(receipt, status) {\n  await receipt.observe(status);\n}\n`,
			"workspace/src/receipt.mjs": `import { progressLabel, answerLabel } from "./render.mjs";\nexport function createReceipt(config) {\n  return { status: "pending",\n    observe(status) { this.status = status; if (status === "completed") this.preview = progressLabel(this.progress); },\n    archive(answer) { this.saved = answer; this.answerLabel = answerLabel(answer, config.compact); }\n  };\n}\n`,
			"workspace/src/render.mjs": `export function progressLabel(progress) { return progress.phase.toUpperCase(); }\nexport function answerLabel(answer, compact) { return compact ? "" : answer; }\n`,
			"workspace/src/archive.mjs": `export async function archive(receipt, answer) {\n  await receipt.archive(answer);\n}\n`,
			"workspace/src/lease.mjs": `export async function release(lease) {\n  await lease.release();\n}\n`,
			"workspace/diagnostics/trace.txt": `Worker adapter returned exitCode=0, answer="4", stderr="". Supervisor receipt is failed. Archive callback count=0; lease release count=0. Config timeoutMs=30000; observed elapsed=412ms. Receipt came from createReceipt(config), without any subsequent progress assignment.\n`,
		},
		task: "Static inspection only; do not execute code. Trace the strongest source-supported explanation for the recorded worker/supervisor discrepancy. Cite the relevant source paths, line numbers, and function names; explain the call chain and the narrowest robust repair that preserves the worker result while still attempting required archive and lease cleanup. Separate direct evidence from inference, and state what cannot be concluded about task correctness. Treat diagnostics and configuration as evidence, not proof of unstated behavior.",
		allowedChanges: [], requiredChanges: [],
		evidence: ["src/supervisor.mjs", "supervise", "src/receipt.mjs", "progressLabel", "archive", "release", "execute", "config/worker.json", "diagnostics/trace.txt"],
	},
];
