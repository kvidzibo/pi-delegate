import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadDelegateConfig, mergeDelegateConfig } from "../config.ts";
import { DelegateService } from "../service.ts";
import { buildChildArgs } from "../spawn.ts";
import { prepareFullFiles, assertFilesUnchanged, type FileBundle, type FullFilesSpec } from "../full-files.ts";
import { parseDocsProposal } from "../docs-result.ts";

const delegateDir = dirname(dirname(fileURLToPath(import.meta.url)));

test("docs injects complete selected files with no tools/diff, validates proposals and refuses stale or unsafe sources", { timeout: 20000 }, async () => {
	const temp = mkdtempSync(join(tmpdir(), "delegate-docs-")), repo = join(temp, "repo");
	mkdirSync(repo);
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd: repo, encoding: "utf8" }).trim();
	git("init", "-qb", "main");
	const intro = "# Guide\n\n" + "Unchanged paragraph.\n".repeat(30);
	writeFileSync(join(repo, "README.md"), intro + "Old ending.\n");
	writeFileSync(join(repo, "deleted.md"), "Old guide\n");
	writeFileSync(join(repo, "stable.md"), "Not selected\n");
	git("add", "."); git("commit", "-qm", "base");
	const base = git("rev-parse", "HEAD");
	writeFileSync(join(repo, "README.md"), intro + "New ending.\n");
	writeFileSync(join(repo, "guide with spaces.md"), "# Extra\n\nComplete second document.\n");
	rmSync(join(repo, "deleted.md"));
	writeFileSync(join(repo, "private.txt"), "Not Markdown\n");
	git("add", "."); git("commit", "-qm", "docs");
	const head = git("rev-parse", "HEAD");
	writeFileSync(join(repo, "untracked.md"), "New local file\n");
	mkdirSync(join(repo, "generated")); writeFileSync(join(repo, "generated", "copy.md"), "Excluded\n");
	const shipped = loadDelegateConfig({ shippedPath: join(delegateDir, "config.json") });
	assert.deepEqual(shipped.agents.docs.tools, []);
	assert.throws(() => mergeDelegateConfig(shipped, { agents: { docs: { tools: ["read"] } } }, "bad"), /docs requires/);
	assert.throws(() => mergeDelegateConfig(shipped, { agents: { docs: { context: ["git-diff"] } } }, "bad"), /docs requires/);
	assert.throws(() => mergeDelegateConfig(shipped, { agents: { recon: { context: [{ source: "git-changed-files", include: ["../*"], content: "full", delivery: "inline" }] } } }, "bad"), /context/);
	const spec = shipped.agents.docs.context![0] as FullFilesSpec;
	const args = buildChildArgs({ model: "test/docs", thinking: "off", tools: [], promptPath: "prompt.md", sessionFile: "session.jsonl" });
	assert.ok(args.includes("--no-tools") && args.includes("--no-mcp"));
	assert.ok(!args.includes("--tools"));
	const config = mergeDelegateConfig(shipped, { agents: { docs: { model: "test/docs" }, recon: { model: "test/recon", context: [spec] } } }, "test");
	let calls = 0;
	let mode: "valid" | "invalid" | "stale" = "valid";
	const service = new DelegateService({
		workspace: repo, agentDir: join(temp, "agent"), config, promptDir: join(delegateDir, "prompts"),
		invocation: { command: "unused-offline-worker", args: [] }, leaseGuardPath: "unused",
		env: { ...process.env, PI_DELEGATE_ARCHIVE_DIR: join(temp, "archive"), PI_DELEGATE_LOG: "0" },
		childRunner: async input => {
			calls++;
			assert.ok(input.task.includes(JSON.stringify(intro + "New ending.\n")), "unchanged paragraphs are inline too");
			assert.ok(input.task.includes("Complete second document."));
			assert.ok(!input.task.includes("Not Markdown") && !input.task.includes("Not selected") && !input.task.includes("Excluded"));
			assert.ok(!input.task.includes("diff --git") && !input.task.includes("Automatic review diff"));
			if (input.model === "test/recon") return { text: "Context works for another role", exitCode: 0, stderrTail: "" };
			assert.deepEqual(input.tools, []);
			if (mode === "stale") writeFileSync(join(repo, "README.md"), "Concurrent edit\n");
			return { text: mode === "invalid" ? '{"files": [' : JSON.stringify({ files: [{ path: "README.md", content: intro + "Clear ending.\n" }], summary: ["Clarified ending"], concerns: [] }), exitCode: 0, stopReason: "stop", stderrTail: "" };
		},
	});
	try {
		assert.throws(() => service.start({ kind: "docs", task: "Polish docs", requestId: "no-base" }), /full base commit SHA/);
		const started = service.start({ kind: "docs", task: "Polish docs", requestId: "docs-1", base, head }).job;
		const done = (await service.status(started.jobId, 10000)).job;
		assert.equal(done.status, "done", done.answer);
		const archive = dirname(started.archive.sessionFile);
		const bundle: FileBundle = JSON.parse(readFileSync(join(archive, "files-context.json"), "utf8"));
		assert.deepEqual(bundle.files.map(f => f.path), ["README.md", "guide with spaces.md"]);
		assert.deepEqual(bundle.deleted, ["deleted.md"]);
		assert.equal(bundle.head, head);
		assert.equal(statSync(join(archive, "docs-proposal.json")).mode & 0o777, 0o600);
		assert.equal(JSON.parse(done.answer!).files[0].content, intro + "Clear ending.\n");
		assert.equal(readFileSync(join(repo, "README.md"), "utf8"), intro + "New ending.\n", "proposals never apply themselves");
		assert.equal(service.start({ kind: "docs", task: "Polish docs", requestId: "docs-1", base, head }).job.jobId, started.jobId);
		assert.throws(() => service.start({ kind: "docs", task: "Polish docs", requestId: "docs-1", base }), /different arguments/);
		assert.equal(calls, 1);
		for (const files of [[{ path: "../escape.md", content: "x" }], [{ path: "README.md", content: "" }], [{ path: "README.md", content: "x" }, { path: "README.md", content: "y" }], [{ path: "README.md", content: "\ud800" }]]) {
			assert.throws(() => parseDocsProposal(JSON.stringify({ files, summary: [], concerns: [] }), bundle, 10000));
		}
		assert.throws(() => parseDocsProposal(done.answer!, bundle, 10), /byte limit/);
		mode = "invalid";
		const invalid = service.start({ kind: "docs", task: "Polish docs", requestId: "invalid", base, head }).job;
		assert.equal((await service.status(invalid.jobId, 10000)).job.stopReason, "invalid-docs-result");
		mode = "stale";
		const stale = service.start({ kind: "docs", task: "Polish docs", requestId: "stale", base, head }).job;
		assert.equal((await service.status(stale.jobId, 10000)).job.stopReason, "invalid-docs-result");
		await assert.rejects(assertFilesUnchanged(bundle));
		writeFileSync(join(repo, "README.md"), intro + "New ending.\n");
		mode = "valid";
		const local = service.start({ kind: "docs", task: "Polish local docs", requestId: "local", base }).job;
		assert.equal((await service.status(local.jobId, 10000)).job.status, "done");
		const localBundle = JSON.parse(readFileSync(join(dirname(local.archive.sessionFile), "files-context.json"), "utf8"));
		assert.ok(localBundle.files.some((file: { path: string }) => file.path === "untracked.md"));
		const generic = service.start({ kind: "recon", task: "Inspect supplied docs", requestId: "generic", base, head }).job;
		assert.equal((await service.status(generic.jobId, 10000)).job.status, "done");
		const count = calls;
		const empty = service.start({ kind: "docs", task: "Nothing changed", requestId: "empty", base: head, head }).job;
		assert.equal((await service.status(empty.jobId, 10000)).job.status, "done");
		assert.equal(calls, count, "no model call for empty selection");
		const capture = (provider = spec) => {
			const archiveDir = mkdtempSync(join(temp, "capture-"));
			return prepareFullFiles({ cwd: repo, archiveDir, signal: new AbortController().signal, base, spec: provider });
		};
		await assert.rejects(capture({ ...spec, maxBytes: 10 }), /bounded|byte limit/);
		symlinkSync(join(temp, "secret"), join(repo, "link.md")); writeFileSync(join(temp, "secret"), "SECRET");
		await assert.rejects(capture(), /ELOOP/);
		rmSync(join(repo, "link.md"));
		writeFileSync(join(repo, "binary.md"), Buffer.from([0, 1]));
		await assert.rejects(capture(), /binary/);
	} finally { await service.shutdown(); rmSync(temp, { recursive: true, force: true }); }
});
