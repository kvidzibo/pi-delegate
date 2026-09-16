import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { AnswerHistory } from "../answers.ts";
import { copyResponseEvidence } from "../evidence.ts";
import { encodeRpc, type RunPiChildInput } from "../spawn.ts";
import { mockChild, runMockPiChild } from "./helpers.ts";
import { describeOutcome } from "../../delegate/outcomes.ts";

const PROMPT = fileURLToPath(new URL("../../delegate/prompts/recon.md", import.meta.url));
async function start(t: TestContext, extra: Partial<RunPiChildInput> = {}) {
	const proc = mockChild();
	const pending = runMockPiChild({ cwd: process.cwd(), model: "mock/model", task: "Offline evidence fixture",
		hardTimeoutMs: 0, maxOutputBytes: 4096, promptSourcePath: PROMPT, env: {}, buildArgs: () => [], spawnFn: () => proc, ...extra });
	t.after(async () => { proc.close(1); await pending; });
	await new Promise<void>(resolve => setImmediate(resolve));
	return { proc, pending, emit: (event: unknown) => proc.stdout!.write(encodeRpc(event as Record<string, unknown>)) };
}
const assistant = (text: string) => ({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } });

test("response counts distinguish finalized observations, retained phases, omissions and partial streams", () => {
	const history = new AnswerHistory(4096);
	history.observe({ text: "first" }); history.observe({ text: "replacement" });
	for (let i = 0; i < 10; i++) { history.beginWrap(); history.observe({ text: "reply" }); }
	assert.deepEqual(history.evidence(true, false, true), { source: "rpc", taskSent: true, agentSettled: true,
		finalizedMessages: 12, retainedResponses: 8, omittedPhases: 3, unansweredWrap: false, openResponse: false, partialResponseRetained: false });
	history.beginWrap(); history.observePartial("partial", 10);
	const partial = history.evidence(true, true, false);
	assert.equal(partial.finalizedMessages, 12); assert.equal(partial.retainedResponses, 7); assert.equal(partial.omittedPhases, 4);
	assert.equal(partial.unansweredWrap, true); assert.equal(partial.partialResponseRetained, true);
	assert.deepEqual(copyResponseEvidence(partial), partial);
	const detached = copyResponseEvidence(partial)!; detached.finalizedMessages = 0;
	assert.equal(history.evidence(true, true, false).finalizedMessages, 12);
	for (const bad of [undefined, {}, { ...partial, source: "inferred" }, { ...partial, agentSettled: undefined },
		{ ...partial, retainedResponses: 9 }, { ...partial, finalizedMessages: 1 }, { ...partial, openResponse: false },
		{ ...partial, omittedPhases: -1 }, { ...partial, finalizedMessages: Infinity }, { ...partial, finalizedMessages: 0.5 }]) {
		assert.equal(copyResponseEvidence(bad), undefined);
	}
});

for (const text of ["All work completed and tests passed.", "I cannot perform this task."]) {
	test(`RPC observations do not assess task correctness from report prose: ${text}`, async (t) => {
		const { proc, pending, emit } = await start(t); assert.match(proc.stdinBytes, /"id":"p1"/);
		emit({ type: "message_end", message: { role: "toolResult", content: "not an assistant" } });
		emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "legacy" }] } });
		emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "stream" } });
		emit(assistant("earlier")); emit(assistant(text)); emit({ type: "agent_end" }); emit({ type: "agent_settled" });
		const result = await pending;
		assert.equal(result.text, text); assert.equal(result.exitCode, 0);
		assert.deepEqual(result.evidence, { source: "rpc", taskSent: true, agentSettled: true, finalizedMessages: 2,
			retainedResponses: 1, omittedPhases: 0, unansweredWrap: false, openResponse: false, partialResponseRetained: false });
		const outcome = describeOutcome({ status: "done", ...result });
		assert.equal(outcome.execution, "finished"); assert.equal(outcome.responses, "observed"); assert.equal(outcome.taskAssessment, "not-performed");
	});
}

test("a zero exit after an earlier report and a new open turn is not settled response evidence", async (t) => {
	const { proc, pending, emit } = await start(t);
	emit(assistant("Earlier evidence.")); emit({ type: "message_start", message: { role: "assistant" } });
	emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "unfinished" } }); proc.close(0);
	const result = await pending;
	assert.equal(result.exitCode, 0); assert.equal(result.stopReason, "stop"); assert.equal(result.text, "Earlier evidence.");
	assert.equal(result.evidence?.openResponse, true); assert.equal(result.evidence?.agentSettled, false);
	assert.equal(result.evidence?.finalizedMessages, 1); assert.equal(result.evidence?.partialResponseRetained, false, "no implicit guarded streaming activation");
	const outcome = describeOutcome({ status: "done", ...result });
	assert.equal(outcome.execution, "finished"); assert.equal(outcome.responses, "unsettled"); assert.deepEqual(outcome.limitations, ["unsettled-response"]);
});

test("an empty open turn does not count as a finalized assistant message", async (t) => {
	const { proc, pending, emit } = await start(t);
	emit({ type: "message_start", message: { role: "assistant" } }); proc.close(0);
	const result = await pending;
	assert.equal(result.evidence?.finalizedMessages, 0); assert.equal(result.evidence?.openResponse, true);
	assert.equal(result.evidence?.retainedResponses, 0); assert.equal(result.stopReason, "no-assistant-output");
});

test("startup failure reports no task dispatch without inventing an assistant response", async (t) => {
	const { proc, pending } = await start(t, { beforePrompt: () => { throw new Error("Owned startup refusal"); } });
	const result = await pending;
	assert.doesNotMatch(proc.stdinBytes, /"id":"p1"/); assert.equal(result.evidence?.taskSent, false);
	assert.equal(result.evidence?.agentSettled, false); assert.equal(result.evidence?.finalizedMessages, 0);
});
