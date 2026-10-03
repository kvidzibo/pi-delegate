import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, chmodSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { validateFixture } from "../evals/validation.ts";
import { historicalCases } from "../evals/cases.ts";
import { runHistoricalEval, planHistoricalEval, inspectChanges, type HistoricalEvalOptions } from "../evals/runner.ts";
import { requestReservation } from "../budget.ts";
import { priceTokens } from "../../delegate/calibration.ts";
import type { RunPiChildInput } from "../../child-runtime/spawn.ts";

// Offline oracle code for the four sanitized fixture contracts, not model answers or historical log dumps.
const solutions: Record<string, string> = {
	"missing-directory": 'export function archive(id) { return { id, status: "archived" }; }\n',
	"test-ownership": 'export function totalWithTax(subtotal, taxRate) { return subtotal * (1 + taxRate); }\n',
	"complete-deliverables": 'export function formatFilteredSaveFeedback(n) { return n === 0 ? "No matching items to save." : `Saved ${n} matching items.`; }\nexport function stateTooltip(s) { return s[0].toUpperCase() + s.slice(1); }\n',
	"isolated-cli-test": 'console.log(Number(process.argv[2]) * 2);\n',
};

test("historical evals compare fresh matched cases without model calls and retain scope, completion and budget evidence", async t => {
	const root = mkdtempSync("/tmp/historical-eval-"); t.after(() => rmSync(root, { recursive: true, force: true }));
	const repo = fileURLToPath(new URL("../../", import.meta.url));
	const options: HistoricalEvalOptions = { out: join(root, "out"), budgetUsd: 0, maxRequests: 2, env: {},
		arms: ["baseline", "candidate"].map(id => ({ id, model: "ollama/test", thinking: id === "baseline" ? "off" : "medium", contextWindow: 65536, maxTokens: 32768,
			prompts: { recon: join(repo, id === "baseline" ? "delegate/prompts" : "bench/evals/prompts", "recon.md"), implement: join(repo, id === "baseline" ? "delegate/prompts" : "bench/evals/prompts", "implement.md") } })) };
	assert.equal(historicalCases.length, 6);
	assert.equal(new Set(historicalCases.map(c => c.id)).size, 6);
	for (const c of historicalCases) {
		assert.match(c.origin.runId, /^[0-9a-f-]{36}$/);
		for (const path of [...Object.keys(c.files), ...c.allowedChanges, ...c.requiredChanges]) assert.ok(!path.startsWith("/") && !path.split("/").includes(".."));
		assert.ok(!c.testFile || (!c.allowedChanges.includes(c.testFile) && Object.hasOwn(c.files, c.testFile) && c.expectedTests?.length));
		assert.ok(!JSON.stringify(c).includes("/home/"), "fixtures contain no original private machine paths");
	}
	assert.equal(planHistoricalEval(options).runs, 12); assert.equal(existsSync(options.out), false);
	const cli = fileURLToPath(new URL("../evals/cli.ts", import.meta.url)), config = join(root, "config.json");
	writeFileSync(config, JSON.stringify(options));
	assert.equal(JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", cli, "--plan", config], { encoding: "utf8" })).runs, 12);
	assert.equal(existsSync(options.out), false, "planning must not create artifacts or launch workers");
	assert.throws(() => planHistoricalEval({ ...options, arms: [options.arms[0], options.arms[0]] }), /duplicate/);
	assert.throws(() => planHistoricalEval({ ...options, caseIds: ["unknown"] }), /Unknown/);
	assert.throws(() => planHistoricalEval({ ...options, timeoutMs: 2147483648 }), /Invalid/);
	assert.throws(() => planHistoricalEval({ ...options, out: join(repo, "eval-output") }), /outside/);
	assert.throws(() => planHistoricalEval({ ...options, out: join(repo, "..eval-output") }), /outside/);

	const seen: string[] = [];
	async function mock(input: RunPiChildInput, modify = true) {
		const task = historicalCases.find(c => basename(dirname(input.cwd)).startsWith(`${c.id}-r`))!;
		const arm = basename(dirname(input.cwd)).endsWith("-candidate") ? "candidate" : "baseline";
		seen.push(`${task.id}:${arm}`);
		const args = input.buildArgs(input.promptSourcePath), budget = JSON.parse(readFileSync(input.env.PI_DELEGATE_BENCH_BUDGET!, "utf8"));
		assert.ok(args.includes("--no-approve")); assert.ok(args.includes("--no-context-files"));
		assert.match(args.at(-1)!, /bench\/guard\.ts$/);
		assert.equal(args[args.indexOf("--thinking") + 1], budget.thinking);
		assert.equal(args[args.indexOf("--tools") + 1].includes("write"), task.kind === "implement");
		assert.equal(input.env.PI_DELEGATE_CHILD, "1");
		writeFileSync(`${input.env.PI_DELEGATE_BENCH_BUDGET}.state`, JSON.stringify({ spentUsd: 0, reservedUsd: 0, requests: 0, pending: false }));
		await input.beforePrompt!(new AbortController().signal);
		const caseRoot = dirname(input.cwd);
		assert.ok(input.task.includes(`Current working directory: ${input.cwd}`));
		assert.ok(input.task.includes(`Case root: ${caseRoot}`));
		assert.ok(input.task.includes("relative to the case root, not cwd"));
		assert.equal(inspectChanges(caseRoot, task).changed.length, 0, "every arm starts from the identical clean fixture");
		if (modify && arm === "candidate" && task.kind === "implement") {
			const file = join(caseRoot, task.requiredChanges[0]); mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, solutions[task.id]);
			if (task.id === "missing-directory") writeFileSync(join(input.cwd, "unexpected.txt"), "scope violation");
			if (task.id === "complete-deliverables") writeFileSync(file, solutions[task.id].replace('return s[0].toUpperCase() + s.slice(1)', 'return s'));
		}
		const text = arm === "candidate" ? (task.evidence?.join("\n") ?? "Completed all requirements. Tests passed.") : "No supporting evidence; stopped.";
		const tokens = { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, total: 3 };
		const cost = budget.local ? 0 : priceTokens(tokens, budget.pricing);
		writeFileSync(`${input.env.PI_DELEGATE_BENCH_BUDGET}.state`, JSON.stringify({ spentUsd: cost, reservedUsd: 0, requests: 1, pending: false }));
		writeFileSync(args[args.indexOf("--session") + 1], '{"type":"session","version":3}\n');
		input.onEvent?.({ type: "tool_execution_start", toolName: "read", args: { path: "source" } });
		const [provider, ...model] = input.model.split("/");
		input.onEvent?.({ type: "message_end", message: { role: "assistant", provider, model: model.join("/"), usage: tokens, content: [{ type: "text", text }] } });
		input.onEvent?.({ type: "agent_settled" });
		return { text, exitCode: 0, stopReason: "stop", stderrTail: "" };
	}
	const result = await runHistoricalEval(options, mock);
	assert.equal(result.stopped, undefined); assert.equal(result.results.length, 12);
	assert.deepEqual(seen.slice(0, 4), ["missing-directory:baseline", "missing-directory:candidate", "test-ownership:candidate", "test-ownership:baseline"]);
	assert.deepEqual(result.comparisons.map(c => [c.arm, c.runs, c.checksPassed, c.workerCompleted]), [["baseline", 6, 0, 6], ["candidate", 6, 4, 6]]);
	const partial = result.results.find(r => r.taskId === "complete-deliverables" && r.arm === "candidate")!;
	assert.equal(partial.workerCompleted, true); assert.equal(partial.validation.passed, false); assert.equal(partial.checksPassed, false);
	assert.equal(partial.assessment, "manual-review-required", "a report claiming completion is not a correctness verdict");
	const scope = result.results.find(r => r.taskId === "missing-directory" && r.arm === "candidate")!;
	assert.deepEqual(scope.changes.unexpected, ["workspace/unexpected.txt"]); assert.equal(scope.validation.ran, false);
	assert.ok(result.results.every(r => r.receiptComplete && existsSync(r.eventsPath) && existsSync(r.sessionFile)));
	const manifest = readFileSync(join(options.out, "manifest.json"), "utf8");
	assert.equal(JSON.parse(manifest).suiteHash.length, 64); assert.ok(!manifest.includes('"env"'));
	await assert.rejects(runHistoricalEval(options, mock), /EEXIST/);

	// Detect readonly test tampering and symlink replacement before executing fixture code.
	const task = historicalCases.find(c => c.id === "test-ownership")!, specimen = join(root, "tampered");
	for (const [p, text] of Object.entries(task.files)) { const target = join(specimen, p); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, text); }
	writeFileSync(join(specimen, task.testFile!), "process.exit(0)");
	assert.deepEqual(inspectChanges(specimen, task).unexpected, [task.testFile]);
	rmSync(join(specimen, "workspace/src/value.mjs")); symlinkSync(join(specimen, task.testFile!), join(specimen, "workspace/src/value.mjs"));
	assert.match(inspectChanges(specimen, task).error!, /symlink/);

	const pricing = { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 };
	const hosted: HistoricalEvalOptions = { ...options, out: join(root, "hosted"), budgetUsd: 1, caseIds: ["cross-repo-path"],
		arms: options.arms.map(a => ({ ...a, model: "openai-codex/test", pricing })) };
	const priced = await runHistoricalEval(hosted, input => mock(input, false));
	assert.equal(priced.stopped, undefined); assert.equal(priced.spendIncomplete, false); assert.ok(priced.spentUsd > 0);
	assert.throws(() => planHistoricalEval({ ...hosted, budgetUsd: 0 }), /reservation/);
	assert.throws(() => planHistoricalEval({ ...hosted, arms: hosted.arms.map(a => ({ ...a, pricing: undefined })) }), /pricing/);
	const uncertain = await runHistoricalEval({ ...hosted, out: join(root, "uncertain") }, async input => {
		const config = JSON.parse(readFileSync(input.env.PI_DELEGATE_BENCH_BUDGET!, "utf8"));
		writeFileSync(`${input.env.PI_DELEGATE_BENCH_BUDGET}.state`, JSON.stringify({ spentUsd: 0, reservedUsd: requestReservation(config), requests: 1, pending: true }));
		return { text: "Interrupted", exitCode: 1, stopReason: "error", stderrTail: "" };
	});
	assert.equal(uncertain.results.length, 1); assert.equal(uncertain.spendIncomplete, true); assert.ok(uncertain.stopped); assert.ok(uncertain.spentUsd > 0);
	assert.equal(uncertain.results[0].checksPassed, false);

	const abort = new AbortController();
	const cancelled = await runHistoricalEval({ ...options, out: join(root, "cancelled"), signal: abort.signal }, async input => { const r = await mock(input, false); abort.abort(); return r; });
	assert.equal(cancelled.results.length, 1); assert.ok(cancelled.stopped); assert.ok(existsSync(join(root, "cancelled/summary.json")));

	// A zero exit without the independent assertions is not a passing fixture.
	const bypassed = await runHistoricalEval({ ...options, out: join(root, "early-exit"), caseIds: ["test-ownership"] }, async input => {
		const r = await mock(input, false);
		writeFileSync(join(input.cwd, "src/value.mjs"), "process.exit(0);\nexport function totalWithTax(){return -999;}\n");
		return r;
	});
	assert.equal(bypassed.stopped, undefined);
	for (const row of bypassed.results) {
		assert.equal(row.workerCompleted, true); assert.equal(row.validation.exitCode, 0);
		assert.equal(row.validation.passed, false); assert.equal(row.validation.cause, "missing-expected-tests");
		assert.equal(row.checksPassed, false);
	}

	// Exercise the real --run entrypoint/native RPC runner through an owned fake `pi` executable.
	// No model or network calls: this catches recursive eval-CLI launching hidden by injected workers.
	const bin = join(root, "bin"); mkdirSync(bin);
	const fakePi = join(bin, "pi");
	writeFileSync(fakePi, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const budget = process.env.PI_DELEGATE_BENCH_BUDGET;
const args = process.argv.slice(2), session = args[args.indexOf('--session') + 1];
writeFileSync(budget+'.state', JSON.stringify({spentUsd:0,reservedUsd:0,requests:0,pending:false}));
writeFileSync(session, '{"type":"session","version":3}\\n');
const lines = createInterface({input:process.stdin});
lines.on('line', line => {
 const command = JSON.parse(line); if(command.type !== 'prompt') return;
 writeFileSync(budget+'.state', JSON.stringify({spentUsd:0,reservedUsd:0,requests:1,pending:false}));
 const message = {role:'assistant',provider:'ollama',model:'test',stopReason:'stop',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,total:2},content:[{type:'text',text:'related/settings/tests/load.test.ts related/settings/package.json node --experimental-strip-types --test tests/load.test.ts'}]};
 for(const e of [{type:'response',command:'prompt',success:true,id:command.id},{type:'message_end',message},{type:'agent_settled'}]) console.log(JSON.stringify(e));
});
`); chmodSync(fakePi, 0o700);
	const native = { ...options, out: join(root, "native"), caseIds: ["cross-repo-path"] };
	writeFileSync(config, JSON.stringify(native));
	const launched = JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", cli, "--run", config], {
		encoding: "utf8", timeout: 15000, env: { PATH: `${bin}:${dirname(process.execPath)}`, HOME: root, USERPROFILE: root },
	}));
	assert.equal(launched.stopped, undefined); assert.deepEqual(launched.comparisons.map((r: any) => r.checksPassed), [1, 1]);
	const nativeRows = JSON.parse(readFileSync(join(native.out, "summary.json"), "utf8")).results;
	assert.ok(nativeRows.every((r: any) => r.invocation.command === "pi" && r.invocation.args[0] === "--mode"));

	// Real Node test workers spawn a hanging CLI with detached stdio; timeout and abort kill the owned group.
	for (const mode of ["timeout", "abort"]) {
		const specimen = join(root, mode), pidFile = join(specimen, "pids.json"); mkdirSync(join(specimen, "workspace/tests"), { recursive: true });
		const testFile = "workspace/tests/hanging.test.mjs";
		writeFileSync(join(specimen, testFile), `import {spawn} from 'node:child_process';import{writeFileSync}from'node:fs';
const cli=spawn(process.execPath,['-e','setInterval(()=>{},1000)',${JSON.stringify(specimen)}],{stdio:'ignore'});
writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({pid:cli.pid,worker:process.pid}));await new Promise(()=>{});\n`);
		const controller = new AbortController();
		const validation = validateFixture(specimen, { ...task, testFile }, join(specimen, "home"), controller.signal, mode === "timeout" ? 1000 : 2500);
		try {
			for (let i = 0; i < 60 && !existsSync(pidFile); i++) await delay(25);
			assert.ok(existsSync(pidFile), "hanging fixture started before the lifecycle assertion");
			if (mode === "abort") controller.abort();
			const result = await validation;
			assert.equal(result.passed, false); assert.equal(result.exitCode, null); assert.equal(result.signal, "SIGKILL");
			assert.equal(result.cause, mode === "abort" ? "aborted" : "timeout"); assert.equal(result.cleanupError, undefined);
			const pid = JSON.parse(readFileSync(pidFile, "utf8")).pid;
			let live = true;
			for (let i = 0; i < 40 && live; i++) {
				try { process.kill(pid, 0); live = process.platform !== "linux" || !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { live = false; }
				if (live) await delay(25);
			}
			assert.equal(live, false, "validation must not leave an executing CLI descendant");
		} finally {
			controller.abort(); await validation;
			if (existsSync(pidFile)) for (const pid of Object.values(JSON.parse(readFileSync(pidFile, "utf8"))) as number[]) {
				try { if (process.platform === "linux" && readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(specimen)) process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
			}
		}
	}
});
