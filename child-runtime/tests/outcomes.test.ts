import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { JobScheduler } from "../../delegate/jobs.ts";
import { buildNotifyPayload } from "../../delegate/notify.ts";
import { isLocalModel } from "../../delegate/tg.ts";
import { isFailedChildResult } from "../policy.ts";
import { encodeRpc, type RunPiChildInput } from "../spawn.ts";
import { mockChild, runMockPiChild } from "./helpers.ts";

const PROMPT = fileURLToPath(new URL("../../delegate/prompts/recon.md", import.meta.url));

function start(t: TestContext, overrides: Partial<RunPiChildInput> = {}) {
	const proc = mockChild();
	const pending = runMockPiChild({
		cwd: process.cwd(), model: "ollama/qwen3:8b", task: "mock-only outcome regression",
		hardTimeoutMs: 0, maxOutputBytes: 65536, promptSourcePath: PROMPT,
		env: {}, buildArgs: () => [], spawnFn: () => proc,
		...overrides,
	});
	t.after(async () => { proc.close(1); await pending; });
	return {
		pending,
		emit: (event: unknown) => proc.stdout!.write(encodeRpc(event as Record<string, unknown>)),
	};
}

function assistant(overrides: Record<string, unknown> = {}) {
	return { type: "message_end", message: {
		role: "assistant", provider: "ollama", model: "qwen3:8b", stopReason: "stop",
		content: [{ type: "text", text: "complete" }], ...overrides,
	} };
}

for (const partial of ["", "unfinished answer", "x".repeat(10000)]) {
	test(`provider error survives ${partial.length} bytes of partial output and the return cap`, async (t) => {
		const { pending, emit } = start(t, { maxOutputBytes: 160 });
		emit(assistant({
			stopReason: "error", errorMessage: "socket disconnected",
			content: [{ type: "text", text: partial }],
		}));
		emit({ type: "agent_settled" });
		const result = await pending;
		assert.equal(isFailedChildResult(result), true);
		assert.equal(result.stopReason, "error");
		assert.ok(result.text.startsWith("socket disconnected"), "error must precede any partial output");
		assert.ok(Buffer.byteLength(result.text) <= 160);
		if (partial && partial.length < 160) assert.ok(result.text.includes(partial));
	});
}

test("a successful retry replaces the previous provider error", async (t) => {
	const { pending, emit } = start(t);
	emit(assistant({ stopReason: "error", errorMessage: "transient provider error" }));
	emit({ type: "agent_end", willRetry: true });
	emit(assistant());
	emit({ type: "agent_settled" });
	const result = await pending;
	assert.equal(isFailedChildResult(result), false);
	assert.equal(result.text, "complete");
});

for (const content of [[], [{ type: "text", text: "partial answer" }]]) {
	test(`token limit is an explicit failure with ${content.length} text blocks`, async (t) => {
		const { pending, emit } = start(t);
		emit(assistant({ stopReason: "length", content }));
		emit({ type: "agent_settled" });
		const result = await pending;
		assert.equal(result.stopReason, "length");
		assert.equal(isFailedChildResult(result), true);
		assert.match(result.text, /token limit/i);
		assert.match(result.text, /incomplete/i);
		if (content.length) assert.ok(result.text.includes("partial answer"));

		const scheduler = new JobScheduler({ maxConcurrent: 1, maxLocalConcurrent: 1, maxQueued: 1 });
		t.after(() => scheduler.shutdown());
		const job = scheduler.enqueue({
			kind: "recon", model: "ollama/qwen3:8b", local: true, task: "cutoff",
			timeoutMs: 1000, background: true, run: async () => result,
		});
		const done = await scheduler.wait(job.id);
		assert.equal(done.status, "failed");
		assert.equal(done.failed, true);
		const notice = buildNotifyPayload(done);
		assert.equal(notice.display, true);
		assert.match(notice.content, /token limit/i);
	});
}

test("token-limit explanation survives output truncation", async (t) => {
	const { pending, emit } = start(t, { maxOutputBytes: 160 });
	emit(assistant({ stopReason: "length", content: [{ type: "text", text: "x".repeat(10000) }] }));
	emit({ type: "agent_settled" });
	const result = await pending;
	assert.match(result.text, /token limit/i);
	assert.match(result.text, /truncated/);
	assert.ok(Buffer.byteLength(result.text) <= 160);
});

for (const [provider, model] of [
	["ollama", "qwen3:8b"],
	["local-qwen38", "qwen38-q4km"],
	["openai-codex", "gpt-5.6-luna"],
	["openrouter", "openrouter/auto"], // A model ID may itself contain the provider name and slash.
]) {
	test(`completed model identity preserves ${provider}/${model}`, async (t) => {
		const { pending, emit } = start(t, { model: `${provider}/pattern` });
		emit(assistant({ provider, model }));
		emit({ type: "agent_settled" });
		const result = await pending;
		const expected = `${provider}/${model}`;
		assert.equal(result.model, expected);
		const scheduler = new JobScheduler({ maxConcurrent: 1, maxLocalConcurrent: 1, maxQueued: 1 });
		t.after(() => scheduler.shutdown());
		const job = scheduler.enqueue({
			kind: "recon", model: `${provider}/pattern`, local: isLocalModel(expected), task: "model",
			timeoutMs: 1000, run: async () => result,
		});
		const done = await scheduler.wait(job.id);
		assert.equal(done.model, expected);
		assert.equal(isLocalModel(done.model), isLocalModel(expected));
	});
}

test("incomplete later metadata preserves the last resolved model, not the original pattern", async (t) => {
	const { pending, emit } = start(t, { model: "ollama/qwen*" });
	emit(assistant());
	emit(assistant({ provider: undefined, model: "namespace/model" }));
	emit({ type: "agent_settled" });
	assert.equal((await pending).model, "ollama/qwen3:8b");
});

for (const metadata of [
	{ provider: undefined, model: "qwen3:8b" },
	{ provider: undefined, model: "namespace/model" },
	{ provider: "ollama", model: undefined },
	{ provider: "", model: "qwen3:8b" },
]) {
	test(`incomplete model metadata retains the configured identity: ${JSON.stringify(metadata)}`, async (t) => {
		const { pending, emit } = start(t);
		emit(assistant(metadata));
		emit({ type: "agent_settled" });
		assert.equal((await pending).model, "ollama/qwen3:8b");
	});
}
