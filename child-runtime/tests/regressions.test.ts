import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { JobScheduler } from "../../delegate/jobs.ts";
import { isFailedChildResult } from "../policy.ts";
import { encodeRpc, extractAssistantText, type RunPiChildInput } from "../spawn.ts";
import { mockChild, runMockPiChild } from "./helpers.ts";

const PROMPT = fileURLToPath(new URL("../../delegate/prompts/recon.md", import.meta.url));
const MiB = 1024 * 1024;

function childInput(overrides: Partial<RunPiChildInput> = {}): RunPiChildInput {
	return {
		cwd: process.cwd(), model: "test/model", task: "mock-only regression",
		hardTimeoutMs: 0, maxOutputBytes: 65536, promptSourcePath: PROMPT,
		env: {}, buildArgs: () => [], ...overrides,
	};
}

function start(t: TestContext, overrides: Partial<RunPiChildInput> = {}) {
	const proc = mockChild();
	const pending = runMockPiChild(childInput({ spawnFn: () => proc, ...overrides }));
	t.after(async () => { proc.close(1); await pending; });
	const emit = (event: unknown) => proc.stdout!.write(`${JSON.stringify(event)}\n`);
	const answer = (text = "complete") => emit({
		type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] },
	});
	return { proc, pending, emit, answer };
}

async function within<T>(pending: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			pending,
			new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("child did not finish")), 250); }),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

test("mock cancellation uses injected termination even with an OS-looking pid", async (t) => {
	const ac = new AbortController();
	const { proc, pending } = start(t, { signal: ac.signal });
	proc.pid = 4242;
	const attempted: unknown[] = [];
	// Guard this test as well: an accidental real signal must never reach the OS.
	const originalKill = process.kill;
	// Use a stable deny function: even a delayed callback retaining it stays safe
	// after teardown restores process.kill on the process object.
	process.kill = ((...args: unknown[]) => { attempted.push(args); throw new Error("OS signal forbidden"); }) as typeof process.kill;
	t.after(() => { process.kill = originalKill; });
	ac.abort();
	assert.equal((await within(pending)).stopReason, "aborted");
	assert.deepEqual(attempted, []);
	assert.deepEqual(proc.signals, ["SIGTERM"]);
});

test("rejected initial RPC prompt closes stdin, fails promptly and preserves the error", async (t) => {
	const { proc, pending, emit } = start(t);
	emit({ id: "p1", type: "response", command: "prompt", success: false, error: "No API key for test/model" });
	const result = await within(pending);
	assert.equal(isFailedChildResult(result), true);
	assert.equal(result.stopReason, "error");
	assert.match(result.text, /No API key for test\/model/);
	assert.equal(proc.stdin!.writableEnded, true);
	assert.deepEqual(proc.signals, ["SIGTERM"]);
});

test("successful and unrelated RPC responses do not terminate a child", async (t) => {
	const { proc, pending, emit, answer } = start(t);
	emit({ id: "other", type: "response", command: "prompt", success: false, error: "unrelated" });
	emit({ type: "response", command: "steer", success: false, error: "unrelated" });
	emit({ id: "p1", type: "response", command: "prompt", success: true });
	assert.equal(proc.stdin!.writableEnded, false);
	answer();
	emit({ type: "agent_settled" });
	assert.equal((await within(pending)).text, "complete");
});

test("prompt rejection releases the local scheduler slot", async (t) => {
	const proc = mockChild();
	const scheduler = new JobScheduler({ maxConcurrent: 2, maxLocalConcurrent: 1, maxQueued: 2 });
	t.after(async () => { proc.close(1); await scheduler.shutdown(); });
	const base = { kind: "recon" as const, model: "test/model", local: true, task: "t", timeoutMs: 1000 };
	const first = scheduler.enqueue({ ...base, run: (_job, signal) => runMockPiChild(childInput({ spawnFn: () => proc, signal })) });
	const second = scheduler.enqueue({ ...base, run: async () => ({ text: "next", exitCode: 0, stderrTail: "" }) });
	assert.equal(second.status, "queued");
	proc.stdout!.write(encodeRpc({ id: "p1", type: "response", command: "prompt", success: false, error: "rejected" }));
	assert.equal((await scheduler.wait(first.id, { timeoutMs: 250 })).status, "failed");
	assert.equal((await scheduler.wait(second.id, { timeoutMs: 250 })).answer, "next");
});

test("multiple final text blocks are preserved in source order without thinking or tools", () => {
	const result = extractAssistantText({ type: "message_end", message: {
		role: "assistant", stopReason: "stop", content: [
			{ type: "text", text: "First finding." }, { type: "thinking", thinking: "private" },
			{ type: "text", text: "" }, { type: "toolCall", name: "read" }, { type: "text", text: "Second finding." },
		],
	} });
	assert.equal(result.text, "First finding.\nSecond finding.");
});

test("six ordinary file reads in cumulative agent_end do not kill a successful child", async (t) => {
	const { proc, pending, emit, answer } = start(t);
	const messages = Array.from({ length: 6 }, () => ({ role: "toolResult", content: [{ type: "text", text: "x".repeat(48 * 1024) }] }));
	for (const message of messages) emit({ type: "message_end", message });
	answer();
	emit({ type: "agent_end", messages });
	emit({ type: "agent_settled" });
	assert.equal((await within(pending)).text, "complete");
	assert.deepEqual(proc.signals, []);
});

test("JSONL limits apply per record, not to multiple records sharing one pipe chunk", async (t) => {
	const { proc, pending } = start(t);
	const message = (text: string) => ({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
	const first = `${JSON.stringify(message("x".repeat(240 * 1024)))}\n`;
	const second = `${JSON.stringify(message("last"))}\n`;
	proc.stdout!.write(first.slice(0, 230 * 1024));
	proc.stdout!.write(first.slice(230 * 1024) + encodeRpc({ type: "agent_end", messages: ["x".repeat(40 * 1024)] }) + second);
	proc.stdout!.write(encodeRpc({ type: "agent_settled" }));
	const result = await within(pending);
	assert.equal(result.text, "last");
	assert.equal(isFailedChildResult(result), false);
});

test("large useful events are independent of a small final-answer byte budget", async (t) => {
	const { pending, emit, answer } = start(t, { maxOutputBytes: 257 });
	answer("é".repeat(200000));
	emit({ type: "agent_settled" });
	const result = await within(pending);
	assert.equal(isFailedChildResult(result), false);
	assert.ok(Buffer.byteLength(result.text) <= 257);
	assert.match(result.text, /truncated/);
});

for (const type of ["agent_end", "turn_end"]) {
	test(`oversized unused ${type} is discarded without losing subsequent records`, async (t) => {
		const { pending, emit, answer, proc } = start(t);
		answer();
		emit({ type, messages: ["x".repeat(9 * MiB)] });
		emit({ type: "agent_settled" });
		const result = await within(pending);
		assert.equal(isFailedChildResult(result), false);
		assert.equal(result.text, "complete");
		assert.deepEqual(proc.signals, []);
	});
}

test("large image tool-result message can be skipped without failing the task", async (t) => {
	const { pending, emit, answer, proc } = start(t);
	const content = [{ type: "image", mimeType: "image/png", data: "A".repeat(9 * MiB) }];
	emit({ type: "tool_execution_end", toolName: "read", toolCallId: "image", result: { content }, isError: false });
	emit({ type: "message_start", message: { role: "toolResult", content } });
	emit({ type: "message_end", message: { role: "toolResult", content } });
	answer("image inspected");
	emit({ type: "agent_settled" });
	const result = await within(pending);
	assert.equal(result.text, "image inspected");
	assert.equal(isFailedChildResult(result), false);
	assert.deepEqual(proc.signals, []);
});

test("oversized assistant output fails explicitly instead of returning a stale answer", async (t) => {
	const { pending, answer } = start(t);
	answer("interim");
	answer("x".repeat(9 * MiB));
	const result = await within(pending);
	assert.equal(result.stopReason, "protocol-error");
	assert.match(result.text, /RPC.*limit/i);
});

test("unterminated oversized junk is bounded and terminates the child", async (t) => {
	const { pending, proc } = start(t);
	for (let i = 0; i < 9; i++) proc.stdout!.write("x".repeat(MiB));
	assert.equal((await within(pending)).stopReason, "protocol-error");
	assert.deepEqual(proc.signals, ["SIGTERM"]);
});

test("rejected prompt wins over later abort/timeout even when the process exits zero", async (t) => {
	const ac = new AbortController();
	const { proc, pending, emit } = start(t, { signal: ac.signal, hardTimeoutMs: 20 });
	const close = proc.close;
	proc.close = () => {}; // Hold process close so all terminal causes can race.
	try {
		emit({ id: "p1", type: "response", command: "prompt", success: false, error: "first rejection" });
		ac.abort();
		await new Promise((resolve) => setTimeout(resolve, 35));
		assert.deepEqual(proc.signals, ["SIGTERM"]);
	} finally {
		proc.close = close;
		close(0);
	}
	const result = await within(pending);
	assert.equal(result.exitCode, 0);
	assert.equal(result.stopReason, "error");
	assert.equal(result.text, "first rejection");
	assert.equal(isFailedChildResult(result), true);
});

for (const cause of ["aborted", "hard_timeout"] as const) {
	test(`${cause} wins over a later prompt rejection`, async (t) => {
		const ac = new AbortController();
		const { proc, pending, emit } = start(t, { signal: ac.signal, hardTimeoutMs: cause === "hard_timeout" ? 20 : 0 });
		const close = proc.close;
		proc.close = () => {};
		try {
			if (cause === "aborted") ac.abort();
			else await new Promise((resolve) => setTimeout(resolve, 35));
			emit({ id: "p1", type: "response", command: "prompt", success: false, error: "late rejection" });
		} finally {
			proc.close = close;
			close(0);
		}
		const result = await within(pending);
		assert.equal(result.stopReason, cause);
		assert.equal(result.text.includes("late rejection"), false);
		assert.equal(isFailedChildResult(result), true);
	});
}

test("pre-aborted runs do not send a prompt", async (t) => {
	const ac = new AbortController();
	ac.abort();
	const { proc, pending } = start(t, { signal: ac.signal });
	assert.equal((await within(pending)).stopReason, "aborted");
	assert.equal(proc.stdinBytes.includes('"type":"prompt"'), false);
});

test("oversized tool-call arguments fail explicitly", async (t) => {
	const { pending, emit } = start(t);
	emit({ type: "tool_execution_start", toolName: "write", toolCallId: "big", args: { path: "data", content: "x".repeat(9 * MiB) } });
	const result = await within(pending);
	assert.equal(result.stopReason, "protocol-error");
	assert.match(result.text, /RPC.*limit/);
});

test("CRLF, Unicode separators and split UTF-8 survive RPC framing", async (t) => {
	const { pending, proc } = start(t);
	const text = "line\u2028one\u2029two é 😄";
	const bytes = Buffer.from(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\r\n" + '{"type":"agent_settled"}');
	for (const byte of bytes) proc.stdout!.write(Buffer.from([byte]));
	proc.close(0);
	assert.equal((await within(pending)).text, text);
});
