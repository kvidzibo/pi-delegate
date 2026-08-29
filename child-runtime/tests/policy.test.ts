import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
	assertNotNested,
	isFailedChildResult,
	normalizeTimeoutMs,
	normalizeTask,
	resolveChildCwd,
	truncateOutput,
} from "../policy.ts";

const timeouts = { defaultTimeoutMs: 300000, maxTimeoutMs: 900000 };

test("nested env refused", () => {
	assert.throws(() => assertNotNested({ PI_DELEGATE_CHILD: "1" }), /already inside a delegate child/);
	assert.doesNotThrow(() => assertNotNested({}));
});

test("timeout default and clamp", () => {
	assert.equal(normalizeTimeoutMs(undefined, timeouts), 300000);
	assert.equal(normalizeTimeoutMs(500, timeouts), 1000);
	assert.equal(normalizeTimeoutMs(2_000_000, timeouts), 900000);
	assert.equal(normalizeTimeoutMs(12000, timeouts), 12000);
});

test("output truncation notice", () => {
	const text = "a".repeat(50);
	const out = truncateOutput(text, 32);
	assert.match(out, /truncated \d+ bytes/);
	assert.ok(Buffer.byteLength(out, "utf8") <= 32);
	assert.equal(truncateOutput("short", 64), "short");
});

test("cwd must exist", () => {
	const dir = tmpdir();
	assert.equal(resolveChildCwd(undefined, dir), dir);
	assert.throws(() => resolveChildCwd("definitely-missing-child-runtime-dir", dir), /not an existing directory/);
});

test("task required and capped", () => {
	assert.equal(normalizeTask("ok", 20), "ok");
	assert.throws(() => normalizeTask("", 20), /required/);
	assert.throws(() => normalizeTask("x".repeat(21), 20), /exceeds 20 chars/);
});

test("failed child result covers timeout and empty text", () => {
	assert.equal(isFailedChildResult({ exitCode: 0, stopReason: "end", text: "ok" }), false);
	assert.equal(isFailedChildResult({ exitCode: 0, stopReason: "timeout", text: "partial" }), true);
	assert.equal(isFailedChildResult({ exitCode: 0, stopReason: "end", text: "" }), true);
	assert.equal(isFailedChildResult({ exitCode: 1, stopReason: "end", text: "ok" }), true);
});
