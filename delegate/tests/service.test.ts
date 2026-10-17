import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Accounting } from "../accounting.ts";
import { KINDS, loadDelegateConfig, mergeDelegateConfig } from "../config.ts";
import { JobScheduler } from "../jobs.ts";
import { DelegateService, enqueueDelegate } from "../service.ts";
import { savings } from "./calibration-fixtures.ts";

const delegateDir = dirname(dirname(fileURLToPath(import.meta.url)));
const shipped = () => loadDelegateConfig({ shippedPath: join(delegateDir, "config.json") });

test("all roles dispatch only the supplied task, even with retired context settings and no usable Git", async () => {
	const temp = mkdtempSync(join(tmpdir(), "delegate-task-")), repo = join(temp, "repo");
	mkdirSync(repo);
	writeFileSync(join(repo, ".git"), "gitdir: /missing/delegate-test\n");
	const config = mergeDelegateConfig(shipped(), { agents: Object.fromEntries(KINDS.map(kind =>
		[kind, { model: `test/${kind}`, context: ["git-diff"] }])) }, "legacy.json");
	const dispatched = new Map<string, string>();
	const service = new DelegateService({
		workspace: repo, agentDir: join(temp, "agent"), config, promptDir: join(delegateDir, "prompts"),
		invocation: { command: "unused-offline-worker", args: [] }, leaseGuardPath: "unused",
		env: { ...process.env, PATH: join(temp, "no-git"), PI_DELEGATE_ARCHIVE_DIR: join(temp, "archive"), PI_DELEGATE_LOG: "0" },
		childRunner: async input => {
			dispatched.set(input.sessionFile!, input.task);
			return { text: "mock complete", exitCode: 0, stderrTail: "" };
		},
	});
	try {
		for (const kind of KINDS) {
			const task = `${kind}: inspect only the supplied file paths.\nNo extra context.`;
			const job = service.start({ kind, task, requestId: kind }).job;
			assert.equal((await service.status(job.jobId, 10000)).job.status, "done");
			assert.equal(dispatched.get(job.archive.sessionFile), task);
			const archiveDir = dirname(job.archive.sessionFile);
			assert.equal(readFileSync(join(archiveDir, "task.md"), "utf8"), task);
			assert.ok(!existsSync(join(archiveDir, "review.diff")));
		}
	} finally {
		await service.shutdown();
		rmSync(temp, { recursive: true, force: true });
	}
});

test("dispatch rechecks host authorization after asynchronous snapshot preparation", async () => {
	const temp = mkdtempSync(join(tmpdir(), "delegate-dispatch-policy-"));
	const config = shipped();
	const accounting = new Accounting(join(temp, "archive"));
	const scheduler = new JobScheduler({ maxConcurrent: 1, maxLocalConcurrent: 1, maxQueued: 1 });
	const snapshot = savings();
	let authorized = true, launched = false, checked = false;
	try {
		const job = enqueueDelegate({
			scheduler, accounting, agent: config.agents.review, config,
			identity: { parentSessionId: "policy", toolCallId: "policy", kind: "review", cwd: temp, requestedModel: "test/review", thinking: "off", savings: snapshot },
			task: "Review", promptPath: join(delegateDir, "prompts/review.md"), timeoutMs: 10000, background: true,
			beforeRun: async () => { assert.ok(authorized); await Promise.resolve(); authorized = false; },
			beforeDispatch: archive => {
				checked = true;
				assert.deepEqual(archive.data.savings, snapshot);
				assert.equal(readFileSync(archive.paths.task, "utf8"), "Review");
				if (!authorized) throw new Error("Snapshot capture permission was revoked; delegate launch refused.");
			},
			childRunner: async () => { launched = true; throw new Error("must not launch"); },
		});
		const result = await scheduler.wait(job.id, { timeoutMs: 10000 });
		assert.equal(result.status, "failed");
		assert.match(result.answer ?? "", /permission was revoked/);
		assert.equal(checked, true); assert.equal(launched, false);
	} finally {
		await scheduler.shutdown(); accounting.close();
		rmSync(temp, { recursive: true, force: true });
	}
});
