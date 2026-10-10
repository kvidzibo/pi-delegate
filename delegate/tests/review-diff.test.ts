import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadDelegateConfig, mergeDelegateConfig } from "../config.ts";
import { prepareReviewTask } from "../review-diff.ts";
import { DelegateService } from "../service.ts";

const delegateDir = dirname(dirname(fileURLToPath(import.meta.url)));

test("review dispatch supplies the complete private Git diff without bash and fails closed on capture errors", { timeout: 20000 }, async () => {
	const temp = mkdtempSync(join(tmpdir(), "delegate-review-diff-"));
	const repo = join(temp, "repo"), agentDir = join(temp, "agent");
	mkdirSync(repo); mkdirSync(join(repo, "sub"));
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd: repo, encoding: "utf8" });
	git("init", "-q", "-b", "main");
	writeFileSync(join(repo, "tracked.txt"), "base\n");
	writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
	writeFileSync(join(repo, ".gitattributes"), "tracked.txt filter=probe\n");
	git("add", "."); git("commit", "-qm", "base");
	const base = git("rev-parse", "HEAD").trim();
	git("switch", "-qc", "feature");
	writeFileSync(join(repo, "committed.txt"), "committed change\n");
	git("add", "."); git("commit", "-qm", "feature");
	writeFileSync(join(repo, "staged.txt"), "staged change\n"); git("add", "staged.txt");
	writeFileSync(join(repo, "tracked.txt"), "unstaged change\n");
	writeFileSync(join(repo, "ignored.txt"), "must not be captured\n");
	writeFileSync(join(repo, "binary.dat"), Buffer.from([0, 1, 2, 255]));
	writeFileSync(join(repo, "odd\nname.txt"), "untracked odd filename\n");
	symlinkSync("ignored.txt", join(repo, "link"));
	chmodSync(join(repo, "tracked.txt"), 0o755);
	const config = mergeDelegateConfig(loadDelegateConfig({ shippedPath: join(delegateDir, "config.json") }), {
		maxConcurrent: 1, agents: { implement: { enabled: false }, review: { model: "test/review" }, oracle: { model: "test/oracle" } },
	}, "test");
	let release!: () => void;
	const launched: { task: string; tools: string[]; cwd?: string }[] = [];
	const service = new DelegateService({
		workspace: repo, agentDir, config, promptDir: join(delegateDir, "prompts"),
		invocation: { command: "unused-offline-worker", args: [] }, leaseGuardPath: "unused", allowModelOverride: true,
		env: { ...process.env, PI_DELEGATE_ARCHIVE_DIR: join(agentDir, "archive"), PI_DELEGATE_LOG: "0", GIT_DIR: "/invalid/inherited/git-dir" },
		childRunner: async input => {
			launched.push({ task: input.task, tools: input.tools, cwd: input.cwd });
			if (input.task === "hold") await new Promise<void>(resolve => { release = resolve; input.signal?.addEventListener("abort", () => resolve(), { once: true }); });
			return { text: "offline result", exitCode: 0, stopReason: "stop", stderrTail: "" };
		},
	});
	try {
		assert.throws(() => service.start({ kind: "implement", task: "disabled", requestId: "disabled", model: "test/override" }), /implement is disabled/);
		assert.equal(service.list().jobs.length, 0);
		const held = service.start({ kind: "oracle", task: "hold", requestId: "held" }).job;
		const review = service.start({ kind: "review", task: "Review all changes", cwd: "sub", requestId: "review" }).job;
		assert.equal(review.status, "queued");
		writeFileSync(join(repo, "late.txt"), "capture at dispatch, not acceptance\n");
		const beforeStatus = git("status", "--porcelain=v1", "-z");
		const beforeIndex = readFileSync(join(repo, ".git", "index"));
		const filterMarker = join(temp, "filter-ran");
		git("config", "filter.probe.clean", `touch '${filterMarker}'; cat`);
		git("config", "filter.probe.required", "true");
		await service.status(held.jobId, 0);
		release();
		const completed = (await service.status(review.jobId, 10000)).job;
		assert.equal(completed.status, "done", completed.answer);
		const child = launched[1];
		assert.deepEqual(child.tools, ["read", "grep", "find", "ls"]);
		assert.equal(child.cwd, join(repo, "sub"));
		const archiveDir = dirname(review.archive.sessionFile), diffPath = join(archiveDir, "review.diff");
		assert.ok(child.task.includes(JSON.stringify(diffPath)));
		assert.match(child.task, new RegExp(`merge base ${base}`));
		assert.equal(readFileSync(join(archiveDir, "task.md"), "utf8"), child.task);
		assert.equal(statSync(diffPath).mode & 0o777, 0o600);
		const diff = readFileSync(diffPath, "utf8");
		for (const text of ["committed change", "staged change", "unstaged change", "untracked odd filename", "capture at dispatch", "GIT binary patch", "new file mode 120000", "new mode 100755"]) assert.ok(diff.includes(text), text);
		assert.ok(!diff.includes("must not be captured"));
		assert.deepEqual(readFileSync(join(repo, ".git", "index")), beforeIndex);
		assert.ok(!existsSync(filterMarker), "Git clean filters must not execute during capture");
		git("config", "--remove-section", "filter.probe");
		assert.equal(git("status", "--porcelain=v1", "-z"), beforeStatus);
		assert.equal(service.start({ kind: "review", task: "Review all changes", cwd: "sub", requestId: "review" }).reused, true);
		assert.equal(launched.length, 2);

		git("branch", "-D", "main");
		const refused = service.start({ kind: "review", task: "No base", requestId: "no-base" }).job;
		const failed = (await service.status(refused.jobId, 10000)).job;
		assert.equal(failed.status, "failed");
		assert.match(failed.answer ?? "", /requires main\/master/);
		assert.equal(launched.length, 2, "capture failure must never invoke the child");
		assert.ok(!existsSync(join(dirname(refused.archive.sessionFile), "review.diff")));
		const signal = new AbortController().signal;
		assert.match(await prepareReviewTask("Outside Git", temp, temp, signal), /outside a Git checkout/);
		git("branch", "main", base);
		mkdirSync(join(repo, "archive"));
		await assert.rejects(prepareReviewTask("Unsafe archive", repo, join(repo, "archive"), signal), /outside the checkout/);
		const cancelled = new AbortController(); cancelled.abort();
		await assert.rejects(prepareReviewTask("Cancelled", repo, temp, cancelled.signal), /abort/i);
	} finally {
		await service.shutdown();
		rmSync(temp, { recursive: true, force: true });
	}
});
