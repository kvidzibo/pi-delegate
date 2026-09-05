import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ACTIVITY_ARG_MAX,
	aliasForModel,
	appendActivity,
	applyProgress,
	asActivityList,
	clipActivityArg,
	clipThinkingTail,
	createProgress,
	delegateTargetLine,
	formatDelegateTarget,
	formatJobBoard,
	paintHeader,
	parseChildProgress,
	summarizeToolArgs,
	THINKING_TAIL_MAX,
	type ActivityItem,
} from "../display.ts";

const models = {
	recon: "local-qwen38/qwen38-q4km",
	implement: "openai-codex/gpt-5.6-luna",
	review: "openai-codex/gpt-5.6-terra",
	oracle: "openai-codex/gpt-5.6-sol",
};

test("aliases known child models", () => {
	assert.equal(aliasForModel(models.recon), "Qwen");
	assert.equal(aliasForModel("openai-codex/gpt-5.3-codex-spark"), "Spark");
	assert.equal(aliasForModel(models.implement), "Luna");
	assert.equal(aliasForModel(models.review), "Terra");
	assert.equal(aliasForModel(models.oracle), "Sol");
	assert.equal(aliasForModel("openai-codex/mystery"), "mystery");
	assert.equal(aliasForModel("acme/solicitor"), "solicitor");
	assert.equal(aliasForModel(undefined), "…");
});

test("header shows kind and model", () => {
	assert.equal(formatDelegateTarget(undefined, undefined), "…");
	assert.equal(formatDelegateTarget("nope", undefined), "…");
	assert.equal(formatDelegateTarget("recon", undefined), "recon → …");
	assert.equal(formatDelegateTarget("recon", models.recon), "recon → Qwen (local-qwen38/qwen38-q4km)");
	assert.equal(
		formatDelegateTarget("implement", models.implement),
		"implement → Luna (openai-codex/gpt-5.6-luna)",
	);
	assert.equal(
		delegateTargetLine("review", models.review),
		"[delegate review → Terra (openai-codex/gpt-5.6-terra)]",
	);
});

test("child progress lines from json events", () => {
	assert.deepEqual(parseChildProgress({ type: "tool_execution_start", toolName: "read", args: { path: "src/foo.ts" } }), {
		mark: "→",
		name: "read",
		args: "src/foo.ts",
	});
	assert.deepEqual(
		parseChildProgress({ type: "tool_execution_end", toolName: "grep", args: { pattern: "TODO" }, isError: true }),
		{ mark: "✗", name: "grep", args: "TODO" },
	);
	assert.deepEqual(
		parseChildProgress({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_start" },
		}),
		{ mark: "…", name: "thinking" },
	);
	assert.deepEqual(
		parseChildProgress({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", delta: "Need map first" },
		}),
		{ mark: "…", name: "thinking", args: "Need map first" },
	);
	assert.equal(parseChildProgress({ type: "agent_start" }), undefined);
	assert.deepEqual(
		parseChildProgress({
			type: "tool_execution_update",
			toolCallId: "c9",
			toolName: "bash",
			args: { command: "ls -la" },
		}),
		{ mark: "→", name: "bash", args: "ls -la", id: "c9" },
	);
	const long = summarizeToolArgs("bash", { command: "x".repeat(90) });
	assert.equal(long.length, ACTIVITY_ARG_MAX);
	assert.equal(long.endsWith("…"), true);
	assert.equal(clipActivityArg("short"), "short");
});

test("live activity keeps last 3 and upgrades start to end", () => {
	const items: ActivityItem[] = [];
	appendActivity(items, { mark: "…", name: "writing" });
	appendActivity(items, { mark: "→", name: "read", args: "a.ts" });
	appendActivity(items, { mark: "✓", name: "read", args: "a.ts" });
	appendActivity(items, { mark: "→", name: "grep", args: "TODO" });
	appendActivity(items, { mark: "→", name: "bash", args: "ls" });
	assert.equal(appendActivity(items, { mark: "→", name: "bash", args: "ls" }), false);
	assert.deepEqual(
		items.map((item) => item.name),
		["read", "grep", "bash"],
	);
	assert.equal(items[0]?.mark, "✓");
	assert.deepEqual(asActivityList(items), items);
	assert.deepEqual(asActivityList([{ mark: "nope", name: "read" }]), []);
});

test("current row stays off the last-3 done list", () => {
	const state = createProgress();
	applyProgress(state, { mark: "…", name: "thinking", args: "Need map first" });
	assert.deepEqual(state.done, []);
	assert.equal(state.current, undefined);
	assert.equal(state.thinking, "Need map first");
	applyProgress(state, { mark: "→", name: "read", args: "a.md", id: "c1" });
	assert.equal(state.current?.mark, "→");
	applyProgress(state, { mark: "✓", name: "read", id: "c1" });
	assert.equal(state.done.length, 1);
	assert.equal(state.done[0]?.mark, "✓");
	assert.equal(state.done[0]?.args, "a.md");
	assert.equal(state.current, undefined);
	applyProgress(state, { mark: "…", name: "writing" });
	assert.equal(state.done.length, 1);
	assert.equal(state.current?.name, "writing");
});

test("tool end without args updates start in place", () => {
	const items: ActivityItem[] = [];
	appendActivity(items, {
		mark: "→",
		name: "read",
		args: "/tmp/pi-delegate/delegate/README.md",
		id: "c1",
	});
	assert.equal(
		appendActivity(items, { mark: "✓", name: "read", id: "c1" }),
		true,
	);
	assert.equal(items.length, 1);
	assert.deepEqual(items[0], {
		mark: "✓",
		name: "read",
		args: "/tmp/pi-delegate/delegate/README.md",
		id: "c1",
	});
	appendActivity(items, { mark: "→", name: "read", args: "other.md", id: "c2" });
	appendActivity(items, parseChildProgress({
		type: "tool_execution_end",
		toolCallId: "c2",
		toolName: "read",
		isError: false,
	})!);
	assert.equal(items.length, 2);
	assert.equal(items[1]?.mark, "✓");
	assert.equal(items[1]?.args, "other.md");
});

test("thinking does not wipe in-flight tool args", () => {
	const state = createProgress();
	const pattern =
		"defaultCacheDir|formatChildProgressLine|appendActivity|clipActivityArg|plannedModel|delegateTargetLine";
	applyProgress(
		state,
		parseChildProgress({
			type: "tool_execution_start",
			toolCallId: "b1",
			toolName: "bash",
			args: { command: "ls -la delegate" },
		})!,
	);
	assert.equal(applyProgress(state, parseChildProgress({
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", delta: "Keep bash args" },
	})!), true);
	assert.equal(state.current?.name, "bash");
	assert.equal(state.thinking, "Keep bash args");
	applyProgress(
		state,
		parseChildProgress({
			type: "tool_execution_end",
			toolCallId: "b1",
			toolName: "bash",
			isError: false,
		})!,
	);
	applyProgress(
		state,
		parseChildProgress({
			type: "tool_execution_start",
			toolCallId: "g1",
			toolName: "grep",
			args: { pattern },
		})!,
	);
	applyProgress(
		state,
		parseChildProgress({
			type: "tool_execution_end",
			toolCallId: "g1",
			toolName: "grep",
			isError: false,
		})!,
	);
	applyProgress(
		state,
		parseChildProgress({
			type: "tool_execution_start",
			toolCallId: "g2",
			toolName: "grep",
			args: { pattern: "resolveTarget" },
		})!,
	);
	applyProgress(state, parseChildProgress({
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", delta: "Still grepping" },
	})!);
	applyProgress(
		state,
		parseChildProgress({
			type: "tool_execution_end",
			toolCallId: "g2",
			toolName: "grep",
			isError: false,
		})!,
	);
	applyProgress(state, parseChildProgress({
		type: "message_update",
		assistantMessageEvent: { type: "thinking_start" },
	})!);
	applyProgress(state, parseChildProgress({
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", delta: "Need failing test first" },
	})!);
	assert.deepEqual(
		state.done.map((item) => `${item.mark} ${item.name} ${item.args ?? ""}`),
		[
			"✓ bash ls -la delegate",
			`✓ grep ${clipActivityArg(pattern)}`,
			"✓ grep resolveTarget",
		],
	);
	assert.equal(state.current, undefined);
	assert.equal(state.thinking, "Need failing test first");
	assert.ok((state.done[1]?.args?.length ?? 0) <= ACTIVITY_ARG_MAX);
});

test("thinking buffer is bounded but the visible header contains only identity", () => {
	assert.equal(clipThinkingTail("short"), "short");
	const long = `Need ${"x".repeat(80)} end`;
	const clipped = clipThinkingTail(long);
	assert.equal(clipped.length, THINKING_TAIL_MAX);
	assert.equal(clipped.startsWith("…"), true);
	assert.equal(clipped.endsWith("end"), true);
	const theme = {
		fg: (key: string, text: string) => `[${key}]${text}`,
		bold: (text: string) => `*${text}*`,
		italic: (text: string) => `/${text}/`,
	};
	assert.equal(
		paintHeader(theme, "delegate", "implement", models.implement),
		"[toolTitle]*delegate* · [accent]implement · [dim]openai-codex/gpt-5.6-luna",
	);
	assert.equal(
		paintHeader(theme, "delegate", "review", "xai/grok-4.6", "d0003"),
		"[toolTitle]*delegate* · [accent]review · [dim]xai/grok-4.6 · [accent]d0003",
	);
	const state = createProgress();
	applyProgress(state, parseChildProgress({
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", delta: "User wants header text" },
	})!);
	assert.equal(state.current, undefined);
	assert.equal(state.thinking, "User wants header text");
	applyProgress(state, { mark: "…", name: "writing" });
	assert.equal(state.thinking, undefined);
	assert.equal(state.current?.name, "writing");
});

test("distinct identical calls keep their IDs and parallel completions keep current activity", () => {
	const state = createProgress();
	for (const id of ["A", "B"]) {
		applyProgress(state, { mark: "→", name: "read", args: "same.ts", id });
		applyProgress(state, { mark: "✓", name: "read", id });
	}
	assert.deepEqual(state.done.map((item) => item.id), ["A", "B"]);
	applyProgress(state, { mark: "→", name: "read", args: "a.ts", id: "C" });
	applyProgress(state, { mark: "→", name: "read", args: "b.ts", id: "D" });
	applyProgress(state, { mark: "✓", name: "read", id: "unknown" });
	assert.equal(state.current?.id, "D");
	assert.equal(state.done.at(-1)?.args, undefined, "unmatched IDs cannot borrow arguments");
	applyProgress(state, { mark: "✓", name: "read", id: "C" });
	assert.equal(state.current?.id, "D");
	applyProgress(state, { mark: "✓", name: "read", id: "D" });
	assert.equal(state.current, undefined);
	assert.equal(state.open.size, 0);
	assert.equal(state.done.length, 3);
});

test("finishing current tool reveals another open tool; ID-less completions still merge", () => {
	const state = createProgress();
	applyProgress(state, { mark: "→", name: "read", args: "a", id: "A" });
	applyProgress(state, { mark: "→", name: "read", args: "b", id: "B" });
	applyProgress(state, { mark: "✓", name: "read", id: "B" });
	assert.equal(state.current?.id, "A");
	applyProgress(state, { mark: "✓", name: "read" });
	assert.equal(state.current, undefined);
	assert.equal(state.open.size, 0);
	assert.equal(state.done.at(-1)?.args, "a");
});

test("sticky board shows counts without duplicating individual job cards", () => {
	assert.deepEqual(
		formatJobBoard(
			[
				{ local: true, status: "running" },
				{ local: false, status: "running" },
				{ local: true, status: "queued" },
			],
			{ maxLocalConcurrent: 1 },
		),
		[
			"delegate  2 run  1 wait  local 1/1",
		],
	);
});
