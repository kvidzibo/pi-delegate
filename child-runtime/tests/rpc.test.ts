import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	DEFAULT_WRAP_MESSAGE,
	encodeRpc,
	isAgentSettled,
	uiCancelResponse,
	type ChildControl,
	type SpawnFn,
} from "../spawn.ts";
import { mockChild, runMockPiChild as runPiChild } from "./helpers.ts";

test("unreadable archive prompt refuses to spawn", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-delegate-prompt-"));
	try {
		await assert.rejects(runPiChild({ cwd: dir, model: "fixture", task: "fixture", hardTimeoutMs: 0,
			maxOutputBytes: 100, promptSourcePath: join(dir, "missing.md"), env: {}, buildArgs: () => [],
			spawnFn: () => { assert.fail("must not spawn without readable prompt"); },
		}), /ENOENT/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rpc helpers", () => {
	assert.equal(encodeRpc({ type: "abort" }), '{"type":"abort"}\n');
	assert.equal(isAgentSettled({ type: "agent_settled" }), true);
	assert.equal(isAgentSettled({ type: "agent_end" }), false);
	assert.equal(
		uiCancelResponse({ type: "extension_ui_request", id: "u1", method: "confirm" }),
		encodeRpc({ type: "extension_ui_response", id: "u1", cancelled: true }),
	);
	assert.equal(uiCancelResponse({ type: "extension_ui_request", id: "u1", method: "notify" }), undefined);
	assert.ok(DEFAULT_WRAP_MESSAGE.includes("Write the remaining answer"));
});

test("rpc child prompts, settles, closes stdin, returns assistant text", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-delegate-rpc-"));
	const prompt = join(dir, "prompt.md");
	writeFileSync(prompt, "sys");
	const proc = mockChild();
	const spawnFn: SpawnFn = () => proc;
	queueMicrotask(() => {
		assert.match(proc.stdinBytes, /"type":"prompt"/);
		assert.match(proc.stdinBytes, /Task: list files/);
		proc.stdout?.write(
			`${JSON.stringify({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "hello from child" }] },
			})}\n`,
		);
		proc.stdout?.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
	});
	try {
		const result = await runPiChild({
			cwd: dir,
			model: "local-qwen38/qwen38-q4km",
			task: "list files",
			hardTimeoutMs: 0,
			maxOutputBytes: 65536,
			promptSourcePath: prompt,
			env: process.env,
			buildArgs: (promptPath) => {
				assert.equal(promptPath, prompt, "use the retained archive prompt directly");
				return ["--mode", "rpc", "--system-prompt", promptPath];
			},
			spawnFn,
		});
		assert.equal(readFileSync(prompt, "utf8"), "sys", "runtime must not remove the archive prompt");
		assert.equal(result.text, "hello from child");
		assert.equal(result.exitCode, 0);
		assert.equal(result.stopReason, undefined);
		assert.equal(result.diag?.hardTimeoutMs, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("wrap writes steer; ui confirm is cancelled", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-delegate-rpc-"));
	const prompt = join(dir, "prompt.md");
	writeFileSync(prompt, "sys");
	const proc = mockChild();
	let control: ChildControl | undefined;
	const spawnFn: SpawnFn = () => proc;
	queueMicrotask(() => {
		proc.stdout?.write(
			`${JSON.stringify({ type: "extension_ui_request", id: "dlg", method: "confirm", message: "Allow?" })}\n`,
		);
		assert.equal(control?.wrap("wrap now"), true);
		assert.match(proc.stdinBytes, /"type":"steer"/);
		assert.match(proc.stdinBytes, /wrap now/);
		assert.match(proc.stdinBytes, /extension_ui_response/);
		assert.match(proc.stdinBytes, /"cancelled":true/);
		proc.stdout?.write(
			`${JSON.stringify({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "wrapped" }] },
			})}\n`,
		);
		proc.stdout?.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
	});
	try {
		const result = await runPiChild({
			cwd: dir,
			model: "x",
			task: "t",
			hardTimeoutMs: 0,
			maxOutputBytes: 65536,
			promptSourcePath: prompt,
			env: process.env,
			buildArgs: () => ["--mode", "rpc"],
			spawnFn,
			onControl: (ctl) => {
				control = ctl;
			},
		});
		assert.equal(result.text, "wrapped");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("stdin EPIPE after writes does not reject", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-delegate-rpc-"));
	const prompt = join(dir, "prompt.md");
	writeFileSync(prompt, "sys");
	const proc = mockChild();
	const origWrite = proc.stdin?.write.bind(proc.stdin);
	proc.stdin!.write = ((chunk: string, encoding?: BufferEncoding, cb?: (error?: Error | null) => void) => {
		const ok = origWrite ? origWrite(chunk, encoding as never, cb as never) : true;
		queueMicrotask(() => {
			proc.stdin?.emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" }));
		});
		return ok;
	}) as typeof proc.stdin.write;
	const spawnFn: SpawnFn = () => proc;
	queueMicrotask(() => {
		proc.stdout?.write(
			`${JSON.stringify({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
			})}\n`,
		);
		proc.stdout?.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
	});
	try {
		const result = await runPiChild({
			cwd: dir,
			model: "x",
			task: "t",
			hardTimeoutMs: 0,
			maxOutputBytes: 65536,
			promptSourcePath: prompt,
			env: process.env,
			buildArgs: () => ["--mode", "rpc"],
			spawnFn,
		});
		assert.equal(result.text, "ok");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("hard timeout then abort still reports hard_timeout", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-delegate-rpc-"));
	const prompt = join(dir, "prompt.md");
	writeFileSync(prompt, "sys");
	const proc = mockChild();
	proc.kill = () => true;
	const spawnFn: SpawnFn = () => proc;
	const ac = new AbortController();
	try {
		const pending = runPiChild({
			cwd: dir,
			model: "x",
			task: "t",
			hardTimeoutMs: 20,
			maxOutputBytes: 65536,
			promptSourcePath: prompt,
			env: process.env,
			buildArgs: () => ["--mode", "rpc"],
			spawnFn,
			signal: ac.signal,
		});
		await new Promise((resolve) => setTimeout(resolve, 35));
		ac.abort();
		await new Promise((resolve) => setTimeout(resolve, 10));
		proc.emit("close", 1);
		const result = await pending;
		assert.equal(result.stopReason, "hard_timeout");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("hard timeout kills and reports hard_timeout", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-delegate-rpc-"));
	const prompt = join(dir, "prompt.md");
	writeFileSync(prompt, "sys");
	const proc = mockChild();
	const spawnFn: SpawnFn = () => proc;
	try {
		const result = await runPiChild({
			cwd: dir,
			model: "x",
			task: "t",
			hardTimeoutMs: 20,
			maxOutputBytes: 65536,
			promptSourcePath: prompt,
			env: process.env,
			buildArgs: () => ["--mode", "rpc"],
			spawnFn,
		});
		assert.equal(result.stopReason, "hard_timeout");
		assert.equal(readFileSync(prompt, "utf8"), "sys", "timeouts retain the archive prompt");
		assert.equal(result.exitCode, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
