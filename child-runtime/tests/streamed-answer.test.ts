import assert from "node:assert/strict";
import { test } from "node:test";
import { StreamedAnswer } from "../streamed-answer.ts";

const start = { type: "message_start", message: { role: "assistant", content: [] } };
const update = (type: string, contentIndex: number, text: string) => ({ type: "message_update", assistantMessageEvent: {
	type, contentIndex, ...(type === "text_end" ? { content: text } : { delta: text }),
} });

test("only an open assistant stream contributes text; thinking and tool arguments are never retained", () => {
	const answer = new StreamedAnswer(1000);
	answer.observe(update("text_delta", 0, "orphan")); assert.equal(answer.text(), undefined);
	answer.observe(start);
	answer.observe(update("thinking_delta", 0, "PRIVATE")); answer.observe(update("toolcall_delta", 1, "PRIVATE"));
	assert.equal(answer.text(), undefined);
	answer.observe(update("text_delta", 3, "later")); answer.observe(update("text_delta", 2, "first"));
	assert.equal(answer.text(), "first\nlater");
	answer.observe(update("text_end", 2, "authoritative")); assert.equal(answer.text(), "authoritative\nlater");
	answer.observe({ type: "message_end", message: { role: "assistant", content: [] } });
	assert.equal(answer.text(), undefined);
});

test("stream storage is byte- and block-bounded, with a truncation notice", () => {
	const answer = new StreamedAnswer(200); answer.observe(start);
	for (let i = 0; i < 1000; i++) answer.observe(update("text_delta", i, "界".repeat(100)));
	assert.ok(Buffer.byteLength(answer.text()!) <= 200); assert.match(answer.text()!, /truncated/);
	const blocks = Reflect.get(answer, "blocks") as Map<number, string>;
	assert.ok(blocks.size <= 32);
	assert.ok([...blocks.values()].reduce((total, text) => total + Buffer.byteLength(text), 0) <= 200);
	answer.observe(start); answer.observe(update("text_delta", 0, "fresh")); assert.equal(answer.text(), "fresh");
});

test("a complete authoritative text_end replaces a previously truncated delta", () => {
	const answer = new StreamedAnswer(100); answer.observe(start);
	answer.observe(update("text_delta", 0, "x".repeat(1000)));
	answer.observe(update("text_end", 0, "corrected"));
	assert.equal(answer.text(), "corrected");
});

test("malformed content indices and non-text payloads are ignored", () => {
	const answer = new StreamedAnswer(100); answer.observe(start);
	for (const index of [-1, 0.5, NaN, Infinity, "0"]) answer.observe(update("text_delta", index as any, "bad"));
	answer.observe(update("text_delta", 0, null as any));
	assert.equal(answer.text(), undefined);
});
