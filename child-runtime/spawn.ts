import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { truncateOutput, truncateToUtf8Bytes } from "./policy.ts";

export interface PiInvocation {
	command: string;
	args: string[];
}

export interface ChildResult {
	text: string;
	exitCode: number;
	stderrTail: string;
	model?: string;
	stopReason?: string;
}

export interface AssistantSnapshot {
	assistant: boolean;
	text: string;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

export interface AssistantState {
	text: string;
	model: string;
	stopReason?: string;
	sawAssistant: boolean;
}

export interface RunPiChildInput {
	cwd: string;
	model: string;
	timeoutMs: number;
	maxOutputBytes: number;
	promptSourcePath: string;
	tmpPrefix: string;
	env: NodeJS.Dict<string>;
	buildArgs: (promptPath: string) => string[];
	signal?: AbortSignal;
	onEvent?: (event: unknown) => void;
	onParsed?: (event: unknown) => void;
}

const STDERR_TAIL_BYTES = 4096;

export function jsonlRecordLimit(maxOutputBytes: number): number {
	return Math.min(Math.max(maxOutputBytes * 4, 262144), 1_048_576);
}

export function getPiInvocation(args: string[]): PiInvocation {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

export function extractAssistantText(event: unknown): AssistantSnapshot {
	const empty: AssistantSnapshot = { assistant: false, text: "" };
	if (!event || typeof event !== "object") return empty;
	const record = event as { type?: unknown; message?: unknown };
	if (record.type !== "message_end" || !record.message || typeof record.message !== "object") return empty;
	const message = record.message as {
		role?: unknown;
		model?: unknown;
		stopReason?: unknown;
		errorMessage?: unknown;
		content?: unknown;
	};
	if (message.role !== "assistant") return empty;
	let text = "";
	if (Array.isArray(message.content)) {
		for (let i = message.content.length - 1; i >= 0; i--) {
			const part = message.content[i];
			if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
				const value = (part as { text?: unknown }).text;
				if (typeof value === "string" && value.length > 0) {
					text = value;
					break;
				}
			}
		}
	}
	const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
	return {
		assistant: true,
		text: text || errorMessage || "",
		model: typeof message.model === "string" ? message.model : undefined,
		stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
		errorMessage,
	};
}

export function applyAssistantSnapshot(current: AssistantState, event: unknown): AssistantState {
	const snap = extractAssistantText(event);
	if (!snap.assistant) return current;
	return {
		text: snap.text,
		model: snap.model ?? current.model,
		stopReason: snap.stopReason,
		sawAssistant: true,
	};
}

export function childStillRunning(proc: { exitCode: number | null; signalCode?: NodeJS.Signals | null }): boolean {
	return proc.exitCode === null && proc.signalCode == null;
}

type TimeoutHandle = { unref?: () => TimeoutHandle };

export function killChildTree(
	proc: {
		pid?: number;
		exitCode: number | null;
		signalCode?: NodeJS.Signals | null;
		kill: (signal?: NodeJS.Signals) => boolean;
	},
	options?: {
		platform?: NodeJS.Platform;
		killProcess?: (pid: number, signal: NodeJS.Signals) => void;
		setTimeoutFn?: (fn: () => void, ms: number) => TimeoutHandle;
	},
): void {
	if (!childStillRunning(proc)) return;
	const platform = options?.platform ?? process.platform;
	const killProcess = options?.killProcess ?? process.kill;
	const pid = proc.pid;
	const group = platform !== "win32" && typeof pid === "number" && pid > 0;
	try {
		if (group) killProcess(-pid, "SIGTERM");
		else proc.kill("SIGTERM");
	} catch {
		try {
			proc.kill("SIGTERM");
		} catch {
			/* already gone */
		}
	}
	const later = options?.setTimeoutFn ?? setTimeout;
	const timer = later(() => {
		if (!childStillRunning(proc)) return;
		try {
			if (group) killProcess(-pid, "SIGKILL");
			else proc.kill("SIGKILL");
		} catch {
			try {
				proc.kill("SIGKILL");
			} catch {
				/* already gone */
			}
		}
	}, 5000);
	timer.unref?.();
}

export function tailBytes(text: string, maxBytes: number): string {
	const buf = Buffer.from(text, "utf8");
	if (buf.byteLength <= maxBytes) return text;
	return truncateToUtf8Bytes(buf.subarray(buf.byteLength - maxBytes).toString("utf8"), maxBytes);
}

function writeTempPrompt(sourcePath: string, tmpPrefix: string): { dir: string; filePath: string } {
	const dir = mkdtempSync(join(tmpdir(), tmpPrefix));
	try {
		const filePath = join(dir, "prompt.md");
		writeFileSync(filePath, readFileSync(sourcePath), { encoding: "utf8", mode: 0o600 });
		return { dir, filePath };
	} catch (error) {
		rmSync(dir, { recursive: true, force: true });
		throw error;
	}
}

function resolveStopReason(input: {
	aborted: boolean;
	timedOut: boolean;
	overflow: boolean;
	state: AssistantState;
}): string | undefined {
	if (input.aborted) return "aborted";
	if (input.timedOut) return "timeout";
	if (input.overflow) return "protocol-error";
	if (input.state.stopReason === "error") return "error";
	if (!input.state.sawAssistant || input.state.text.length === 0) return "no-assistant-output";
	return input.state.stopReason;
}

export async function runPiChild(input: RunPiChildInput): Promise<ChildResult> {
	let tmp: { dir: string; filePath: string } | undefined;
	try {
		tmp = writeTempPrompt(input.promptSourcePath, input.tmpPrefix);
		const args = input.buildArgs(tmp.filePath);
		const invocation = getPiInvocation(args);
		const childEnv = { ...input.env } as NodeJS.ProcessEnv;

		let stderr = "";
		let state: AssistantState = { text: "", model: input.model, sawAssistant: false };
		let timedOut = false;
		let aborted = false;
		let overflow = false;
		const recordLimit = jsonlRecordLimit(input.maxOutputBytes);
		const consume = (line: string): void => {
			if (!line.trim()) return;
			try {
				const parsed = JSON.parse(line);
				try {
					input.onParsed?.(parsed);
				} catch {
					// ignore session-header callback errors
				}
				state = applyAssistantSnapshot(state, parsed);
				try {
					input.onEvent?.(parsed);
				} catch {
					// ignore progress callback errors
				}
			} catch {
				// ignore non-JSON
			}
		};

		const exitCode = await new Promise<number>((resolve, reject) => {
			const proc = spawn(invocation.command, invocation.args, {
				cwd: input.cwd,
				env: childEnv,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				detached: process.platform !== "win32",
			});

			const timer = setTimeout(() => {
				timedOut = true;
				killChildTree(proc);
			}, input.timeoutMs);
			timer.unref();

			const onAbort = (): void => {
				aborted = true;
				killChildTree(proc);
			};
			if (input.signal) {
				if (input.signal.aborted) onAbort();
				else input.signal.addEventListener("abort", onAbort, { once: true });
			}

			proc.stdout?.setEncoding("utf8");
			proc.stderr?.setEncoding("utf8");
			let buffer = "";
			proc.stdout?.on("data", (chunk: string) => {
				buffer += chunk;
				if (Buffer.byteLength(buffer, "utf8") > recordLimit) {
					overflow = true;
					buffer = "";
					killChildTree(proc);
					return;
				}
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) consume(line);
			});
			proc.stderr?.on("data", (chunk: string) => {
				stderr += chunk;
				if (Buffer.byteLength(stderr, "utf8") > STDERR_TAIL_BYTES * 4) {
					stderr = tailBytes(stderr, STDERR_TAIL_BYTES);
				}
			});
			proc.on("error", (error) => {
				clearTimeout(timer);
				input.signal?.removeEventListener("abort", onAbort);
				reject(error);
			});
			proc.on("close", (code) => {
				clearTimeout(timer);
				input.signal?.removeEventListener("abort", onAbort);
				if (buffer.trim() && !overflow) consume(buffer);
				resolve(code ?? 1);
			});
		});

		return {
			text: truncateOutput(state.text, input.maxOutputBytes),
			exitCode,
			stderrTail: tailBytes(stderr, STDERR_TAIL_BYTES),
			model: state.model,
			stopReason: resolveStopReason({ aborted, timedOut, overflow, state }),
		};
	} finally {
		if (tmp) rmSync(tmp.dir, { recursive: true, force: true });
	}
}

export function promptSourceFromDir(dir: string, name = "child.md"): string {
	return join(dir, "prompts", name);
}

export function configPathFromDir(dir: string): string {
	return join(dir, "config.json");
}
