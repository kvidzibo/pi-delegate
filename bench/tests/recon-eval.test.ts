import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { runReconEval, type ReconEvalOptions } from "../recon-eval.ts";

test("evaluation separates completion from evidence checks and retains boundary/mutation failures", async t => {
	const root = mkdtempSync("/tmp/recon-eval-"); t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const name of ["baseline", "candidate"]) writeFileSync(join(root, name), `prompt ${name}`);
	const options: ReconEvalOptions = { out: join(root, "out"), baselinePromptPath: join(root, "baseline"), candidatePromptPath: join(root, "candidate"),
		model: "ollama/test", contextWindow: 65536, maxTokens: 32768, env: {}, maxRequests: 2 };
	let n = 0;
	const summary = await runReconEval(options, async input => {
		n++;
		assert.equal(input.env.PI_DELEGATE_CHILD, "1");
		const args = input.buildArgs(input.promptSourcePath);
		assert.ok(args.includes("read,grep,find,ls,bash"));
		assert.equal(args[args.indexOf("--thinking") + 1], "off");
		assert.match(args.at(-1)!, /bench\/guard\.ts$/);
		assert.ok(input.beforePrompt);
		const sessionFile = args[args.indexOf("--session") + 1];
		writeFileSync(sessionFile, '{"type":"session","version":3}\n');
		writeFileSync(`${input.env.PI_DELEGATE_BENCH_BUDGET}.state`, JSON.stringify({ spentUsd: 0, reservedUsd: 0, requests: 1, pending: false }));
		const web = basename(input.cwd).startsWith("web-unavailable");
		input.onEvent?.({ type: "tool_execution_start", toolName: web ? "bash" : "read", args: { path: "src/cache.js" } });
		if (n === 1) writeFileSync(join(input.cwd, "unexpected"), "changed");
		const text = n === 1 ? "src/cache.js:1 CACHE_TTL_SECONDS defaults to 90" : "No supporting facts";
		input.onEvent?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
		return { text, exitCode: 0, stderrTail: "", stopReason: n === 2 ? "length" : "stop" };
	});
	const records: any[] = summary.results;
	assert.equal(n, 8, "maxRequests is per model run, not a mislabeled task limit");
	assert.equal(summary.stopped, undefined);
	assert.deepEqual(records.map(r => r.arm), ["baseline", "candidate", "candidate", "baseline", "baseline", "candidate", "candidate", "baseline"]);
	assert.equal(records[0].workerCompleted, true); assert.equal(records[0].assessment, "manual-review-required");
	assert.equal(records[0].automaticChecks.expectedFactsPresent, true); assert.equal(records[0].automaticChecks.fixtureUnchanged, false);
	assert.equal(records[1].workerCompleted, false); assert.equal(records[1].automaticChecks.expectedFactsPresent, false);
	assert.equal(records[1].automaticChecks.fixtureUnchanged, true);
	assert.equal(records[6].automaticChecks.prohibitedToolCalls, 1);
	assert.equal(records[0].toolCalls, 1); assert.equal(records[0].receiptComplete, true);
	assert.ok(records[0].elapsedMs >= 0); assert.ok(records[0].answerWords > 0);
	assert.ok(existsSync(records[0].eventsPath)); assert.ok(existsSync(records[0].sessionFile));
	assert.equal(JSON.parse(readFileSync(join(options.out, "summary.json"), "utf8")).results.length, 8);
	await assert.rejects(runReconEval({ ...options, model: "openai/gpt" }), /Invalid/);
	await assert.rejects(runReconEval(options), /EEXIST/);
});
