import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { isFailedChildResult } from "../policy.ts";
import { AnswerHistory } from "../answers.ts";
import { DEFAULT_WRAP_MESSAGE, encodeRpc, type ChildControl, type RunPiChildInput } from "../spawn.ts";
import { mockChild, runMockPiChild } from "./helpers.ts";

const PROMPT = fileURLToPath(new URL("../../delegate/prompts/recon.md", import.meta.url));

function start(t: TestContext, overrides: Partial<RunPiChildInput> = {}) {
	const proc = mockChild();
	let control!: ChildControl;
	const pending = runMockPiChild({
		cwd: process.cwd(), model: "test/model", task: "synthetic report", hardTimeoutMs: 0,
		maxOutputBytes: 65536, promptSourcePath: PROMPT, env: {}, buildArgs: () => [],
		spawnFn: () => proc, onControl: next => { control = next; }, ...overrides,
	});
	t.after(async () => { proc.close(1); await pending; });
	const emit = (event: Record<string, unknown>) => proc.stdout!.write(encodeRpc(event));
	const user = (text: string) => emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text }] } });
	user("Task: synthetic report");
	return {
		proc, pending, emit, user,
		wrap: (text?: string) => control.wrap(text),
		deliverWrap: (text = DEFAULT_WRAP_MESSAGE) => user(text),
		answer: (text: string, fields: Record<string, unknown> = {}) => emit({ type: "message_end", message: {
			role: "assistant", provider: "test", model: "model", stopReason: "stop",
			content: [{ type: "text", text }], ...fields,
		} }),
		settle: () => emit({ type: "agent_settled" }),
	};
}

for (const when of ["before report", "after report"] as const) {
	test(`preserve the report when wrap is queued ${when}`, async t => {
		const child = start(t);
		if (when === "before report") assert.equal(child.wrap(), true);
		child.answer("Report: src/example.ts contains the defect.");
		if (when === "after report") assert.equal(child.wrap(), true);
		child.deliverWrap();
		child.answer("Acknowledged; stopping now.");
		child.settle();
		const result = await child.pending;
		assert.equal(isFailedChildResult(result), false);
		assert.match(result.text, /Task response \(assistant 1\):\nReport:/);
		assert.match(result.text, /Wrap-up 1 \(assistant 2\):\nAcknowledged/);
		assert.ok(result.text.indexOf("Report:") < result.text.indexOf("Acknowledged"));
	});
}

test("a shorter correction is retained without guessing which response is substantive", async t => {
	const child = start(t);
	child.answer("Original finding. ".repeat(20));
	child.wrap(); child.deliverWrap();
	child.answer("Correction: no defect.");
	child.settle();
	const result = await child.pending;
	assert.match(result.text, /Original finding/);
	assert.match(result.text, /Wrap-up 1 \(assistant 2\):\nCorrection: no defect\./);
});

test("a wrap-up report is not replaced by an acknowledgement to a second wrap", async t => {
	const child = start(t);
	child.answer("Investigating", { stopReason: "toolUse" });
	child.wrap(); child.deliverWrap(); child.answer("Full final report.");
	child.wrap(); child.deliverWrap(); child.answer("Done.");
	child.settle();
	const result = await child.pending;
	assert.match(result.text, /Wrap-up 1 \(assistant 2\):\nFull final report\./);
	assert.match(result.text, /Wrap-up 2 \(assistant 3\):\nDone\./);
});

test("empty wrap-up is labelled and does not erase the report or become false success", async t => {
	const child = start(t);
	child.answer("Original report.");
	child.wrap(); child.deliverWrap(); child.answer(""); child.settle();
	const result = await child.pending;
	assert.equal(result.stopReason, "no-assistant-output");
	assert.equal(isFailedChildResult(result), true);
	assert.match(result.text, /Original report\./);
	assert.match(result.text, /Wrap-up 1 \(assistant 2\):\n\[No assistant text\]/);
});

for (const reason of ["error", "length"] as const) {
	test(`${reason} after wrap stays ahead of the retained report`, async t => {
		const child = start(t, { maxOutputBytes: 400 });
		child.answer("Report: " + "x".repeat(10000));
		child.wrap(); child.deliverWrap();
		child.answer("Partial follow-up.", { stopReason: reason, errorMessage: reason === "error" ? "Provider disconnected" : undefined });
		child.settle();
		const result = await child.pending;
		assert.equal(result.stopReason, reason);
		assert.equal(isFailedChildResult(result), true);
		assert.match(result.text, reason === "error" ? /^Provider disconnected/ : /^Child response reached the model output token limit/);
		assert.match(result.text, /Report:/);
		assert.match(result.text, /Partial follow-up\./);
		assert.match(result.text, /truncated/);
		assert.ok(Buffer.byteLength(result.text) <= 400);
	});
}

test("a provider error without a message still has an explicit explanation before the report", async t => {
	const child = start(t);
	child.answer("Original report."); child.wrap(); child.deliverWrap();
	child.answer("", { stopReason: "error" }); child.settle();
	const result = await child.pending;
	assert.equal(result.stopReason, "error");
	assert.match(result.text, /^Child provider response failed\./);
	assert.match(result.text, /Original report\./);
});

test("excess distinct pending wrap requests are refused without losing tracked controls", async t => {
	const child = start(t);
	child.answer("Original report.");
	for (let i = 0; i < 64; i++) assert.equal(child.wrap(`wrap ${i}`), true);
	assert.equal(child.wrap("overflow"), false);
	assert.equal(child.wrap("wrap 0"), true, "repeated text uses a count, not another retained string");
	child.deliverWrap("wrap 1");
	assert.equal(child.wrap("new slot"), true);
	child.answer("Finished."); child.settle();
	assert.match((await child.pending).text, /Original report\./);
});

test("a successful retry in the wrap phase replaces its transient error, not the task report", async t => {
	const child = start(t);
	child.answer("Original report."); child.wrap(); child.deliverWrap();
	child.answer("", { stopReason: "error", errorMessage: "Transient failure" });
	child.emit({ type: "agent_end", willRetry: true });
	child.answer("Corrected report."); child.settle();
	const result = await child.pending;
	assert.equal(isFailedChildResult(result), false);
	assert.match(result.text, /Original report\./);
	assert.match(result.text, /Corrected report\./);
	assert.equal(result.text.includes("Transient failure"), false);
});

test("output budgets reserve room for the follow-up, including UTF-8 text", async t => {
	const child = start(t, { maxOutputBytes: 220 });
	child.answer("Report: " + "界".repeat(10000));
	child.wrap(); child.deliverWrap(); child.answer("Correction: use path B."); child.settle();
	const result = await child.pending;
	assert.match(result.text, /Report:/);
	assert.match(result.text, /Correction: use path B\./);
	assert.match(result.text, /truncated/);
	assert.ok(Buffer.byteLength(result.text) <= 220);
});

test("settling before wrap delivery keeps the report and does not invent a follow-up", async t => {
	const child = start(t);
	child.answer("Original report."); child.wrap(); child.settle();
	assert.equal(child.wrap(), false);
	assert.equal((await child.pending).text, "Original report.");
});

test("wrap delivery without a later assistant message is explicitly labelled", async t => {
	const child = start(t);
	child.answer("Original report."); child.wrap(); child.deliverWrap(); child.settle();
	const result = await child.pending;
	assert.match(result.text, /Original report\./);
	assert.match(result.text, /Wrap-up 1: \[No assistant message received\]/);
});

test("a custom wrap is correlated by delivered text, not an unrelated user message or RPC acknowledgement", async t => {
	const child = start(t);
	child.answer("Old draft."); child.wrap("Finish the summary.");
	child.emit({ type: "response", command: "steer", success: true });
	child.user("An unrelated message.");
	child.answer("Final report."); child.deliverWrap("Finish the summary.");
	child.answer("Acknowledged."); child.settle();
	const result = await child.pending;
	assert.equal(result.text.includes("Old draft"), false);
	assert.match(result.text, /Task response \(assistant 2\):\nFinal report\./);
	assert.match(result.text, /Wrap-up 1 \(assistant 3\):\nAcknowledged\./);
});

test("protocol failure after wrap retains labelled evidence behind the error", async t => {
	const child = start(t);
	child.answer("Original report."); child.wrap(); child.deliverWrap();
	child.answer("x".repeat(9 * 1024 * 1024));
	const result = await child.pending;
	assert.equal(result.stopReason, "protocol-error");
	assert.match(result.text, /^Child RPC record exceeds/);
	assert.match(result.text, /Original report\./);
});

test("abort during wrap retains available evidence and ignores late responses", async t => {
	const signal = new AbortController();
	const child = start(t, { signal: signal.signal });
	child.answer("Original report."); child.wrap(); child.deliverWrap();
	signal.abort(); child.answer("Late acknowledgement.");
	const result = await child.pending;
	assert.equal(result.stopReason, "aborted");
	assert.match(result.text, /Original report\./);
	assert.equal(result.text.includes("Late acknowledgement"), false);
});

test("capped retention does not mutate raw events supplied to accounting or observers", async t => {
	let raw = "";
	const child = start(t, { maxOutputBytes: 220, onEvent(event: any) {
		if (event.message?.role === "assistant" && !raw) raw = event.message.content[0].text;
	} });
	child.answer("界".repeat(10000)); child.wrap(); child.deliverWrap(); child.answer("Done."); child.settle();
	await child.pending;
	assert.equal(raw, "界".repeat(10000));
});

test("phase retention is bounded independently of message count and original output size", () => {
	const history = new AnswerHistory(257);
	for (let phase = 0; phase < 1000; phase++) {
		history.observe({ text: "x".repeat(10000), errorMessage: "e".repeat(10000), stopReason: "error" });
		history.beginWrap();
	}
	// White-box size assertion: all retained fields, not just the formatted result, must be bounded.
	assert.ok(Buffer.byteLength(JSON.stringify(history)) < 8 * (257 * 2 + 200));
});

test("even tiny output caps stay bounded and disclose missing history where space permits", () => {
	for (let cap = 1; cap < 400; cap++) {
		const history = new AnswerHistory(cap);
		history.observe({ text: "Original: " + "界".repeat(1000) }); history.beginWrap();
		history.observe({ text: "Correction: B." });
		const text = history.format("unused");
		assert.ok(Buffer.byteLength(text) <= cap, `cap ${cap}`);
		if (cap >= 60 && !text.includes("Original:")) assert.match(text, /truncated; see archived session/);
	}
});

test("terminal open streams supplement finalized text and tiny caps preserve the cause", () => {
	const history = new AnswerHistory(1000);
	history.observe({ text: "Original report." }); history.observePartial("Incomplete correction.");
	const text = history.format("unused", "Failure cause.");
	assert.match(text, /^Failure cause\./); assert.match(text, /Original report/); assert.match(text, /incomplete streamed response/);
	assert.match(text, /Incomplete correction/);
	history.observe({ text: "Final correction." }); assert.equal(history.format("Final correction."), "Final correction.");
	for (let cap = 1; cap < 400; cap++) {
		const capped = new AnswerHistory(cap);
		capped.observe({ text: "Original " + "界".repeat(1000) }); capped.observePartial("Incomplete " + "界".repeat(1000));
		const output = capped.format("unused", "Failure cause.");
		assert.ok(Buffer.byteLength(output) <= cap);
		if (cap >= 14) assert.match(output, /^Failure cause\./);
	}
});

test("no wrap keeps the existing last-message contract", async t => {
	const child = start(t);
	child.answer("Draft."); child.answer("Final."); child.settle();
	assert.equal((await child.pending).text, "Final.");
});

test("large histories are explicitly condensed but retain the task response and latest follow-up", async t => {
	const child = start(t, { maxOutputBytes: 2048 });
	child.answer("Original report.");
	for (let i = 1; i <= 40; i++) {
		child.wrap(); child.deliverWrap(); child.answer(`Follow-up ${i}.`);
	}
	child.settle();
	const result = await child.pending;
	assert.match(result.text, /Original report\./);
	assert.match(result.text, /Follow-up 40\./);
	assert.match(result.text, /omitted.*archived session/);
	assert.ok(Buffer.byteLength(result.text) <= 2048);
});
