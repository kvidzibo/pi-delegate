import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";
import { Accounting } from "../accounting.ts";
import { JobScheduler } from "../jobs.ts";
import { infobar, inScope, latestRuns, statsReport } from "../stats.ts";
import type { RunIdentity } from "../archive.ts";

const identity: RunIdentity = { parentSessionId: "parent-a", toolCallId: "call", kind: "recon", cwd: "/tmp", requestedModel: "local-qwen38/qwen38-q4km", thinking: "off", tools: ["read"] };
function setup(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "delegate-accounting-")); t.after(() => rmSync(root, { recursive: true, force: true }));
	const prompt = join(root, "prompt.md"); writeFileSync(prompt, "prompt");
	const statuses: Array<string | undefined> = [];
	const notices: string[] = [];
	const ui = { setStatus: (key: string, text: string | undefined) => { assert.equal(key, "delegate-usage"); statuses.push(text); }, notify: (text: string) => { notices.push(text); } };
	return { root, prompt, ui, statuses, notices, accounting: new Accounting(root) };
}

test("session infobar updates live, counts final usage once, survives resume, resets on new and stays out of parent usage", async (t) => {
	const { root, prompt, ui, statuses, accounting } = setup(t);
	await accounting.activate("parent-a", ui);
	assert.equal(statuses.at(-1), "delegated 0 · local 0 · saved —");
	const run = accounting.create(identity, "task", prompt);
	const message = { role: "assistant", timestamp: 123, provider: "local-qwen38", model: "qwen38-q4km", usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 } };
	const result = await accounting.run(run, "d0001", async (event) => {
		event({ type: "message_start", message });
		event({ type: "message_update", usage: { ...message.usage, output: 10 } });
		assert.match(statuses.at(-1)!, /delegated 110 · local 110 · saved — · !partial/);
		appendFileSync(run.paths.session, `${JSON.stringify({ type: "message", id: "a", message })}\n`);
		event({ type: "message_end", message }); event({ type: "agent_end", messages: [message] }); event({ type: "agent_settled" });
		return { text: "answer", exitCode: 0, stderrTail: "", stopReason: "stop" };
	});
	assert.equal("usage" in result, false, "do not mix child tokens into Pi's normal parent footer");
	assert.equal(statuses.at(-1), "delegated 120 · local 120 · saved —");
	accounting.terminal(run.data.runId, "d0001", { status: "done" });
	assert.equal(readFileSync(join(root, "usage.jsonl"), "utf8").trim().split("\n").length, 1);
	accounting.close(); assert.equal(statuses.at(-1), undefined);
	const resumed = new Accounting(root);
	await resumed.activate("parent-a", ui); assert.equal(statuses.at(-1), "delegated 120 · local 120 · saved —");
	await resumed.activate("parent-b", ui); assert.equal(statuses.at(-1), "delegated 0 · local 0 · saved —");
	await resumed.activate("parent-a", ui); assert.match(await resumed.report("session", "parent-a"), /Delegated: 120 tokens/);
	resumed.close();
});

test("shutdown and queued cancellation archive exactly once without background completion notices", async (t) => {
	const { prompt, ui, accounting, root } = setup(t);
	await accounting.activate("parent-a", ui);
	let notifications = 0;
	const scheduler = new JobScheduler({ maxConcurrent: 1, maxLocalConcurrent: 1, maxQueued: 4, onTerminal: () => { notifications++; }, onSettled: (s) => accounting.terminal(s.archive?.runId, s.id, { status: s.failed ? "failed" : "done", stopReason: s.stopReason, exitCode: s.exitCode }) });
	for (let i = 0; i < 2; i++) {
		const run = accounting.create(identity, "task", prompt);
		scheduler.enqueue({ archive: { runId: run.data.runId, sessionFile: run.paths.session }, kind: "recon", model: identity.requestedModel, local: true, task: "task", timeoutMs: 1000,
			run: (job, signal) => accounting.run(run, job.id, async () => new Promise((resolve) => {
				const finish = () => resolve({ text: "cancelled", exitCode: 143, stderrTail: "", stopReason: "aborted" });
				if (signal.aborted) finish(); else signal.addEventListener("abort", finish, { once: true });
			})),
		});
	}
	await scheduler.shutdown();
	assert.equal(notifications, 0);
	const rows = readFileSync(join(root, "usage.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(rows.length, 2); assert.equal(rows.filter((r) => r.startedAt).length, 1);
	assert.equal(rows.every((r) => r.status === "failed"), true);
	assert.match(await accounting.report("session", "parent-a"), /Runs: 2; done 0; failed 2/);
	accounting.close();
});

test("warning attribution keeps other sessions out; unknown archive health is distinct from partial usage", async (t) => {
	const { root, prompt, ui, statuses, accounting } = setup(t);
	const other = accounting.create({ ...identity, parentSessionId: "other-parent" }, "task", prompt);
	accounting.terminal(other.data.runId, "d0001", { status: "failed", stopReason: "aborted" });
	const metadata = JSON.parse(readFileSync(other.paths.metadata, "utf8")); metadata.status = "broken";
	writeFileSync(other.paths.metadata, JSON.stringify(metadata));
	const reader = new Accounting(root); await reader.activate("parent-a", ui);
	assert.equal(statuses.at(-1), "delegated 0 · local 0 · saved —");
	assert.equal((await reader.report("session", "parent-a")).includes(other.data.runId), false);
	assert.ok((await reader.report("all", "parent-a")).includes(other.data.runId));
	writeFileSync(other.paths.metadata, "not json");
	await reader.activate("parent-a", ui);
	assert.equal(statuses.at(-1), "delegated 0 · local 0 · saved — · !archive");
	const scoped = await reader.report("session", "parent-a");
	assert.ok(scoped.includes("cannot be attributed")); assert.equal(scoped.includes(other.data.runId), false);
	metadata.createdAt = "not-a-date"; writeFileSync(other.paths.metadata, JSON.stringify(metadata));
	assert.ok((await reader.report("today", "parent-a")).includes("cannot be attributed"));
	reader.close(); accounting.close();
});

test("reactivating while live preserves meter-backed records instead of replacing them with a disk clone", async (t) => {
	const { prompt, ui, statuses, accounting } = setup(t);
	await accounting.activate("parent-a", ui);
	const run = accounting.create(identity, "task", prompt);
	run.start("d0001"); run.observe({ type: "message_update", usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 } });
	await accounting.activate("parent-a", ui);
	assert.match(statuses.at(-1)!, /delegated 120 · local 120/);
	await run.finish({ status: "failed", stopReason: "aborted" });
	accounting.terminal(run.data.runId, "d0001", { status: "failed" });
	accounting.close();
});

test("queued recording failures are attached before terminal wait/collect snapshots", async (t) => {
	const { root, prompt, ui, accounting } = setup(t);
	await accounting.activate("parent-a", ui);
	const scheduler = new JobScheduler({ maxConcurrent: 1, maxLocalConcurrent: 1, maxQueued: 2,
		onSettled: (s) => accounting.terminal(s.archive?.runId, s.id, { status: s.failed ? "failed" : "done", stopReason: s.stopReason, exitCode: s.exitCode }),
	});
	let release!: () => void;
	const blocking = scheduler.enqueue({ kind: "recon", model: identity.requestedModel, local: true, task: "block", timeoutMs: 1000,
		run: () => new Promise((resolve) => { release = () => resolve({ text: "done", exitCode: 0, stderrTail: "", stopReason: "stop" }); }),
	});
	const run = accounting.create(identity, "task", prompt);
	const queued = scheduler.enqueue({ archive: { runId: run.data.runId, sessionFile: run.paths.session }, kind: "recon", model: identity.requestedModel, local: true, task: "task", timeoutMs: 1000, run: async () => { throw new Error("must stay queued"); } });
	mkdirSync(join(root, "usage.jsonl")); scheduler.cancel(queued.id);
	assert.match(scheduler.get(queued.id).recordingError!, /recording incomplete/);
	assert.match((await scheduler.wait(queued.id)).recordingError!, /recording incomplete/);
	release(); await scheduler.wait(blocking.id); await scheduler.shutdown(); accounting.close();
});

test("UI errors cannot turn successful work into failure or strand accounting", async (t) => {
	const { root, prompt, accounting } = setup(t);
	await accounting.activate("parent-a", { setStatus: () => { throw new Error("UI gone"); }, notify: () => { throw new Error("UI gone"); } });
	const run = accounting.create(identity, "task", prompt);
	const result = await accounting.run(run, "d0001", async () => ({ text: "answer", exitCode: 0, stderrTail: "", stopReason: "stop" }));
	assert.equal(result.text, "answer");
	assert.equal(JSON.parse(readFileSync(run.paths.metadata, "utf8")).status, "done");
	accounting.close();
});

test("session/day/all filters, honest savings label, distinct local/hosted and terminal-safe reporting", async (t) => {
	const { accounting, prompt, root } = setup(t);
	const archive = accounting.create(identity, "task", prompt);
	const run = archive.data;
	run.createdAt = new Date(2026, 8, 5, 10).toISOString();
	assert.equal(inScope(run, "session", "parent-a"), true); assert.equal(inScope(run, "session", "parent-b"), false);
	assert.equal(inScope(run, "today", "x", new Date(2026, 8, 5, 20)), true);
	assert.equal(inScope(run, "today", "x", new Date(2026, 8, 6, 1)), false);
	assert.equal(inScope(run, "all", "x"), true);
	run.status = "done";
	run.usage.local = { input: 100, output: 10, cacheRead: 5, cacheWrite: 0, total: 115 };
	run.usage.hosted = { input: 200, output: 20, cacheRead: 0, cacheWrite: 0, total: 220 };
	assert.equal(infobar([run, run]), "delegated 335 · local 115 · saved —", "duplicate records never double count");
	const terminal = { ...run, revision: 10, status: "done" as const };
	const staleRebuild = { ...run, revision: 2, status: "running" as const };
	assert.deepEqual(latestRuns([terminal, staleRebuild]), [terminal], "late rebuild rows must not regress a finalized export");
	run.actualModel = "model\x1b[31m\nspoof";
	const report = statsReport([run], root, "session");
	assert.ok(report.includes("Saved: unavailable")); assert.ok(!report.includes("\x1b"));
	assert.ok(report.includes("Local: 115")); assert.ok(report.includes("Hosted: 220"));
	accounting.terminal(run.runId, "d0001", { status: "failed", stopReason: "aborted" });
	accounting.close();
});
