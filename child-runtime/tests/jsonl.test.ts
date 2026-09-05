import assert from "node:assert/strict";
import { test } from "node:test";
import { canDiscardOversizedEvent, JsonlReader, RPC_RECORD_LIMIT_BYTES } from "../jsonl.ts";

function collect(maxBytes = 32) {
	const lines: string[] = [];
	const oversized: string[] = [];
	return { lines, oversized, reader: new JsonlReader({ maxBytes, onLine: (line) => lines.push(line), onOversized: (prefix) => oversized.push(prefix) }) };
}

test("JSONL framing is invariant across every split of a mixed stream", () => {
	const wire = '\n{"a":"é\\n\u2028\u2029"}\r\n{"b":1}\nlast';
	for (let split = 0; split <= wire.length; split++) {
		const { lines, oversized, reader } = collect();
		reader.write(wire.slice(0, split));
		reader.write(wire.slice(split));
		reader.end();
		assert.deepEqual(lines, ['{"a":"é\\n\u2028\u2029"}\r', '{"b":1}', "last"]);
		assert.deepEqual(oversized, []);
	}
});

test("multiple records sharing a chunk each get their own byte budget", () => {
	const { lines, oversized, reader } = collect(4);
	reader.write("12");
	reader.write("34\nabcd\n");
	assert.deepEqual(lines, ["1234", "abcd"]);
	assert.deepEqual(oversized, []);
});

test("oversized records retain only a bounded prefix and resume after LF", () => {
	const { lines, oversized, reader } = collect(5);
	reader.write("é");
	reader.write("éé");
	for (let i = 0; i < 10; i++) reader.write("x".repeat(1000));
	reader.write("\nok\ntail");
	reader.end();
	assert.equal(oversized.length, 1);
	assert.ok(Buffer.byteLength(oversized[0]) <= 5);
	assert.deepEqual(lines, ["ok", "tail"]);
});

test("unterminated oversized frame is not delivered at EOF", () => {
	const { lines, oversized, reader } = collect(4);
	reader.write("abcde");
	reader.end();
	assert.deepEqual(oversized, ["abcd"]);
	assert.deepEqual(lines, []);
});

test("record limit is finite and independent of answer truncation", () => {
	assert.equal(RPC_RECORD_LIMIT_BYTES, 8 * 1024 * 1024);
	for (const maxBytes of [0, -1, Infinity, NaN, 1.5]) {
		assert.throws(() => collect(maxBytes), /byte limit/);
	}
});

test("only recognized non-answer event prefixes can be discarded", () => {
	for (const type of ["agent_end", "turn_end", "message_start", "tool_execution_update", "tool_execution_end"]) {
		assert.equal(canDiscardOversizedEvent(`{"type":"${type}","payload":"`), true);
	}
	assert.equal(canDiscardOversizedEvent('{ "type" : "message_end", "message" : { "role" : "toolResult", "content":['), true);
	assert.equal(canDiscardOversizedEvent('{"type":"message_end","message":{"role":"user","content":['), true);
	for (const prefix of [
		'{"type":"message_end","message":{"role":"assistant","content":[',
		'{"type":"message_end","message":{"content":[',
		'{"type":"response","command":"prompt","error":"',
		'{"type":"extension_ui_request","method":"confirm","title":"',
		'{"type":"unknown","nested":{"type":"agent_end"',
		'{"message":{"type":"agent_end"',
		'junk {"type":"agent_end",',
	]) assert.equal(canDiscardOversizedEvent(prefix), false, prefix);
});
