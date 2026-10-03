// Test-only reference implementations; never copied into participant fixtures by the live runner.
export const hardSolutions: Record<string, Record<string, string>> = {
	"queued-transfer": {
		"workspace/src/pool.mjs": `export function createPool() {
  const groups = new Map();
  return {
    tryAcquire(key, capacity) {
      if (typeof key !== "string" || !key.length) throw new TypeError("key must be nonempty");
      if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("capacity must be positive");
      let group = groups.get(key);
      if (group && group.used > 0 && group.capacity !== capacity) throw new Error("capacity conflicts with live leases");
      if (!group || group.used === 0) { group = { capacity, used: 0 }; groups.set(key, group); }
      if (group.used >= group.capacity) return undefined;
      group.used++;
      let live = true;
      return () => { if (!live) return; live = false; group.used--; };
    },
    snapshot() { return Object.fromEntries([...groups].map(([key, group]) => [key, { ...group }])); }
  };
}
`,
		"workspace/src/queue.mjs": `export function createQueue({ claim, run }) {
  const jobs = [];
  let next = 1;
  const message = error => error instanceof Error ? error.message : String(error);
  return {
    enqueue(value) {
      const job = { id: next++, value, status: "queued" };
      jobs.push(job);
      let resolveDone;
      const done = new Promise(resolve => { resolveDone = resolve; });
      queueMicrotask(async () => {
        let lease, outcome;
        try {
          if (job.status === "cancelled") { outcome = { status: "cancelled" }; return; }
          job.status = "claiming";
          lease = await claim(value, job.id);
          if (job.status === "cancelled") { outcome = { status: "cancelled" }; return; }
          if (!lease) { job.status = "refused"; outcome = { status: "refused" }; return; }
          job.status = "running";
          const result = await run(value, job.id);
          if (job.status === "cancelled") outcome = { status: "cancelled" };
          else { job.status = "completed"; outcome = { status: "completed", value: result }; }
        } catch (error) {
          if (job.status === "cancelled") outcome = { status: "cancelled" };
          else { job.status = "failed"; outcome = { status: "failed", error: message(error) }; }
        } finally {
          try { lease?.(); } finally { resolveDone(outcome); }
        }
      });
      return { id: job.id, done, cancel() {
        if (["completed", "failed", "refused", "cancelled"].includes(job.status)) return false;
        job.status = "cancelled"; return true;
      } };
    },
    snapshot() { return jobs.map(({ id, value, status }) => ({ id, value: structuredClone(value), status })); }
  };
}
`
	},
	"restored-draft": {
		"workspace/src/drafts.mjs": `export function createDraftStore({ read, write, onRestore = () => {} }) {
  let state = { session: undefined, text: "", recovered: false };
  let generation = 0, attempt = 0, edits = 0;
  return {
    activate(session) { generation++; attempt++; edits = 0; state = { session, text: "", recovered: false }; },
    async restore() {
      const version = generation, serial = ++attempt, session = state.session, editVersion = edits;
      const stored = await read(session);
      if (typeof stored !== "string") throw new TypeError("restore result must be a string");
      if (version !== generation || serial !== attempt) return stored;
      if (edits === editVersion) state.text = stored;
      state.recovered = true;
      try { Promise.resolve(onRestore(state.text)).catch(() => {}); } catch {}
      return stored;
    },
    edit(text) { state.text = text; edits++; },
    async save() {
      if (!state.recovered) throw new Error("draft must recover before save");
      return write(state.session, state.text);
    },
    snapshot() { return { ...state }; }
  };
}
`
	}
};

export const hardReconAnswer = `In src/supervisor.mjs, supervise obtains the worker outcome through execute in src/worker.mjs, accepts exitCode 0 with an answer, then awaits record before archive and release. record in src/status.mjs calls receipt.observe. The receipt in src/receipt.mjs calls progressLabel in src/render.mjs on completed status with missing progress metadata; accessing progress.phase throws. That interrupts the success path before archive (src/archive.mjs) or release (src/lease.mjs), and the outer catch records failed, replacing the worker outcome. diagnostics/trace.txt confirms a zero exit, answer present, failed receipt and zero archive/release invocations. config/worker.json and the elapsed trace do not support a timeout; compact answer rendering does not mean the worker supplied no answer. Guard observer errors independently, preserve the worker outcome, and attempt archive and release independently with finally-based cleanup so neither failure prevents the other attempt. Report secondary persistence/cleanup failures separately. Worker completion and answer presence do not prove task correctness; no task specification establishes whether 4 is correct.`;
