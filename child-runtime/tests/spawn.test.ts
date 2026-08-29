import assert from "node:assert/strict";
import { test } from "node:test";
import {
	applyAssistantSnapshot,
	extractAssistantText,
	finalizeChildText,
	jsonlEventType,
	jsonlRecordLimit,
	killChildTree,
	redactChildArgs,
	rememberEventType,
	summarizeChildRun,
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

test("redacts Task argv and keeps model flag", () => {
	const args = redactChildArgs([
		"--mode",
		"json",
		"--model",
		"openai-codex/gpt-5.6-sol",
		"Task: secret plan goes here",
	]);
	assert.equal(args.includes("openai-codex/gpt-5.6-sol"), true);
	assert.equal(args.at(-1), "Task:<redacted 21 chars>");
});

test("jsonl event type and ring buffer", () => {
	assert.equal(jsonlEventType({ type: "agent_start" }), "agent_start");
	assert.equal(jsonlEventType({ message: {} }), undefined);
	const events: string[] = [];
	for (let i = 0; i < 22; i++) rememberEventType(events, `e${i}`, 3);
	assert.deepEqual(events, ["e19", "e20", "e21"]);
});

test("summarize names pi argv not a codex CLI", () => {
	const text = summarizeChildRun({
		command: "/usr/bin/node",
		args: ["/opt/pi", "--mode", "json", "-p", "--model", "openai-codex/gpt-5.6-sol", "Task: do not log me"],
		pid: 9,
		timeoutMs: 300000,
		durationMs: 300012,
		eventCount: 0,
		events: [],
		sawAssistant: false,
		exitCode: 143,
		stopReason: "timeout",
		stderrTail: "",
	});
	assert.match(text, /^cmd: \/usr\/bin\/node \/opt\/pi /);
	assert.match(text, /--model openai-codex\/gpt-5\.6-sol/);
	assert.match(text, /Task:<redacted 13 chars>/);
	assert.equal(text.includes("do not log me"), false);
	assert.match(text, /stop: timeout/);
	assert.match(text, /events: \(none\)/);
	assert.match(text, /stderr: \(empty\)/);
});

test("finalizeChildText keeps assistant text and caps dump", () => {
	const dump = `cmd: node pi --model x\nstderr: ${"e".repeat(8000)}`;
	const assistant = finalizeChildText("hello", dump, 32);
	assert.equal(assistant.startsWith("hello") || assistant.includes("truncated"), true);
	assert.equal(assistant.includes("stderr:"), false);
	assert.ok(Buffer.byteLength(assistant, "utf8") <= 32);

	const empty = finalizeChildText("", dump, 64);
	assert.match(empty, /^cmd: /);
	assert.ok(Buffer.byteLength(empty, "utf8") <= 64);
	assert.match(empty, /truncated/);

	const tiny = finalizeChildText("héllo", dump, 8);
	assert.ok(Buffer.byteLength(tiny, "utf8") <= 8);
	assert.equal(tiny.includes("cmd:"), false);
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
