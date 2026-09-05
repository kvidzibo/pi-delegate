import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { reportedTokens, sessionUsage, totalTokens, UsageMeter } from "../usage.ts";

const model = "local-qwen38/qwen38-q4km";
export const usage = (input = 100, output = 20) => ({ input, output, cacheRead: 30, cacheWrite: 5, totalTokens: input + output + 35, reasoning: 10 });
const message = (timestamp: number, used: unknown = usage(), provider = "local-qwen38") => ({ role: "assistant", timestamp, content: [{ type: "text", text: "answer" }], usage: used, provider, model: "qwen38-q4km" });

test("usage buckets exclude reasoning duplication and reject missing/invalid/all-zero usage", () => {
	assert.equal(reportedTokens(usage())?.total, 155);
	for (const value of [undefined, {}, { input: 2, output: 1 }, { ...usage(), input: -1 }, { ...usage(), output: NaN }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }]) assert.equal(reportedTokens(value), undefined);
});

test("live cumulative updates are replaced; final turns, retries and compaction counted once", () => {
	const meter = new UsageMeter(model);
	meter.observe({ type: "message_start", message: message(1) });
	meter.observe({ type: "message_update", usage: usage(100, 2) });
	meter.observe({ type: "message_update", usage: usage(100, 10) });
	assert.equal(totalTokens(meter.snapshot()), 145);
	assert.equal(meter.snapshot().incomplete, true);
	const end = { type: "message_end", message: message(1) };
	meter.observe(end); meter.observe(end);
	meter.observe({ type: "turn_end", message: end.message });
	meter.observe({ type: "agent_end", messages: [end.message] });
	assert.equal(totalTokens(meter.snapshot()), 155);
	assert.equal(meter.snapshot().incomplete, false);
	meter.observe({ type: "message_end", message: { ...message(2, usage(50, 1)), stopReason: "error" } });
	meter.observe({ type: "message_end", message: message(3, usage(80, 5)) });
	const compact = { type: "compaction_end", result: { usage: usage(40, 4) } };
	meter.observe(compact); meter.observe(compact);
	assert.equal(totalTokens(meter.snapshot()), 155 + 86 + 120 + 79);
	assert.equal(meter.snapshot().reported, 4);
	meter.observe({ type: "agent_settled" });
	assert.equal(meter.settled, true);
});

test("identical genuine turns and compactions remain distinct after a new start event", () => {
	const meter = new UsageMeter(model);
	for (let i = 0; i < 2; i++) {
		meter.observe({ type: "message_start", message: message(1) });
		meter.observe({ type: "message_end", message: message(1) });
		meter.observe({ type: "compaction_start" });
		meter.observe({ type: "compaction_end", result: { usage: usage() } });
	}
	assert.equal(totalTokens(meter.snapshot()), 4 * 155);
});

test("a missing final usage placeholder does not erase already reported streaming usage", () => {
	const meter = new UsageMeter(model);
	meter.observe({ type: "message_start", message: message(1) });
	meter.observe({ type: "message_update", usage: usage() });
	meter.observe({ type: "message_end", message: message(1, null) });
	assert.equal(totalTokens(meter.snapshot()), 155);
	assert.equal(meter.snapshot().missing, 1);
	assert.equal(meter.snapshot().incomplete, true);
});

test("hosted and local model identity is resolved from actual provider metadata", () => {
	const meter = new UsageMeter("ambiguous-model");
	meter.observe({ type: "message_end", message: message(1) });
	meter.observe({ type: "message_end", message: message(2, usage(), "openai-codex") });
	assert.equal(meter.snapshot().local.total, 155);
	assert.equal(meter.snapshot().hosted.total, 155);
});

test("missing usage and unsuccessful compaction are visible, not silently zero", () => {
	const meter = new UsageMeter(model);
	meter.observe({ type: "message_end", message: message(1, null) });
	meter.observe({ type: "compaction_end", result: null, errorMessage: "provider failed" });
	assert.equal(meter.snapshot().missing, 1);
	assert.equal(meter.snapshot().incomplete, true);
});

test("native transcript aggregation ignores retained copies and duplicate entry IDs; preserves pre-compaction work", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "delegate-usage-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "session.jsonl");
	const a = { type: "message", id: "a", message: message(1) };
	const rows = [
		{ type: "session", version: 3, id: "session" }, a, a,
		{ type: "message", id: "b", message: { role: "toolResult", content: [{ type: "text", text: "x\u2028y\u2029z" }] } },
		{ type: "compaction", id: "c", usage: usage(50, 5), retainedTail: [a.message] },
		{ type: "branch_summary", id: "d", usage: usage(25, 5) },
		{ type: "message", id: "e", message: message(2, usage(), "openai-codex") },
		{ type: "message", id: "f", message: { role: "toolResult", usage: usage(1, 2) } },
	];
	writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\r\n") + "\n");
	const sum = await sessionUsage(path, model);
	assert.equal(sum.local.total, 155 + 90 + 65);
	assert.equal(sum.hosted.total, 155 + 38);
	assert.equal(sum.reported, 5);
	assert.equal(sum.incomplete, false);
	writeFileSync(path, '{"type":"message"', { flag: "a" });
	const broken = await sessionUsage(path, model);
	assert.equal(totalTokens(broken), totalTokens(sum));
	assert.equal(broken.incomplete, true);
});
