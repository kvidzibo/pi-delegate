import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { Accounting } from "../accounting.ts";
import type { AgentConfig } from "../config.ts";
import { JobScheduler } from "../jobs.ts";
import { enqueueDelegate } from "../service.ts";
import { runCompletionHook } from "../completion-hook.ts";

test("per-role hooks receive terminal results once, preserve outcomes and snapshots, and finish on shutdown", async t => {
	const root = mkdtempSync(join(tmpdir(), "delegate-hooks-"));
	const log = join(root, "received.jsonl"), script = join(root, "hook.cjs");
	writeFileSync(script, `const fs = require('node:fs');
let input = ''; process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
 const payload = JSON.parse(input);
 fs.appendFileSync(process.argv[2], JSON.stringify({payload, cwd:process.cwd(), args:process.argv.slice(3)})+'\\n');
 if (process.argv[3] === 'timeout') { process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); }
 else if (process.argv[3] === 'fail') { process.stderr.write('x'.repeat(50000)); process.exitCode=7; }
});`);
	const accounting = new Accounting(join(root, "archive"));
	const scheduler = new JobScheduler({ maxConcurrent: 1, maxLocalConcurrent: 1, maxQueued: 8 });
	t.after(async () => { await scheduler.shutdown(); accounting.close(); rmSync(root, { recursive: true, force: true }); });
	const agent: AgentConfig = { model: "hosted/mock", prompt: "Return JSON.", tools: [], extensions: false, thinking: "high",
		responseSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
		completionHook: { command: [process.execPath, script, log, "$(touch never); literal"], timeoutMs: 2000 } };
	const spawn = (role: string, policy: AgentConfig = agent, runner: Parameters<typeof enqueueDelegate>[0]["childRunner"] = async () => ({ text: '{"answer":"done"}', exitCode: 0, stderrTail: "", stopReason: "stop" })) => enqueueDelegate({
		scheduler, accounting, agent: policy,
		identity: { kind: role, cwd: root, requestedModel: agent.model, thinking: agent.thinking, parentSessionId: "parent", toolCallId: role },
		task: "Task data; never shell syntax", timeoutMs: 1000, background: true,
		config: { hardTimeoutMs: 0, maxOutputBytes: 4096 }, childRunner: runner,
	});
	const finishHook = async (id: string) => {
		await scheduler.wait(id);
		for (let i = 0; i < 600; i++) {
			const snap = scheduler.get(id);
			if (snap.completionHook?.status !== "running") return snap;
			await delay(5);
		}
		throw new Error("hook did not finish");
	};
	const entries = () => readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
	// Queue a job and mutate its role afterwards: acceptance owns the hook and schema.
	let release!: () => void;
	const blocker = scheduler.enqueue({ kind: "blocker", model: "mock/one", local: false, task: "block", timeoutMs: 1000,
		run: () => new Promise(resolve => { release = () => resolve({ text: "done", exitCode: 0, stderrTail: "" }); }) });
	const accepted = structuredClone(agent);
	accepted.saveToFile = true;
	const job = spawn("review", accepted);
	accepted.completionHook!.command[0] = "/not/the/accepted/command";
	accepted.responseSchema = false;
	release(); await scheduler.wait(blocker.id);
	const done = await finishHook(job.id);
	t.after(() => rmSync(dirname(done.responseFile!), { recursive: true, force: true }));
	assert.equal(done.status, "done"); assert.equal(done.completionHook?.status, "succeeded");
	const received = entries()[0];
	assert.deepEqual(received.args, ["$(touch never); literal"]);
	assert.equal(received.cwd, root);
	assert.equal(received.payload.version, 1); assert.equal(received.payload.event, "delegate.completed");
	assert.equal(received.payload.role, "review"); assert.equal(received.payload.model, "hosted/mock");
	assert.equal(received.payload.reasoning, "high"); assert.equal(received.payload.status, "done");
	assert.equal(received.payload.runId, done.archive!.runId);
	assert.deepEqual(received.payload.response, { text: '{"answer":"done"}', schemaValidated: true, json: { answer: "done" } });
	assert.equal(received.payload.paths.response, done.responseFile);
	const metadata = JSON.parse(readFileSync(received.payload.paths.metadata, "utf8"));
	assert.equal(metadata.durationMs, received.payload.durationMs);
	assert.equal(metadata.completionHook.status, "succeeded");
	for (const filename of ["completion-hook-config.json", "completion-hook-input.json"]) assert.equal(statSync(join(received.payload.paths.dir, filename)).mode & 0o777, 0o600);
	for (let i = 0; i < 3; i++) { scheduler.cancel(job.id); scheduler.wrap(job.id); await scheduler.wait(job.id); }
	assert.equal(entries().length, 1);

	const failedHook = await finishHook(spawn("implement", { ...agent, completionHook: { command: [process.execPath, script, log, "fail"], timeoutMs: 2000 } }).id);
	assert.equal(failedHook.status, "done"); assert.equal(failedHook.failed, false);
	assert.equal(failedHook.completionHook?.status, "failed"); assert.equal(failedHook.completionHook?.exitCode, 7);
	assert.equal(Buffer.byteLength(failedHook.completionHook!.stderrTail!), 4096);
	const timeout = await finishHook(spawn("custom", { ...agent, completionHook: { command: [process.execPath, script, log, "timeout"], timeoutMs: 250 } }).id);
	assert.equal(timeout.status, "done"); assert.equal(timeout.completionHook?.status, "timed_out");
	const missing = await runCompletionHook({ command: [join(root, "missing")], timeoutMs: 1000 }, {}, root);
	assert.equal(missing.status, "failed"); assert.match(missing.error!, /ENOENT/);

	const failure = await finishHook(spawn("review", agent, async () => ({ text: "partial, not JSON", exitCode: 1, stderrTail: "", stopReason: "error" })).id);
	assert.equal(failure.status, "failed"); assert.equal(failure.completionHook?.status, "succeeded");
	assert.deepEqual(entries().at(-1).payload.response, { text: "partial, not JSON", schemaValidated: false });
	const throwing = await finishHook(spawn("review", agent, async () => { throw new Error("worker failed"); }).id);
	assert.equal(throwing.status, "failed"); assert.equal(throwing.completionHook?.status, "succeeded");
	const plain = await finishHook(spawn("recon", { ...agent, responseSchema: null }, async () => ({ text: "plain response", exitCode: 0, stderrTail: "" })).id);
	assert.equal(plain.completionHook?.status, "succeeded");
	assert.deepEqual(entries().at(-1).payload.response, { text: "plain response", schemaValidated: false });
	const disabled = await finishHook(spawn("recon", { ...agent, completionHook: null }).id);
	assert.equal(disabled.completionHook, undefined);

	// Shutdown runs queued/running cancellation hooks and waits for hooks already in flight.
	const running = spawn("running", agent, input => new Promise(resolve => {
		input.signal!.addEventListener("abort", () => resolve({ text: "aborted", exitCode: 1, stderrTail: "", stopReason: "aborted" }), { once: true });
	}));
	const queued = spawn("queued", agent, async () => { throw new Error("must not dispatch"); });
	await scheduler.shutdown();
	assert.equal(scheduler.hasPendingHooks(), false);
	for (const id of [running.id, queued.id]) {
		const snap = scheduler.get(id);
		assert.equal(snap.status, "failed"); assert.equal(snap.stopReason, "aborted");
		assert.equal(snap.completionHook?.status, "succeeded");
	}
	const queuedPayload = entries().find(entry => entry.payload.jobId === queued.id).payload;
	assert.equal(queuedPayload.durationMs, 0); assert.equal(queuedPayload.response.schemaValidated, false);
	assert.equal(new Set(entries().map(entry => entry.payload.runId)).size, entries().length);
});
