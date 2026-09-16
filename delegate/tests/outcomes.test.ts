import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ResponseEvidence } from "../../child-runtime/evidence.ts";
import type { ChildResult } from "../../child-runtime/spawn.ts";
import { copyOutcome, describeOutcome, outcomeContent, type ExecutionOutcome } from "../outcomes.ts";
import { ArchivedRun, loadRuns } from "../archive.ts";
import { JobCards, CARD_STATE_TYPE } from "../cards.ts";
import { describeCapabilities } from "../capabilities.ts";
import { JobScheduler } from "../jobs.ts";
import { buildNotifyPayload } from "../notify.ts";
import { statsReport } from "../stats.ts";

const evidence = (): ResponseEvidence => ({ source: "rpc", taskSent: true, agentSettled: true, finalizedMessages: 3,
	retainedResponses: 2, omittedPhases: 0, unansweredWrap: false, openResponse: false, partialResponseRetained: false });

test("execution outcomes distinguish worker failures, cancellation and limits without judging tasks", () => {
	for (const [stopReason, limit] of [["length", "output-token-limit"], ["execution_budget", "execution-budget"],
		["context_budget", "context-budget"], ["hard_timeout", "hard-timeout"], ["finalization_timeout", "finalization-timeout"]]) {
		const outcome = describeOutcome({ status: "failed", stopReason, evidence: evidence() });
		assert.equal(outcome.execution, "limited"); assert.deepEqual(outcome.limitations, [limit]);
		assert.equal(outcome.taskAssessment, "not-performed"); assert.deepEqual(copyOutcome(outcome), outcome);
	}
	assert.equal(describeOutcome({ status: "failed", stopReason: "aborted" }).execution, "cancelled");
	for (const stopReason of ["error", "resource-error", "guard-error", "toString", "__proto__"]) {
		assert.equal(describeOutcome({ status: "failed", stopReason }).execution, "failed");
	}
	const earlierFailure = describeOutcome({ status: "failed", stopReason: "error", evidence: { ...evidence(), agentSettled: false },
		finalization: { phase: "answering", reason: "context_budget", activeTools: 0 } });
	assert.equal(earlierFailure.execution, "failed"); assert.deepEqual(earlierFailure.limitations, ["context-budget", "unsettled-response"]);
});

test("response observations are independent from worker completion and legacy report prose", () => {
	const done = describeOutcome({ status: "done", stopReason: "stop", evidence: evidence() });
	assert.equal(done.execution, "finished"); assert.equal(done.responses, "observed"); assert.equal(done.taskAssessment, "not-performed");
	assert.equal(describeOutcome({ status: "done" }).responses, "unrecorded");
	assert.equal(describeOutcome({ status: "failed", evidence: { ...evidence(), finalizedMessages: 0, retainedResponses: 0 } }).responses, "none");
	const open = describeOutcome({ status: "done", evidence: { ...evidence(), openResponse: true, unansweredWrap: true, omittedPhases: 2 } });
	assert.equal(open.execution, "finished"); assert.equal(open.responses, "unsettled");
	assert.deepEqual(open.limitations, ["unsettled-response", "unanswered-wrap", "omitted-phases"]);
	for (const status of ["queued", "running"] as const) {
		const pending = describeOutcome({ status }); assert.equal(pending.responses, "pending"); assert.deepEqual(outcomeContent(pending), []);
	}
});

test("outcome copying bounds data, rejects task-success claims and contradictory response metadata", () => {
	const original = describeOutcome({ status: "done", evidence: evidence() });
	for (const bad of [undefined, {}, { ...original, version: 2 }, { ...original, taskAssessment: "verified" },
		{ ...original, responses: "unrecorded" }, { ...original, evidence: { ...evidence(), retainedResponses: 9 } },
		{ ...original, evidence: { ...evidence(), openResponse: true }, responses: "unsettled" },
		{ ...original, limitations: ["task-succeeded"] }, { ...original, limitations: ["context-budget", "context-budget"] },
		{ ...original, execution: "limited" }]) {
		assert.equal(copyOutcome(bad), undefined); assert.deepEqual(outcomeContent(bad), []);
	}
	const copy = copyOutcome(original)!; copy.evidence!.finalizedMessages = 99; copy.limitations.push("context-budget");
	assert.deepEqual(original.evidence, evidence()); assert.deepEqual(original.limitations, []);
	const max = describeOutcome({ status: "failed", stopReason: "hard_timeout", finalization: { phase: "answering", reason: "context_budget" },
		evidence: { ...evidence(), finalizedMessages: Number.MAX_SAFE_INTEGER, omittedPhases: Number.MAX_SAFE_INTEGER,
			unansweredWrap: true, openResponse: true, partialResponseRetained: true, agentSettled: false } });
	const text = outcomeContent(max)[0].text;
	assert.ok(Buffer.byteLength(text) <= 512); assert.match(text, /Task correctness: not assessed by delegate/);
});

test("scheduler snapshots detach outcome evidence from runner results and observers", async (t) => {
	const scheduler = new JobScheduler({ maxConcurrent: 1, maxLocalConcurrent: 1, maxQueued: 1,
		onChange: snap => { if (snap?.outcome?.evidence) snap.outcome.evidence.finalizedMessages = 99; } });
	t.after(() => scheduler.shutdown());
	let finish!: (result: ChildResult) => void;
	const pending = new Promise<ChildResult>(resolve => { finish = resolve; });
	const job = scheduler.enqueue({ kind: "recon", model: "hosted/mock", local: false, task: "Fake worker", timeoutMs: 1000, run: () => pending });
	assert.equal(job.outcome?.responses, "pending");
	const source: ChildResult = { text: "Reported success is not verification.", exitCode: 0, stderrTail: "", evidence: evidence() };
	finish(source); const done = await scheduler.wait(job.id);
	assert.equal(done.status, "done"); assert.deepEqual(done.outcome?.evidence, evidence());
	assert.equal(done.outcome?.taskAssessment, "not-performed");
	source.evidence!.finalizedMessages = 77; done.outcome!.evidence!.finalizedMessages = 88; done.outcome!.limitations.push("context-budget");
	assert.deepEqual(scheduler.get(job.id).outcome, describeOutcome({ status: "done", evidence: evidence() }));
	const notice = buildNotifyPayload(scheduler.get(job.id));
	assert.match(notice.content, /Worker state only; task correctness was not assessed by delegate/);
});

test("restored cards retain detached outcome data but never a claimed task assessment", () => {
	const cards = new JobCards(), outcome = describeOutcome({ status: "done", evidence: evidence() });
	cards.update("origin", { status: "done", outcome }); outcome.evidence!.finalizedMessages = 99;
	const loaded = cards.get("origin")!.outcome as ExecutionOutcome; loaded.evidence!.retainedResponses = 0; loaded.limitations.push("context-budget");
	assert.deepEqual(cards.get("origin")!.outcome, describeOutcome({ status: "done", evidence: evidence() }));
	const saved = { originToolCallId: "restored", status: "done", outcome: describeOutcome({ status: "done", evidence: evidence() }) };
	cards.restore([{ type: "custom", customType: CARD_STATE_TYPE, data: saved }]); saved.outcome.evidence!.finalizedMessages = 55;
	assert.deepEqual(cards.get("restored")!.outcome, describeOutcome({ status: "done", evidence: evidence() }));
	cards.update("bad", { status: "done", outcome: { ...outcome, taskAssessment: "verified" } }); assert.equal(cards.get("bad")!.outcome, undefined);
});

test("archive outcomes coexist with capabilities/headroom, survive rebuild, and do not backfill legacy proof", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "delegate-outcomes-")); t.after(() => rmSync(root, { recursive: true, force: true }));
	const prompt = join(root, "source.md"); writeFileSync(prompt, "Owned offline fixture");
	const capabilities = describeCapabilities(["read", "bash"]);
	const run = new ArchivedRun(root, { parentSessionId: "parent", toolCallId: "call", kind: "recon", cwd: root,
		requestedModel: "mock/model", thinking: "off", tools: ["read", "bash"], capabilities }, "Task", prompt);
	assert.equal(run.data.outcome?.execution, "queued"); run.start("d0001"); assert.equal(run.data.outcome?.execution, "running");
	const finalization = { phase: "answering" as const, reason: "context_budget" as const, activeTools: 0,
		headroom: { policyId: "a".repeat(64), phase: "limited" as const, limited: true } };
	const source = evidence(), finishing = run.finish({ status: "failed", stopReason: "context_budget", exitCode: 0, evidence: source, finalization });
	source.finalizedMessages = 55; finalization.headroom.limited = false; await finishing;
	assert.deepEqual(run.data.outcome?.evidence, evidence()); assert.equal(run.data.finalization?.headroom?.limited, true);
	assert.equal(run.data.outcome?.execution, "limited"); assert.equal(run.data.outcome?.taskAssessment, "not-performed");
	const before = readFileSync(run.paths.metadata, "utf8");
	const loaded = await loadRuns(root, { rebuild: true }); assert.equal(loaded.warnings.length, 0);
	assert.deepEqual(loaded.runs[0].outcome, run.data.outcome); assert.deepEqual(loaded.runs[0].capabilities, capabilities);
	assert.equal(readFileSync(run.paths.metadata, "utf8"), before);
	const exported = JSON.parse(readFileSync(join(root, "usage.jsonl"), "utf8").trim().split("\n").at(-1)!);
	assert.deepEqual(exported.outcome, run.data.outcome);
	for (const outcome of [undefined, { ...run.data.outcome, taskAssessment: "verified" }, { ...run.data.outcome, execution: "finished" }]) {
		writeFileSync(run.paths.metadata, JSON.stringify({ ...JSON.parse(before), outcome }));
		const invalid = await loadRuns(root, { rebuild: true });
		assert.equal(invalid.warnings.length, 0); assert.equal(invalid.runs[0].outcome, undefined);
		assert.equal(invalid.runs[0].status, "failed"); assert.deepEqual(invalid.runs[0].capabilities, capabilities);
		assert.equal(invalid.runs[0].finalization?.headroom?.limited, true);
	}
	const latest = { ...run.data, revision: 4 }, stale = { ...latest, revision: 3, outcome: undefined };
	const legacy = { ...latest, runId: "00000000-0000-0000-0000-000000000001", status: "done" as const, outcome: undefined };
	const report = statsReport([stale, latest, legacy], root, "all");
	assert.match(report, /Runtime outcomes: 1 recorded; 1 missing\/legacy; limited 1; unsettled responses 0/);
	assert.match(report, /Task correctness is not assessed by delegate/); assert.match(report, /not verified task success/);
});
