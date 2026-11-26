import assert from "node:assert/strict";
import { test } from "node:test";
import {
	applyTgEvent,
	createTgMeter,
	estimateTokensFromText,
	formatTg,
	isLocalModel,
	pickTokenCount,
	speedFrom,
	tgLabel,
	averageTgLabel,
	TG_MIN_MS,
} from "../tg.ts";

test("local providers only", () => {
	assert.equal(isLocalModel({ provider: "local-qwen38" }), true);
	assert.equal(isLocalModel({ provider: "llama.cpp" }), true);
	assert.equal(isLocalModel({ provider: "ollama" }), true);
	assert.equal(isLocalModel({ provider: "local-qwen38-backup" }), true);
	assert.equal(isLocalModel({ provider: "openai-codex" }), false);
	assert.equal(isLocalModel({ provider: "xai" }), false);
	assert.equal(isLocalModel({ provider: "  Ollama  " }), true);
	assert.equal(isLocalModel(undefined), false);
	assert.equal(isLocalModel({}), false);
	assert.equal(isLocalModel("local-qwen38/qwen38-q4km"), true);
	assert.equal(isLocalModel("llama.cpp/qwen"), true);
	assert.equal(isLocalModel("openai-codex/gpt-5.6-luna"), false);
	assert.equal(isLocalModel({ id: "local-qwen38/qwen38-q4km" }), true);
});

test("token pick prefers live usage", () => {
	assert.equal(estimateTokensFromText(""), 0);
	assert.equal(estimateTokensFromText("abcd"), 1);
	assert.equal(estimateTokensFromText("a".repeat(20)), 5);
	assert.equal(pickTokenCount(12, 8), 12);
	assert.equal(pickTokenCount(0, 8), 8);
	assert.equal(pickTokenCount(undefined, 8), 8);
});

test("speed waits for first tokens and min window", () => {
	assert.equal(speedFrom(0, 1000), undefined);
	assert.equal(speedFrom(10, TG_MIN_MS - 1), undefined);
	assert.equal(speedFrom(10, 1000), 10);
	assert.equal(formatTg(12.34), "~tg 12.3/s");
	assert.equal(formatTg(9.04), "~tg 9.0/s");
	assert.equal(formatTg(144.4), "~tg 144/s");
	assert.equal(formatTg(Number.NaN), "");
});

test("child json deltas drive tg after min window", () => {
	const meter = createTgMeter();
	const t0 = 1_000;
	assert.equal(
		applyTgEvent(
			meter,
			{
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "abcd".repeat(10) },
			},
			t0,
		),
		true,
	);
	assert.equal(tgLabel(meter, t0 + TG_MIN_MS - 1), undefined);
	assert.equal(tgLabel(meter, t0 + 1000), "~tg 10.0/s");
});

test("child usage on message_end beats char estimate", () => {
	const meter = createTgMeter();
	const t0 = 5_000;
	applyTgEvent(
		meter,
		{
			type: "message_update",
			usage: { output: 0 },
			assistantMessageEvent: { type: "thinking_delta", delta: "a".repeat(40) },
		},
		t0,
	);
	assert.equal(tgLabel(meter, t0 + 1000), "~tg 10.0/s");
	applyTgEvent(
		meter,
		{
			type: "message_end",
			message: { role: "assistant", usage: { output: 40 } },
		},
		t0 + 1000,
	);
	assert.equal(tgLabel(meter, t0 + 5000), undefined, "ended message no longer decays");
	assert.equal(averageTgLabel(meter), "~tg 40.0/s");
});

test("message_start resets child meter", () => {
	const meter = createTgMeter();
	applyTgEvent(
		meter,
		{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello world" } },
		1_000,
	);
	assert.equal(applyTgEvent(meter, { type: "message_start", message: { role: "assistant" } }, 2_000), true);
	assert.equal(tgLabel(meter, 3_000), undefined);
	assert.equal(applyTgEvent(meter, { type: "message_start", message: { role: "user" } }, 3_000), false);
});

test("run average spans streamed messages, including tool-call deltas, and ignores gaps between them", () => {
	const meter = createTgMeter();
	const delta = (type: string, now: number) => applyTgEvent(meter, { type: "message_update", assistantMessageEvent: { type, delta: "abcd".repeat(10) } }, now);
	delta("thinking_delta", 1_000);
	delta("toolcall_delta", 2_000);
	applyTgEvent(meter, { type: "message_end", message: { role: "assistant", usage: { output: 30 } } }, 2_000);
	applyTgEvent(meter, { type: "message_start", message: { role: "assistant" } }, 10_000);
	delta("text_delta", 10_000);
	delta("text_delta", 11_000);
	applyTgEvent(meter, { type: "message_end", message: { role: "assistant" } }, 11_000);
	applyTgEvent(meter, { type: "message_start", message: { role: "assistant" } }, 12_000);
	delta("toolcall_delta", 12_000);
	applyTgEvent(meter, { type: "message_end", message: { role: "assistant", usage: { output: 500 } } }, 12_050);
	assert.equal(averageTgLabel(meter), "~tg 25.0/s", "(30 + 20) tokens over 2s; untimeable one-chunk messages are skipped");
});

test("hosted windows start at message_start so hidden reasoning and burst text are timed", () => {
	const reply = (meter: ReturnType<typeof createTgMeter>) => {
		applyTgEvent(meter, { type: "message_start", message: { role: "assistant" } }, 1_000);
		applyTgEvent(meter, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "summary" } }, 10_000);
		applyTgEvent(meter, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "burst" } }, 15_000);
		applyTgEvent(meter, { type: "message_end", message: { role: "assistant", usage: { output: 700 } } }, 15_000);
		return averageTgLabel(meter);
	};
	assert.equal(reply(createTgMeter(true)), "~tg 50.0/s", "700 tokens over the whole 14s reply");
	assert.equal(reply(createTgMeter()), "~tg 140/s", "local keeps the first-delta window");
	const failed = createTgMeter(true);
	applyTgEvent(failed, { type: "message_start", message: { role: "assistant" } }, 0);
	applyTgEvent(failed, { type: "message_end", message: { role: "assistant" } }, 5_000);
	assert.equal(averageTgLabel(failed), undefined, "replies without tokens add no time");
});
