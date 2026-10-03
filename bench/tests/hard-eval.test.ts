import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { hardCases } from "../evals/hard-cases.ts";
import { hardSolutions, hardReconAnswer } from "./hard-solutions.ts";
import { planHistoricalEval, runHistoricalEval, inspectChanges, type HistoricalEvalOptions } from "../evals/runner.ts";

test("hard suite keeps stress oracles independent and detects incomplete solutions without model calls", async t => {
	const root = mkdtempSync("/tmp/hard-eval-"); t.after(() => rmSync(root, { recursive: true, force: true }));
	const repo = fileURLToPath(new URL("../../", import.meta.url));
	const options: HistoricalEvalOptions = { suite: "hard", out: join(root, "out"), budgetUsd: 0, env: {},
		arms: ["complete", "incomplete"].map(id => ({ id, model: "ollama/test", thinking: "off", contextWindow: 65536, maxTokens: 32768,
			prompts: { recon: join(repo, "delegate/prompts/recon.md"), implement: join(repo, "delegate/prompts/implement.md") } })) };
	assert.equal(planHistoricalEval(options).suite, "hard"); assert.equal(planHistoricalEval(options).runs, 6);
	assert.equal(planHistoricalEval({ ...options, suite: undefined }).runs, 12, "pilot remains the default");
	assert.throws(() => planHistoricalEval({ ...options, suite: "unknown" as any }), /Unknown evaluation suite/);
	assert.throws(() => planHistoricalEval({ ...options, caseIds: ["missing-directory"] }), /Unknown/);
	assert.equal(hardCases.length, 3);
	for (const c of hardCases) {
		assert.equal(c.origin.synthetic, true); assert.ok(c.origin.lessonIds?.length); assert.equal(c.origin.runId, undefined);
		for (const path of [...Object.keys(c.files), ...c.allowedChanges]) assert.ok(!path.startsWith("/") && !path.split("/").includes(".."));
		assert.ok(!JSON.stringify(c).includes("/home/"));
		if (c.testFile) {
			assert.ok(c.expectedTests!.length >= 4); assert.equal(new Set(c.expectedTests).size, c.expectedTests!.length);
			assert.ok(Object.hasOwn(c.files, c.testFile)); assert.ok(!c.allowedChanges.includes(c.testFile));
		}
	}
	const summary = await runHistoricalEval(options, async input => {
		const caseRoot = dirname(input.cwd), stem = basename(caseRoot), c = hardCases.find(c => stem.startsWith(c.id + "-r"))!;
		const complete = stem.endsWith("-complete");
		assert.equal(inspectChanges(caseRoot, c).changed.length, 0);
		assert.ok(input.task.includes("Do not read other runs or campaign artifacts"));
		writeFileSync(input.env.PI_DELEGATE_BENCH_BUDGET + ".state", JSON.stringify({ spentUsd: 0, reservedUsd: 0, requests: 0, pending: false }));
		await input.beforePrompt!(new AbortController().signal);
		if (complete) for (const [p, content] of Object.entries(hardSolutions[c.id] ?? {})) {
			const target = join(caseRoot, p); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content);
		}
		const text = complete && c.kind === "recon" ? hardReconAnswer : "Reported completion is not verification.";
		writeFileSync(input.env.PI_DELEGATE_BENCH_BUDGET + ".state", JSON.stringify({ spentUsd: 0, reservedUsd: 0, requests: 1, pending: false }));
		input.onEvent!({ type: "message_end", message: { role: "assistant", provider: "ollama", model: "test", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } } });
		input.onEvent!({ type: "agent_settled" });
		return { text, exitCode: 0, stopReason: "stop", stderrTail: "" };
	});
	assert.equal(summary.stopped, undefined);
	assert.deepEqual(summary.comparisons.map(c => [c.arm, c.runs, c.checksPassed]), [["complete", 3, 3], ["incomplete", 3, 0]]);
	for (const row of summary.results.filter(r => r.kind === "implement")) {
		assert.equal(row.validation.passed, row.arm === "complete");
		if (row.arm === "complete") assert.deepEqual([...row.validation.passedTests].sort(), [...hardCases.find(c => c.id === row.taskId)!.expectedTests!].sort());
	}
	const manifest = JSON.parse(readFileSync(join(options.out, "manifest.json"), "utf8"));
	assert.equal(manifest.suite, "hard"); assert.equal(manifest.frameworkHash.length, 64); assert.equal(manifest.nodeVersion, process.version);
});
