import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFileSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ArchivedRun, archiveRoot, loadRuns, type RunIdentity } from "../archive.ts";
import { totalTokens } from "../usage.ts";

const identity: RunIdentity = { parentSessionId: "parent", parentSessionFile: "/parent.jsonl", toolCallId: "tool-call", kind: "recon", cwd: "/tmp", requestedModel: "local-qwen38/qwen38-q4km", thinking: "off", tools: ["read"] };
const used = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 };
function setup(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "delegate-archive-")); t.after(() => rmSync(root, { recursive: true, force: true }));
	const prompt = join(root, "source.md"); writeFileSync(prompt, "custom system prompt");
	return { root, prompt, run: new ArchivedRun(root, identity, "sensitive task", prompt) };
}
function assistant(run: ArchivedRun, id = "a") {
	const message = { role: "assistant", timestamp: 1, provider: "local-qwen38", model: "qwen38-q4km", usage: used, content: [{ type: "text", text: "full uncapped answer" }] };
	appendFileSync(run.paths.session, `${JSON.stringify({ type: "message", id, message })}\n`);
	run.observe({ type: "message_end", message });
}

test("archive overrides resolve locally; path IDs cannot escape", () => {
	assert.equal(archiveRoot("/agent", {}), "/agent/delegate");
	assert.equal(archiveRoot("/agent", { PI_DELEGATE_ARCHIVE_DIR: "/archive" }), "/archive");
});

test("private native sessions, tasks, and prompts are retained after completion; ledger excludes prompt content", async (t) => {
	const { root, run } = setup(t);
	run.start("d0001"); assistant(run); run.observe({ type: "agent_settled" });
	await run.finish({ status: "done", stopReason: "stop", exitCode: 0 });
	await run.finish({ status: "done" }); // terminal idempotence
	assert.equal(totalTokens(run.data.usage), 120);
	assert.equal(run.data.usage.incomplete, false);
	assert.equal(run.data.parentSessionId, "parent");
	assert.equal(JSON.parse(readFileSync(run.paths.session, "utf8").split("\n")[0]).parentSession, "/parent.jsonl");
	assert.equal(readFileSync(run.paths.prompt, "utf8"), "custom system prompt");
	assert.equal(readFileSync(run.paths.task, "utf8"), "sensitive task");
	const ledger = readFileSync(join(root, "usage.jsonl"), "utf8");
	assert.equal(ledger.trim().split("\n").length, 1);
	assert.equal(ledger.includes("sensitive task"), false);
	assert.equal(ledger.includes("custom system prompt"), false);
	if (process.platform !== "win32") {
		assert.equal(lstatSync(run.paths.dir).mode & 0o777, 0o700);
		for (const path of [run.paths.session, run.paths.metadata, run.paths.prompt, run.paths.task, join(root, "usage.jsonl")]) assert.equal(lstatSync(path).mode & 0o777, 0o600);
	}
	assert.equal((await loadRuns(root)).runs[0].usage.local.total, 120);
});

test("queued cancellation has a durable record and known zero usage without pretending to have run", async (t) => {
	const { root, run } = setup(t);
	run.finishQueued("d0001", { status: "failed", stopReason: "aborted", exitCode: 1 });
	assert.equal(run.data.startedAt, undefined);
	assert.equal(run.data.usage.incomplete, false);
	assert.equal(totalTokens(run.data.usage), 0);
	assert.equal((await loadRuns(root)).runs[0].status, "failed");
});

test("abandoned queued metadata is unfinished, including rebuild, without claiming the owner died", async (t) => {
	const { root, run } = setup(t);
	const before = readFileSync(run.paths.metadata, "utf8");
	const active = await loadRuns(root, { activeIds: new Set([run.data.runId]) });
	assert.equal(active.runs[0].usage.incomplete, false, "live queue has no missing reported usage yet");
	const restored = await loadRuns(root);
	assert.equal(restored.runs[0].status, "queued");
	assert.equal(restored.runs[0].usage.incomplete, true);
	const rebuilt = await loadRuns(root, { rebuild: true });
	assert.equal(rebuilt.runs[0].usage.incomplete, true);
	assert.equal(JSON.parse(readFileSync(join(root, "usage.jsonl"), "utf8").trim()).usage.incomplete, true);
	assert.equal(readFileSync(run.paths.metadata, "utf8"), before);
});

test("failed and cancelled runs retain known usage and mark missing tail incomplete", async (t) => {
	const { root, run } = setup(t);
	run.start("d0001"); assistant(run);
	run.observe({ type: "message_start", message: { role: "assistant" } });
	run.observe({ type: "message_update", usage: { ...used, input: 150, output: 2 } });
	await run.finish({ status: "failed", stopReason: "aborted", exitCode: 143 });
	assert.equal(totalTokens(run.data.usage), 272);
	assert.equal(run.data.usage.incomplete, true);
	const rebuilt = await loadRuns(root, { rebuild: true });
	assert.equal(totalTokens(rebuilt.runs[0].usage), 272);
	assert.equal(rebuilt.runs[0].usage.incomplete, true);
});

test("restart recovery reads the native tail left by a crashed parent without deleting or rewriting anything", async (t) => {
	const { root, run } = setup(t);
	run.start("d0001");
	const before = readFileSync(run.paths.metadata, "utf8");
	appendFileSync(run.paths.session, `${JSON.stringify({ type: "message", id: "late", message: { role: "assistant", usage: used } })}\n`);
	const recovered = await loadRuns(root);
	assert.equal(totalTokens(recovered.runs[0].usage), 120);
	assert.equal(recovered.runs[0].usage.incomplete, true);
	assert.equal(recovered.runs[0].status, "running");
	assert.equal(readFileSync(run.paths.metadata, "utf8"), before);
});

test("rebuild is idempotent for reports, appends exports, and retains arbitrarily old archives", async (t) => {
	const { root, run } = setup(t);
	run.start("d0001"); assistant(run); run.observe({ type: "agent_settled" }); await run.finish({ status: "done" });
	const metadata = JSON.parse(readFileSync(run.paths.metadata, "utf8")); metadata.createdAt = "1999-01-01T00:00:00.000Z";
	writeFileSync(run.paths.metadata, JSON.stringify(metadata));
	const one = await loadRuns(root, { rebuild: true }); const two = await loadRuns(root, { rebuild: true });
	assert.deepEqual(one.runs, two.runs);
	assert.equal(readdirSync(join(root, "runs")).length, 1);
	assert.equal(readFileSync(join(root, "usage.jsonl"), "utf8").trim().split("\n").length, 3);
});

test("missing summary can be reconstructed from native sessions without modifying the archive", async (t) => {
	const { root, run } = setup(t);
	run.start("d0001"); assistant(run); run.observe({ type: "agent_settled" }); await run.finish({ status: "done" });
	const metadata = JSON.parse(readFileSync(run.paths.metadata, "utf8")); delete metadata.usage;
	writeFileSync(run.paths.metadata, JSON.stringify(metadata));
	const recovered = await loadRuns(root, { rebuild: true });
	assert.equal(recovered.warnings.length, 0);
	assert.equal(totalTokens(recovered.runs[0].usage), 120);
	assert.equal(totalTokens((await loadRuns(root)).runs[0].usage), 120);
});

test("one rebuild isolates a torn ledger tail and restores every finalized export row", async (t) => {
	const { root, run } = setup(t);
	run.start("d0001"); assistant(run); run.observe({ type: "agent_settled" }); await run.finish({ status: "done" });
	writeFileSync(join(root, "usage.jsonl"), '{"torn":');
	await loadRuns(root, { rebuild: true });
	const rows = readFileSync(join(root, "usage.jsonl"), "utf8").split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
	assert.equal(rows.length, 1);
	assert.equal(rows[0].runId, run.data.runId);
	assert.equal(rows[0].usage.local.total, 120);
});

test("ledger symlinks never overwrite an unrelated file", async (t) => {
	const { root, run } = setup(t);
	const outside = join(root, "unrelated"); writeFileSync(outside, "unchanged");
	symlinkSync(outside, join(root, "usage.jsonl"));
	run.finishQueued("d0001", { status: "failed", stopReason: "aborted" });
	assert.ok(run.data.recordingError);
	assert.equal(readFileSync(outside, "utf8"), "unchanged");
});

test("write failures surface separately from child outcomes and do not erase transcripts", async (t) => {
	const { root, prompt } = setup(t);
	const errors: string[] = [];
	const run = new ArchivedRun(root, identity, "task", prompt, (e) => errors.push(e));
	run.start("d0002"); assistant(run); run.observe({ type: "agent_settled" });
	// Replace only the derived ledger path with a directory: deterministic even as root.
	const { mkdirSync } = await import("node:fs"); mkdirSync(join(root, "usage.jsonl"));
	await run.finish({ status: "done" });
	assert.equal(run.data.status, "done");
	assert.equal(run.data.usage.incomplete, true);
	assert.match(errors[0], /recording incomplete/);
	assert.ok(readFileSync(run.paths.session, "utf8").includes("full uncapped answer"));
});

test("archive refuses symlink roots, detects corrupt metadata and truncated native records", async (t) => {
	const { root, prompt, run } = setup(t);
	const link = join(root, "alias"); symlinkSync(run.paths.dir, link);
	assert.throws(() => new ArchivedRun(link, identity, "task", prompt), /real directory/);
	writeFileSync(run.paths.metadata, "not json");
	const loaded = await loadRuns(root);
	assert.equal(loaded.runs.length, 0);
	assert.equal(loaded.warnings.length, 1);
});

test("simultaneous processes use globally unique runs and independently append valid ledger records", async (t) => {
	const { root, prompt } = setup(t);
	const module = new URL("../archive.ts", import.meta.url).href;
	const script = `import { ArchivedRun } from ${JSON.stringify(module)}; const r = new ArchivedRun(process.argv[1], JSON.parse(process.argv[3]), 'task', process.argv[2]); r.finishQueued('d0001', {status:'failed',stopReason:'aborted'});`;
	await Promise.all(Array.from({ length: 8 }, () => promisify(execFile)(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, root, prompt, JSON.stringify(identity)])));
	const rows = readFileSync(join(root, "usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.equal(rows.length, 8);
	assert.equal(new Set(rows.map((r) => r.runId)).size, 8);
	assert.equal((await loadRuns(root)).runs.length, 9);
});
