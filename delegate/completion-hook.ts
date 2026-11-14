import { spawn } from "node:child_process";
import type { CompletionHookConfig } from "./config.ts";

export type CompletionHookResult = {
	status: "running" | "succeeded" | "failed" | "timed_out";
	durationMs: number;
	exitCode?: number | null;
	signal?: string | null;
	error?: string;
	stderrTail?: string;
};

/** Trusted configured executable; model output is data on stdin, never shell syntax. */
export async function runCompletionHook(config: CompletionHookConfig, payload: unknown, cwd: string): Promise<CompletionHookResult> {
	const input = `${JSON.stringify(payload)}\n`;
	const started = Date.now();
	return new Promise(resolve => {
		let timedOut = false;
		let error: string | undefined;
		let stderr = Buffer.alloc(0);
		const child = spawn(config.command[0], config.command.slice(1), {
			cwd, shell: false, detached: process.platform !== "win32", stdio: ["pipe", "ignore", "pipe"],
		});
		const timer = setTimeout(() => {
			timedOut = true;
			// Only our own detached process group. No shell, retries or daemonized work.
			try {
				if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch { try { child.kill("SIGKILL"); } catch { /* already exited */ } }
			child.stdin.destroy(); child.stderr.destroy();
		}, config.timeoutMs);
		child.stderr.on("data", (chunk: Buffer) => { stderr = Buffer.concat([stderr, chunk]).subarray(-4096); });
		child.stdin.on("error", err => { error ??= `Hook stdin: ${err.message}`; });
		child.on("error", err => { error ??= err.message; });
		child.on("close", (exitCode, signal) => {
			clearTimeout(timer);
			resolve({ status: timedOut ? "timed_out" : exitCode === 0 && !error ? "succeeded" : "failed",
				durationMs: Math.max(0, Date.now() - started), exitCode, signal,
				...(error ? { error } : {}), ...(stderr.length ? { stderrTail: stderr.toString("utf8") } : {}) });
		});
		child.stdin.end(input);
	});
}

/** Keep diagnostics separate from the worker report and its verdict. */
export function completionHookContent(value: unknown): Array<{ type: "text"; text: string }> {
	if (!value || typeof value !== "object") return [];
	const hook = value as CompletionHookResult;
	if (!["running", "succeeded", "failed", "timed_out"].includes(hook.status)) return [];
	const status = hook.status === "timed_out" ? "timed out" : hook.status;
	return [{ type: "text", text: `Completion hook: ${status}${typeof hook.exitCode === "number" ? ` (exit ${hook.exitCode})` : ""}. Worker outcome unchanged.` }];
}
