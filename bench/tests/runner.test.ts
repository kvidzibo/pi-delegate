import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Budget, requestReservation, validBudgetState, type BudgetConfig } from "../budget.ts";
import { runCalibration, transcriptUsage, type BenchOptions } from "../runner.ts";
import { fixtureTasks, scoreAnswer, taskPrompt } from "../fixtures.ts";
import { key, pricing, tokens } from "../../delegate/tests/calibration-fixtures.ts";
import type { RunPiChildInput } from "../../child-runtime/spawn.ts";

const budgetConfig: BudgetConfig = { model: key.alternativeModel, thinking: "low", tools: ["read"], local: false, budgetUsd: 1, maxRequests: 4, contextWindow: 1000, maxTokens: 100, pricing };
function setup(t: any): BenchOptions {
	const dir = mkdtempSync(join(tmpdir(), "delegate-bench-test-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
	const promptPath = join(dir, "prompt.md"); writeFileSync(promptPath, "prompt");
	return { out: join(dir, "new"), budgetUsd: 1, repeats: 2, maxRequests: 4, timeoutMs: 1000, key, promptPath,
		guardPath: join(dir, "guard.ts"), env: {}, local: { id: key.localModel, contextWindow: 1000, maxTokens: 100 },
		alternative: { id: key.alternativeModel, contextWindow: 1000, maxTokens: 100, pricing } };
}
async function fakeChild(input: RunPiChildInput, mutate = false) {
	const budgetPath = input.env.PI_DELEGATE_BENCH_BUDGET!;
	const config: BudgetConfig = JSON.parse(readFileSync(budgetPath, "utf8"));
	const budget = new Budget(config);
	const persist = () => writeFileSync(budgetPath + ".state", JSON.stringify(budget.state));
	persist(); await input.beforePrompt!(new AbortController().signal);
	assert.ok(input.buildArgs(input.promptSourcePath).includes("-e"));
	assert.equal(input.env.PI_DELEGATE_CHILD, "1");
	assert.equal(input.env.PI_DELEGATE_LOG, "0");
	try {
		for (let i = 0; i < 2; i++) {
			budget.approve(input.model); persist();
			const usage = config.local ? tokens(100, 20, 100) : tokens(50, 10, 50);
			const m = { role: "assistant", provider: input.model.split("/")[0], model: input.model.split("/").slice(1).join("/"), timestamp: i, usage };
			input.onEvent?.({ type: "message_start", message: m });
			input.onEvent?.({ type: "message_update", message: m, usage });
			budget.settle(usage); persist();
			input.onEvent?.({ type: "message_end", message: m });
			input.onEvent?.({ type: "turn_end", message: m });
			input.onEvent?.({ type: "agent_end", messages: [m] });
		}
		input.onEvent?.({ type: "agent_settled" });
		const task = fixtureTasks.find(t => taskPrompt(t) === input.task)!;
		if (mutate) writeFileSync(join(input.cwd, "unwanted.txt"), "scope violation");
		return { text: JSON.stringify(task.expected), exitCode: 0, stderrTail: "", stopReason: "stop" };
	} catch (e) {
		budget.state.stopped = String(e); persist();
		return { text: "stopped", exitCode: 2, stderrTail: "", stopReason: "error" };
	}
}

test("budget reserves before calls, refunds only known usage, blocks unresolved usage/model changes/request caps", () => {
	const b = new Budget(budgetConfig); assert.equal(requestReservation(budgetConfig), 0.0035);
	b.approve(key.alternativeModel); assert.equal(b.state.reservedUsd, 0.0035);
	assert.throws(() => b.approve(key.alternativeModel), /unresolved/);
	assert.throws(() => b.settle({}), /Missing/); assert.equal(b.state.pending, true);
	b.settle(tokens(100, 10)); assert.equal(b.state.spentUsd, 0.0003); assert.equal(b.state.reservedUsd, 0);
	const limited = new Budget({ ...budgetConfig, maxRequests: 1 }); limited.approve(key.alternativeModel); limited.settle(tokens(1,1));
	assert.throws(() => limited.approve(key.alternativeModel), /request limit/);
	assert.throws(() => new Budget({ ...budgetConfig, budgetUsd: 0.001 }).approve(key.alternativeModel), /Insufficient/);
	assert.throws(() => new Budget(budgetConfig).approve("other/model"), /changed/);
	assert.throws(() => new Budget({ ...budgetConfig, pricing: undefined }), /pricing/);
});

test("32 mocked children create independent fixtures, raw evidence and a calibrated profile without model calls", async t => {
	const options = setup(t); let calls = 0;
	const result = await runCalibration(options, async input => { calls++; return fakeChild(input); });
	assert.equal(calls, 32); assert.equal(result.stopped, undefined); assert.equal(result.pairs.length, 16);
	const p = JSON.parse(readFileSync(join(options.out, "calibration.json"), "utf8"));
	assert.equal(p.promptRatio, 0.5); assert.equal(p.outputRatio, 0.5); assert.equal(p.acceptedPairs, 16);
	assert.ok(result.chargedUsd > 0); assert.equal(result.spendIncomplete, false);
	await assert.rejects(runCalibration(options, async () => { assert.fail("existing output must not launch children"); }), /EEXIST/);
});

test("invalid/missing budgets never launch children; budget guard failure stops campaign without publishing partial calibration", async t => {
	const options = setup(t);
	for (const budgetUsd of [0, -1, NaN, 0.00001]) await assert.rejects(runCalibration({ ...options, budgetUsd }, async () => { assert.fail("no calls"); }));
	const result = await runCalibration({ ...options, maxRequests: 1 }, input => fakeChild(input));
	assert.match(result.stopped!, /request limit/);
	assert.equal(existsSync(join(options.out, "calibration.json")), false);
	assert.equal(existsSync(join(options.out, "summary.json")), true);
});

test("scope violations/failed answers cannot calibrate; missing spend and cancellation stop safely", async t => {
	const options = setup(t);
	const result = await runCalibration(options, input => fakeChild(input, true));
	assert.match(result.stopped!, /successful/); assert.ok(result.pairs.every(p => !p.local.passed && !p.alternative.passed));
	const other = setup(t); let calls = 0;
	const failed = await runCalibration(other, async input => {
		calls++; if (input.model === key.alternativeModel) throw new Error("worker disappeared");
		return fakeChild(input);
	});
	assert.equal(failed.spendIncomplete, true); assert.ok(calls <= 2);
	const third = setup(t), abort = new AbortController(); abort.abort();
	const cancelled = await runCalibration({ ...third, signal: abort.signal }, async () => { assert.fail("no calls on abort"); });
	assert.ok(cancelled.stopped); assert.equal(cancelled.pairs.length, 0);
});

test("cancel during the last child retains its evidence but cannot publish calibration", async t => {
	const options = setup(t), control = new AbortController(); let calls = 0;
	const summary = await runCalibration({ ...options, signal: control.signal }, async input => {
		const result = await fakeChild(input);
		if (++calls === 32) control.abort();
		return result;
	});
	assert.equal(calls, 32); assert.match(summary.stopped!, /abort/i);
	assert.equal(existsSync(join(options.out, "calibration.json")), false);
	assert.equal(summary.pairs.length, 15);
});

test("malformed, stale-handshake and understated spend receipts stop rather than funding another arm", async t => {
	assert.equal(Number.isFinite(null), false); assert.equal(Number.isFinite(false), false);
	for (const patch of [{ spentUsd: null }, { spentUsd: false }, { requests: "2" }, { pending: null }, { pending: false, reservedUsd: 1 }]) {
		assert.equal(validBudgetState({ spentUsd: 0, reservedUsd: 0, requests: 2, pending: false, ...patch }, 4), false);
	}
	for (const patch of [{ spentUsd: null }, { spentUsd: 0, requests: 0 }, { spentUsd: 0 }]) {
		const options = setup(t); let calls = 0;
		const summary = await runCalibration(options, async input => {
			calls++; const result = await fakeChild(input);
			if (input.model === key.alternativeModel) {
				const path = input.env.PI_DELEGATE_BENCH_BUDGET! + ".state";
				writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...patch }));
			}
			return result;
		});
		assert.ok(calls <= 2); assert.ok(summary.stopped); assert.equal(summary.spendIncomplete, true);
		assert.equal(existsSync(join(options.out, "calibration.json")), false);
	}
});

test("strict scoring and full-usage parser reject malformed output, missing metadata and compaction", async t => {
	assert.equal(scoreAnswer(fixtureTasks[0], JSON.stringify(fixtureTasks[0].expected)), true);
	assert.equal(scoreAnswer(fixtureTasks[0], '```json\n{}\n```'), false);
	assert.equal(scoreAnswer(fixtureTasks[0], JSON.stringify({ ...fixtureTasks[0].expected, extra: true })), false);
	const options = setup(t), file = join(options.out, "../events.jsonl");
	writeFileSync(file, JSON.stringify({ type: "message_end", message: { role: "assistant", usage: tokens(1, 1) } }) + '\n' + JSON.stringify({ type: "agent_settled" }) + '\n');
	assert.equal((await transcriptUsage(file, key.localModel)).complete, false);
});
