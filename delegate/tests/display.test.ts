import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ACTIVITY_ARG_MAX,
	aliasForModel,
	appendActivity,
	applyProgress,
	asActivityList,
	clipActivityArg,
	createProgress,
	delegateTargetLine,
	formatDelegateTarget,
	formatJobBoard,
	paintHeader,
	parseChildProgress,
	summarizeToolArgs,
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
	assert.equal(state.thinking, true);
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
	assert.equal(state.thinking, true);
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
	assert.equal(state.thinking, true);
	assert.ok((state.done[1]?.args?.length ?? 0) <= ACTIVITY_ARG_MAX);
});

test("thinking progress retains only phase and the visible header contains only identity", () => {
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
	assert.equal(state.thinking, true);
	assert.doesNotMatch(JSON.stringify(state), /User wants header text/);
	applyProgress(state, { mark: "…", name: "writing" });
	assert.equal(state.thinking, undefined);
	assert.equal(state.current?.name, "writing");
});

test("thinking phase ignores empty deltas, resets at block boundaries and yields to writing", () => {
	const state = createProgress();
	const event = (type: string, delta?: unknown) => {
		const item = parseChildProgress({ type: "message_update", assistantMessageEvent: { type, delta } });
		return item ? applyProgress(state, item) : false;
	};
	assert.equal(event("thinking_start"), false);
	for (const delta of [undefined, 42, "", " \n\t", "\u00a0"]) {
		assert.equal(event("thinking_delta", delta), false);
		assert.equal(state.thinking, undefined);
	}
	assert.equal(event("thinking_delta", "PRIVATE first"), true);
	for (const delta of ["PRIVATE second".repeat(1000), "", " \n\t".repeat(1000)]) {
		assert.equal(event("thinking_delta", delta), false);
		assert.equal(state.thinking, true);
	}
	assert.doesNotMatch(JSON.stringify(state), /PRIVATE/);
	assert.deepEqual(state.done, []); assert.equal(state.current, undefined);
	assert.equal(event("thinking_end"), false); assert.equal(state.thinking, true);
	assert.equal(event("thinking_start"), true); assert.equal(state.thinking, undefined);
	assert.equal(event("thinking_delta", "new block"), true);
	applyProgress(state, { mark: "→", name: "read", id: "A", args: "a.ts" });
	applyProgress(state, { mark: "→", name: "read", id: "B", args: "b.ts" });
	assert.equal(event("text_start"), true); assert.equal(state.thinking, undefined);
	assert.equal(state.current?.id, "B", "writing cannot displace an open tool");
	applyProgress(state, { mark: "✓", name: "read", id: "B" });
	assert.equal(state.current?.id, "A");
	applyProgress(state, { mark: "✓", name: "read", id: "A" });
	assert.equal(event("text_delta", "answer"), true); assert.equal(state.current?.name, "writing");
	assert.equal(event("text_delta", "more"), false);
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

test("board summary shows running, queued and local-slot counts", () => {
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

test("board summary ignores per-job activity, identity and terminal jobs", () => {
	const jobs = [
		{ id: "d0001", local: true, status: "running", thinking: "PRIVATE", current: { mark: "→" as const, name: "read" }, tg: "tg 40/s" },
		{ id: "d0002", local: true, status: "queued", reason: "gpu" },
		{ id: "d0003", local: false, status: "running", thinking: "SECRET", wrapped: true },
		{ id: "d0004", local: true, status: "done" },
		{ id: "d0005", local: false, status: "failed" },
	];
	const line = formatJobBoard(jobs, { maxLocalConcurrent: 1 });
	assert.deepEqual(line, ["delegate  2 run  1 wait  local 1/1"]);
	assert.doesNotMatch(line[0], /PRIVATE|SECRET|d000|thinking|wrap requested|tg 40/);
	const unsafeJobs = [{ id: "d0001", local: false, status: "running", current: { mark: "→", name: "bad\u001b[2J\nname" } }];
	const unsafe = formatJobBoard(unsafeJobs, { maxLocalConcurrent: 1 });
	assert.equal(unsafe.length, 1); assert.doesNotMatch(unsafe[0], /[\x00-\x1f\x7f-\x9f]/);
});
