import assert from "node:assert/strict";
import { test } from "node:test";
import {
	applyAssistantSnapshot,
	extractAssistantText,
	jsonlRecordLimit,
	killChildTree,
} from "../spawn.ts";

test("extracts last assistant text from message_end", () => {
	const extracted = extractAssistantText({
		type: "message_end",
		message: {
			role: "assistant",
			model: "local-qwen38/qwen38-q4km",
			stopReason: "end",
			content: [
				{ type: "text", text: "first" },
				{ type: "toolCall", name: "read" },
				{ type: "text", text: "final answer" },
			],
		},
	});
	assert.equal(extracted.assistant, true);
	assert.equal(extracted.text, "final answer");
	assert.equal(extracted.model, "local-qwen38/qwen38-q4km");
	assert.equal(extracted.stopReason, "end");
	assert.deepEqual(extractAssistantText({ type: "agent_end" }), { assistant: false, text: "" });
});

test("assistant snapshot replaces atomically", () => {
	const first = applyAssistantSnapshot(
		{ text: "", model: "local-qwen38/qwen38-q4km", sawAssistant: false },
		{
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "toolUse",
				content: [{ type: "text", text: "looking" }],
			},
		},
	);
	assert.equal(first.text, "looking");
	assert.equal(first.stopReason, "toolUse");
	const second = applyAssistantSnapshot(first, {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", name: "read" }],
		},
	});
	assert.equal(second.text, "");
	assert.equal(second.stopReason, undefined);
	assert.equal(second.sawAssistant, true);
});

test("jsonl record limit stays bounded", () => {
	assert.ok(jsonlRecordLimit(65536) <= 1_048_576);
	assert.ok(jsonlRecordLimit(100) >= 262144);
});

test("SIGKILL still fires after SIGTERM even if killed is true", () => {
	const sent: Array<[number | string, string]> = [];
	const proc = {
		pid: 4242,
		exitCode: null as number | null,
		signalCode: null as NodeJS.Signals | null,
		killed: true,
		kill(signal?: NodeJS.Signals) {
			sent.push(["proc", signal ?? "SIGTERM"]);
			this.killed = true;
			return true;
		},
	};
	const later: Array<() => void> = [];
	killChildTree(proc, {
		platform: "linux",
		killProcess: (pid, signal) => {
			sent.push([pid, signal]);
		},
		setTimeoutFn: (fn) => {
			later.push(fn);
			return { unref() {} };
		},
	});
	assert.deepEqual(sent[0], [-4242, "SIGTERM"]);
	assert.equal(later.length, 1);
	later[0]?.();
	assert.ok(sent.some((entry) => entry[0] === -4242 && entry[1] === "SIGKILL"));
});
