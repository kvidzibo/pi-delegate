import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadDelegateConfig, mergeDelegateConfig } from "../config.ts";
import { DelegateService } from "../service.ts";
import { buildChildArgs } from "../spawn.ts";
import { loadRuns } from "../archive.ts";

const delegateDir = dirname(dirname(fileURLToPath(import.meta.url)));
const shipped = () => loadDelegateConfig({ shippedPath: join(delegateDir, "config.json") });

test("all roles dispatch only the supplied task, even with retired context settings and no usable Git", async () => {
	const temp = mkdtempSync(join(tmpdir(), "delegate-task-")), repo = join(temp, "repo");
	mkdirSync(repo);
	writeFileSync(join(repo, ".git"), "gitdir: /missing/delegate-test\n");
	const config = mergeDelegateConfig(shipped(), { agents: Object.fromEntries(Object.keys(shipped().agents).map(kind =>
		[kind, { model: `test/${kind}`, context: ["git-diff"] }])) }, "legacy.json");
	const dispatched = new Map<string, string>();
	const service = new DelegateService({
		workspace: repo, agentDir: join(temp, "agent"), config,
		invocation: { command: "unused-offline-worker", args: [] }, leaseGuardPath: "unused",
		env: { ...process.env, PATH: join(temp, "no-git"), PI_DELEGATE_ARCHIVE_DIR: join(temp, "archive"), PI_DELEGATE_LOG: "0" },
		childRunner: async input => {
			dispatched.set(input.sessionFile!, input.task);
			return { text: "mock complete", exitCode: 0, stderrTail: "" };
		},
	});
	try {
		for (const kind of Object.keys(config.agents)) {
			const task = `${kind}: inspect only the supplied file paths.\nNo extra context.`;
			const job = service.start({ kind, task, requestId: kind }).job;
			assert.equal((await service.status(job.jobId, 10000)).job.status, "done");
			assert.equal(dispatched.get(job.archive.sessionFile), task);
			const archiveDir = dirname(job.archive.sessionFile);
			assert.equal(readFileSync(join(archiveDir, "task.md"), "utf8"), task);
			assert.equal(readFileSync(join(archiveDir, "system-prompt.md"), "utf8"), config.agents[kind].prompt);
			assert.ok(!existsSync(join(archiveDir, "review.diff")));
		}
	} finally {
		await service.shutdown();
		rmSync(temp, { recursive: true, force: true });
	}
});

test("custom roles freeze configured prompts, default to all tools and require extension opt-in", async () => {
	const temp = mkdtempSync(join(tmpdir(), "delegate-role-"));
	const prompt = "  Custom system prompt.\nKeep exact whitespace.\n";
	const config = mergeDelegateConfig(shipped(), { maxConcurrent: 1, agents: {
		writer: { model: "test/writer", prompt },
	} }, "overlay.json");
	assert.deepEqual(config.agents.writer.tools, ["*"]);
	assert.equal(config.agents.writer.extensions, false);
	assert.equal(config.agents.writer.thinking, "off");
	const inputs: Array<{ task: string; prompt: string; args: string[] }> = [];
	let release: (() => void) | undefined;
	const service = new DelegateService({
		workspace: temp, agentDir: join(temp, "agent"), config,
		invocation: { command: "unused", args: [] }, leaseGuardPath: "unused", env: { PI_DELEGATE_LOG: "0" },
		childRunner: async input => {
			inputs.push({ task: input.task, prompt: readFileSync(input.promptSourcePath, "utf8"),
				args: buildChildArgs({ ...input, promptPath: input.promptSourcePath }) });
			if (input.task === "hold") await new Promise<void>(resolve => {
				release = resolve; input.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			return { text: "mock complete", exitCode: 0, stderrTail: "" };
		},
	});
	try {
		const held = service.start({ kind: "writer", task: "hold", requestId: "held" }).job;
		await service.status(held.jobId, 10);
		const queued = service.start({ kind: "writer", task: "queued", requestId: "queued" }).job;
		assert.equal(queued.status, "queued");
		const next = mergeDelegateConfig(config, { agents: { writer: {
			prompt: "New prompt", tools: [], extensions: true,
		} } }, "overlay.json");
		service.updateRoleSettings(next.agents);
		const fresh = service.start({ kind: "writer", task: "fresh", requestId: "fresh" }).job;
		assert.equal(service.start({ kind: "writer", task: "queued", requestId: "queued" }).job.jobId, queued.jobId);
		release!();
		for (const job of [held, queued, fresh]) assert.equal((await service.status(job.jobId, 10000)).job.status, "done");
		assert.deepEqual(inputs.map(input => input.prompt), [prompt, prompt, "New prompt"]);
		for (const input of inputs.slice(0, 2)) {
			assert.ok(input.args.includes("--no-extensions"));
			assert.equal(input.args[input.args.indexOf("--tools") + 1], "*");
		}
		assert.ok(!inputs[2].args.includes("--no-extensions"));
		assert.ok(inputs[2].args.includes("--no-tools"));
		for (const input of inputs) for (const flag of ["--no-skills", "--no-prompt-templates", "--no-context-files"]) assert.ok(input.args.includes(flag));
		const recovered = await loadRuns(join(temp, "agent", "delegate"));
		assert.equal(recovered.runs.length, 3);
		assert.ok(recovered.runs.every(run => run.kind === "writer"));
	} finally {
		release?.();
		await service.shutdown();
		rmSync(temp, { recursive: true, force: true });
	}
});
