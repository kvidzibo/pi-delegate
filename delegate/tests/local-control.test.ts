import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { LocalControl, localStatusText } from "../local-control.ts";
import { JobScheduler, type EnqueueInput } from "../jobs.ts";

const ok = { text: "done", exitCode: 0, stderrTail: "" };
function root(t: TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "delegate-local-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}
const job = (run: EnqueueInput["run"], local = true): EnqueueInput => ({
	kind: "recon", model: local ? "ollama/test" : "hosted/test", local, task: "mock only", timeoutMs: 1000, background: true, run,
});

async function until(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!check()) {
		assert.ok(Date.now() < deadline, "condition timed out");
		await new Promise(r => setTimeout(r, 10));
	}
}

test("persistent switch defaults ON, reservations precede OFF, and release is idempotent", t => {
	const path = root(t), a = new LocalControl(path), b = new LocalControl(path);
	assert.deepEqual(a.status(), { enabled: true, active: 0, uncertain: 0 });
	const release = a.acquire()!;
	assert.equal(b.status().active, 1);
	b.setEnabled(false);
	assert.equal(localStatusText(a.status()), "Local delegation: OFF · draining 1 job");
	assert.equal(a.acquire(), undefined);
	assert.throws(() => a.assertEnabled(), /local delegation is OFF/);
	release(); release();
	assert.equal(localStatusText(b.status()), "Local delegation: OFF · idle");
	assert.equal(new LocalControl(path).enabled(), false);
	b.setEnabled(true);
	assert.equal(a.enabled(), true);
	if (process.platform !== "win32") {
		assert.equal(statSync(path).mode & 0o777, 0o700);
		assert.equal(statSync(join(path, "state.json")).mode & 0o777, 0o600);
	}
});

test("OFF between reservation publication and admission cannot launch or claim idle early", t => {
	const path = root(t), a = new LocalControl(path), b = new LocalControl(path);
	const enabled = a.enabled.bind(a);
	a.enabled = () => {
		b.setEnabled(false);
		assert.equal(b.status().active, 1, "OFF must see even an admission-in-progress");
		return enabled();
	};
	assert.equal(a.acquire(), undefined);
	assert.equal(b.status().active, 0);
});

test("status retries an ON/OFF change during its activity scan instead of returning stale idle", t => {
	const path = root(t), writer = new LocalControl(path);
	const release = writer.acquire()!;
	writer.setEnabled(false);
	let scans = 0;
	const reader = new LocalControl(path, () => {
		if (++scans === 1) { writer.setEnabled(true); writer.setEnabled(false); }
		return true;
	});
	assert.deepEqual(reader.status(), { enabled: false, active: 1, uncertain: 0 });
	assert.equal(scans, 2, "a changed revision must retry the activity scan");
	release();
});

test("corrupt/unreadable state fails closed and unknown reservations never imply idle", t => {
	const path = root(t), gate = new LocalControl(path, () => false);
	const release = gate.acquire()!;
	gate.setEnabled(false);
	assert.match(localStatusText(gate.status()), /1 unverified \(not idle\)/);
	assert.equal(readdirSync(join(path, "active")).length, 1, "do not prune a crashed parent's possible orphan child");
	release();
	writeFileSync(join(path, "active", "unknown"), "");
	assert.equal(gate.status().uncertain, 1);
	writeFileSync(join(path, "state.json"), "{broken");
	assert.throws(() => gate.enabled());
	assert.throws(() => gate.acquire());
	assert.deepEqual(readdirSync(join(path, "active")), ["unknown"], "failed admissions clean their own reservation");
	assert.throws(() => gate.status());
	gate.setEnabled(false); // explicit command can repair the state, not reservations
	assert.equal(gate.enabled(), false);
});

test("state symlinks and non-private control directories are refused", t => {
	const path = root(t), gate = new LocalControl(join(path, "control"));
	gate.status();
	const target = join(path, "target"); writeFileSync(target, "{}");
	symlinkSync(target, join(gate.root, "state.json"));
	assert.throws(() => gate.enabled());
	assert.equal(readFileSync(target, "utf8"), "{}");
	if (process.platform !== "win32") {
		const publicDir = join(path, "public"); mkdirSync(publicDir, { mode: 0o755 });
		assert.throws(() => new LocalControl(publicDir).enabled(), /must be private/);
	}
});

test("OFF holds queued local jobs, rejects new ones, drains running jobs and leaves hosted work independent", async t => {
	const gate = new LocalControl(root(t));
	const scheduler = new JobScheduler({ maxConcurrent: 2, maxLocalConcurrent: 1, maxQueued: 3, localAdmission: gate });
	let finish!: () => void;
	const first = scheduler.enqueue(job(async () => { await new Promise<void>(r => { finish = r; }); return ok; }));
	const second = scheduler.enqueue(job(async () => ok));
	assert.equal(second.reason, "gpu");
	gate.setEnabled(false);
	scheduler.refreshLocalState();
	assert.equal(scheduler.get(second.id).reason, "local-off");
	assert.equal(scheduler.get(first.id).status, "running");
	assert.throws(() => scheduler.enqueue(job(async () => ok)), /local delegation is OFF/);
	const hosted = scheduler.enqueue(job(async () => ok, false));
	assert.equal((await scheduler.wait(hosted.id)).status, "done");
	finish();
	await scheduler.wait(first.id);
	assert.equal(scheduler.get(second.id).status, "queued");
	assert.equal(gate.status().active, 0);
	gate.setEnabled(true);
	scheduler.refreshLocalState();
	assert.equal((await scheduler.wait(second.id)).status, "done");
	assert.equal(gate.status().active, 0);
	await scheduler.shutdown();
});

for (const outcome of ["success", "failure", "throw", "cancel", "shutdown"] as const) {
	test(`local reservation survives until ${outcome} cleanup`, async t => {
		const gate = new LocalControl(root(t));
		const scheduler = new JobScheduler({ maxConcurrent: 1, maxLocalConcurrent: 1, maxQueued: 2, localAdmission: gate });
		const snap = scheduler.enqueue(job(async (_job, signal) => {
			assert.equal(gate.status().active, 1);
			if (outcome === "cancel" || outcome === "shutdown") await new Promise<void>(r => signal.addEventListener("abort", () => r(), { once: true }));
			if (outcome === "throw") throw new Error("runner failed");
			return outcome === "failure" ? { ...ok, exitCode: 1 } : ok;
		}));
		if (outcome === "cancel") scheduler.cancel(snap.id);
		if (outcome === "shutdown") await scheduler.shutdown();
		await scheduler.wait(snap.id);
		assert.equal(gate.status().active, 0);
		await scheduler.shutdown();
	});
}

test("admission races do not spin or block hosted dispatch, paused queued jobs can cancel", async t => {
	const gate = new LocalControl(root(t));
	gate.acquire = () => undefined;
	const scheduler = new JobScheduler({ maxConcurrent: 1, maxLocalConcurrent: 1, maxQueued: 2, localAdmission: gate });
	const queued = scheduler.enqueue(job(async () => { throw new Error("must not run"); }));
	assert.equal(queued.status, "queued");
	const another = scheduler.enqueue(job(async () => ok));
	assert.throws(() => scheduler.enqueue(job(async () => ok)), /queue full/);
	assert.equal(scheduler.active().length, 2);
	const hosted = scheduler.enqueue(job(async () => ok, false));
	assert.equal((await scheduler.wait(hosted.id)).status, "done");
	gate.setEnabled(false);
	scheduler.cancel(queued.id);
	scheduler.cancel(another.id);
	assert.equal(scheduler.get(queued.id).stopReason, "aborted");
	await scheduler.shutdown();
});

test("reservation cleanup failure cannot replace the answer or hide behind recording warnings", async t => {
	const gate = new LocalControl(root(t));
	const acquire = gate.acquire.bind(gate);
	let release!: () => void;
	gate.acquire = () => { release = acquire()!; return () => { throw new Error("cannot unlink"); }; };
	const scheduler = new JobScheduler({ maxConcurrent: 1, maxLocalConcurrent: 1, maxQueued: 1, localAdmission: gate, onSettled: () => "accounting warning" });
	const snap = scheduler.enqueue(job(async () => ({ ...ok, recordingError: "child recording warning" })));
	const done = await scheduler.wait(snap.id);
	assert.equal(done.status, "done");
	assert.equal(done.answer, "done");
	assert.match(done.recordingError!, /activity cleanup failed/);
	assert.match(done.recordingError!, /accounting warning/);
	assert.match(done.recordingError!, /child recording warning/);
	assert.equal(gate.status().active, 1);
	release();
	await scheduler.shutdown();
});

test("admission I/O errors stay visible, preserve hosted work, and recover on refresh", async t => {
	const gate = new LocalControl(root(t));
	const acquire = gate.acquire.bind(gate);
	gate.acquire = () => { throw new Error("disk read-only"); };
	const scheduler = new JobScheduler({ maxConcurrent: 1, maxLocalConcurrent: 1, maxQueued: 1, localAdmission: gate });
	const queued = scheduler.enqueue(job(async () => ok));
	assert.equal(queued.reason, "local-unavailable");
	assert.match(queued.recordingError!, /disk read-only/);
	assert.throws(() => scheduler.enqueue(job(async () => ok)), /queue full/);
	const hosted = scheduler.enqueue(job(async () => ok, false));
	assert.equal((await scheduler.wait(hosted.id)).status, "done");
	gate.acquire = acquire;
	scheduler.refreshLocalState();
	const done = await scheduler.wait(queued.id);
	assert.equal(done.status, "done");
	assert.equal(done.recordingError, undefined);
	await scheduler.shutdown();
});

function worker(t: TestContext, path: string) {
	const proc = fork(new URL("./fixtures/local-worker.ts", import.meta.url), [path], {
		execArgv: ["--experimental-strip-types"], stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	let seq = 0, stderr = "";
	proc.stderr?.on("data", chunk => { stderr += chunk; });
	const pending = new Map<number, { resolve: (value: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	proc.on("message", (m: any) => {
		const request = pending.get(m.id);
		if (!request) return;
		clearTimeout(request.timer); pending.delete(m.id);
		if (m.error) request.reject(new Error(m.error)); else request.resolve(m.value);
	});
	proc.on("exit", () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(stderr || "Worker exited")); } pending.clear(); });
	t.after(async () => { if (proc.exitCode === null && proc.signalCode === null) { const exit = once(proc, "exit"); proc.kill(); await exit; } });
	return {
		proc,
		call: (cmd: string, extra = {}): Promise<any> => new Promise((resolve, reject) => {
			const id = ++seq;
			const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Worker timeout: ${cmd} ${stderr}`)); }, 8000);
			pending.set(id, { resolve, reject, timer }); proc.send({ id, cmd, ...extra });
		}),
	};
}

test("independent processes share OFF and active counts, auto-resume queued work and retain crash uncertainty", async t => {
	const path = root(t), gate = new LocalControl(path), a = worker(t, path), b = worker(t, path);
	const first = await a.call("launch", { hold: true });
	const second = await b.call("launch", { hold: true });
	assert.equal(gate.status().active, 2);
	const queued = await b.call("launch");
	assert.equal(queued.status, "queued");
	gate.setEnabled(false);
	assert.equal(gate.status().active, 2);
	await assert.rejects(a.call("launch"), /local delegation is OFF/);
	assert.equal((await a.call("launch", { local: false })).status, "running");
	await a.call("finish", { jobId: first.id });
	await b.call("finish", { jobId: second.id });
	assert.equal(gate.status().active, 0);
	assert.equal((await b.call("get", { jobId: queued.id })).reason, "local-off");
	gate.setEnabled(true);
	await until(() => gate.status().active === 0); // actual queued completion checked below, not inferred from idle
	await new Promise(r => setTimeout(r, 1200));
	assert.equal((await b.call("get", { jobId: queued.id })).status, "done", "polling resumes without a new launch or reload");
	await a.call("launch", { hold: true });
	gate.setEnabled(false);
	const exit = once(a.proc, "exit"); a.proc.send({ cmd: "crash" }); await exit;
	assert.equal(gate.status().uncertain, 1);
	assert.match(localStatusText(gate.status()), /not idle/);
	await b.call("shutdown");
});
