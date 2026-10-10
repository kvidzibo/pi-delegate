import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadDelegateConfig, mergeDelegateConfig, resolveAgent } from "../config.ts";
import { DelegateService } from "../service.ts";

const delegateDir = dirname(dirname(fileURLToPath(import.meta.url)));
const shipped = () => loadDelegateConfig({ shippedPath: join(delegateDir, "config.json") });

test("context lists inherit, replace, deduplicate and validate independently of role/model/tools", () => {
	const base = shipped();
	assert.deepEqual(base.agents.review.context, ["git-diff"]);
	assert.deepEqual(base.agents.recon.context, []);
	const config = mergeDelegateConfig(base, { agents: {
		review: { context: [] }, recon: { context: ["git-diff", "git-diff"] },
	} }, "overlay");
	assert.deepEqual(config.agents.review.context, []);
	assert.deepEqual(config.agents.recon.context, ["git-diff"]);
	assert.deepEqual(resolveAgent("recon", "test/override", config).agent.tools, base.agents.recon.tools);
	assert.deepEqual(resolveAgent("recon", "test/override", config).agent.context, ["git-diff"]);
	assert.deepEqual(mergeDelegateConfig(config, { agents: { recon: { thinking: "high" } } }, "overlay").agents.recon.context, ["git-diff"]);
	for (const context of [null, false, "git-diff", ["unknown"], [{}], ["git-diff", null]]) {
		assert.throws(() => mergeDelegateConfig(base, { agents: { recon: { context } } }, "bad"), /context.*array of git-diff/);
	}
});

test("shared dispatch routes configured context on any role and freezes accepted lists", { timeout: 15000 }, async () => {
	const temp = mkdtempSync(join(tmpdir(), "delegate-context-")), repo = join(temp, "repo");
	mkdirSync(repo);
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd: repo, encoding: "utf8" });
	git("init", "-qb", "main"); git("commit", "--allow-empty", "-qm", "base");
	const config = mergeDelegateConfig(shipped(), { maxConcurrent: 1, agents: {
		review: { context: [], model: "test/review" }, recon: { context: ["git-diff"], tools: ["read"], model: "test/recon" }, oracle: { model: "test/oracle" },
	} }, "test");
	let release!: () => void;
	const dispatched = new Map<string, { task: string; tools: string[] }>();
	const service = new DelegateService({
		workspace: repo, agentDir: join(temp, "agent"), config, promptDir: join(delegateDir, "prompts"), allowModelOverride: true,
		invocation: { command: "unused-offline-worker", args: [] }, leaseGuardPath: "unused",
		env: { ...process.env, PI_DELEGATE_ARCHIVE_DIR: join(temp, "archive"), PI_DELEGATE_LOG: "0" },
		childRunner: async input => {
			dispatched.set(input.sessionFile!, { task: input.task, tools: input.tools });
			if (input.task === "hold") await new Promise<void>(resolve => { release = resolve; input.signal?.addEventListener("abort", () => resolve(), { once: true }); });
			return { text: "mock complete", exitCode: 0, stderrTail: "" };
		},
	});
	try {
		service.start({ kind: "oracle", task: "hold", requestId: "hold" });
		const review = service.start({ kind: "review", task: "Review without context", requestId: "review" }).job;
		const recon = service.start({ kind: "recon", task: "Map changes", requestId: "recon", model: "test/override" }).job;
		assert.equal(recon.status, "queued");
		config.agents.recon.context!.length = 0; // Accepted jobs must detach arrays from their source config.
		const changed = mergeDelegateConfig(config, { agents: { review: { context: ["git-diff"] } } }, "changed");
		service.updateRoleSettings(changed.agents);
		changed.agents.review.context!.length = 0; // The host's current settings must also be detached.
		const updated = service.start({ kind: "review", task: "Review with context", requestId: "updated" }).job;
		writeFileSync(join(repo, "late.txt"), "state at dispatch\n");
		release();
		for (const job of [review, recon, updated]) assert.equal((await service.status(job.jobId, 10000)).job.status, "done");
		const plain = dispatched.get(review.archive.sessionFile)!;
		assert.equal(plain.task, "Review without context");
		assert.ok(!existsSync(join(dirname(review.archive.sessionFile), "review.diff")));
		for (const job of [recon, updated]) {
			const actual = dispatched.get(job.archive.sessionFile)!;
			const dir = dirname(job.archive.sessionFile);
			assert.ok(actual.task.includes(JSON.stringify(join(dir, "review.diff"))));
			assert.match(readFileSync(join(dir, "review.diff"), "utf8"), /state at dispatch/);
			assert.equal(readFileSync(join(dir, "task.md"), "utf8"), actual.task);
		}
		assert.deepEqual(dispatched.get(recon.archive.sessionFile)!.tools, ["read"]);
		assert.equal(service.start({ kind: "recon", task: "Map changes", requestId: "recon", model: "test/override" }).reused, true);
		assert.equal(dispatched.size, 4, "retry must not recapture or relaunch");
		git("branch", "-m", "feature"); // No main/master: capture must fail for opted-in roles, but not opt-outs.
		const optedOut = service.start({ kind: "recon", task: "No context now", requestId: "opted-out" }).job;
		assert.equal((await service.status(optedOut.jobId, 10000)).job.status, "done");
		assert.equal(dispatched.get(optedOut.archive.sessionFile)!.task, "No context now");
		const failed = service.start({ kind: "review", task: "Missing base", requestId: "failed" }).job;
		assert.equal((await service.status(failed.jobId, 10000)).job.status, "failed");
		assert.equal(dispatched.size, 5);
	} finally {
		await service.shutdown();
		rmSync(temp, { recursive: true, force: true });
	}
});
