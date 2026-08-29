import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { truncateOutput, truncateToUtf8Bytes } from "./policy.ts";

export interface PiInvocation {
	command: string;
	args: string[];
}

export interface ChildDiag {
	command: string;
	args: string[];
	pid?: number;
	hardTimeoutMs: number;
	durationMs: number;
	eventCount: number;
	events: string[];
	sawAssistant: boolean;
}

export interface ChildResult {
	text: string;
	exitCode: number;
	stderrTail: string;
	model?: string;
	stopReason?: string;
	diag?: ChildDiag;
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

export type ChildControl = {
	wrap: (message?: string) => boolean;
};

export type SpawnFn = (
	command: string,
	args: string[],
	options: {
		cwd?: string;
		env?: NodeJS.ProcessEnv;
		shell?: boolean;
		stdio?: unknown;
		detached?: boolean;
	},
) => ChildProcess;

export interface RunPiChildInput {
	cwd: string;
	model: string;
	task: string;
	hardTimeoutMs: number;
	maxOutputBytes: number;
	promptSourcePath: string;
	tmpPrefix: string;
	env: NodeJS.Dict<string>;
	buildArgs: (promptPath: string) => string[];
	signal?: AbortSignal;
	onEvent?: (event: unknown) => void;
	onControl?: (ctl: ChildControl) => void;
	spawnFn?: SpawnFn;
}

export const DEFAULT_WRAP_MESSAGE =
	"Stop starting new work. Finish the current tool if it is already running. Write the remaining answer now.";

const STDERR_TAIL_BYTES = 4096;
const DIALOG_UI_METHODS = new Set(["select", "confirm", "input", "editor"]);

export function jsonlRecordLimit(maxOutputBytes: number): number {
	return Math.min(Math.max(maxOutputBytes * 4, 262144), 1_048_576);
}

const EVENT_TYPE_LIMIT = 20;

export function redactChildArgs(args: string[]): string[] {
	return args.map((arg) => {
		if (!arg.startsWith("Task: ")) return arg;
		return `Task:<redacted ${arg.length - 6} chars>`;
	});
}

export function jsonlEventType(event: unknown): string | undefined {
	if (!event || typeof event !== "object") return undefined;
	const type = (event as { type?: unknown }).type;
	return typeof type === "string" && type.length > 0 ? type : undefined;
}

export function rememberEventType(events: string[], type: string, limit = EVENT_TYPE_LIMIT): void {
	if (events.length < limit) {
		events.push(type);
		return;
	}
	events.shift();
	events.push(type);
}

export function encodeRpc(command: Record<string, unknown>): string {
	return `${JSON.stringify(command)}\n`;
}

export function isAgentSettled(event: unknown): boolean {
	return jsonlEventType(event) === "agent_settled";
}

export function uiCancelResponse(event: unknown): string | undefined {
	if (!event || typeof event !== "object") return undefined;
	const rec = event as { type?: unknown; id?: unknown; method?: unknown };
	if (rec.type !== "extension_ui_request") return undefined;
	if (typeof rec.id !== "string" || rec.id.length === 0) return undefined;
	if (typeof rec.method !== "string" || !DIALOG_UI_METHODS.has(rec.method)) return undefined;
	return encodeRpc({ type: "extension_ui_response", id: rec.id, cancelled: true });
}

export function finalizeChildText(assistantText: string, dump: string, maxBytes: number): string {
	const source = assistantText.length > 0 ? assistantText : dump;
	return truncateOutput(source, maxBytes);
}

export function summarizeChildRun(input: {
	command: string;
	args: string[];
	pid?: number;
	hardTimeoutMs: number;
	durationMs: number;
	eventCount: number;
	events: string[];
	sawAssistant: boolean;
	exitCode: number;
	stopReason?: string;
	stderrTail: string;
}): string {
	const argv = [input.command, ...redactChildArgs(input.args)].join(" ");
	const more = input.eventCount > input.events.length ? "…" : "";
	const events =
		input.eventCount === 0 ? "(none)" : `${input.eventCount} ${JSON.stringify(input.events)}${more}`;
	const stderr = input.stderrTail.trim() ? input.stderrTail.trim() : "(empty)";
	return [
		`cmd: ${argv}`,
		`pid: ${input.pid ?? "none"} hardTimeoutMs: ${input.hardTimeoutMs} durationMs: ${input.durationMs}`,
		`exit: ${input.exitCode} stop: ${input.stopReason ?? "none"} assistant: ${input.sawAssistant ? "yes" : "no"}`,
		`events: ${events}`,
		`stderr: ${stderr}`,
	].join("\n");
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
	const platform = options?.platform ?? process.platform;
	const killProcess = options?.killProcess ?? process.kill;
	const pid = proc.pid;
	const group = platform !== "win32" && typeof pid === "number" && pid > 0;
	const leaderAlive = childStillRunning(proc);
	if (!leaderAlive && !group) return;
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
		try {
			if (group) killProcess(-pid, "SIGKILL");
			else if (childStillRunning(proc)) proc.kill("SIGKILL");
		} catch {
			try {
				proc.kill("SIGKILL");
			} catch {
				/* already gone */
			}
		}
	}, 5000);
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
	stopKind?: "aborted" | "hard_timeout";
	overflow: boolean;
	state: AssistantState;
}): string | undefined {
	if (input.stopKind) return input.stopKind;
	if (input.overflow) return "protocol-error";
	if (input.state.stopReason === "error") return "error";
	if (!input.state.sawAssistant || input.state.text.length === 0) return "no-assistant-output";
	return input.state.stopReason;
}

function writeStdin(stdin: { write: (chunk: string) => unknown; destroyed?: boolean; writableEnded?: boolean } | null, line: string): boolean {
	if (!stdin || stdin.destroyed || stdin.writableEnded) return false;
	try {
		stdin.write(line);
		return true;
	} catch {
		return false;
	}
}

export async function runPiChild(input: RunPiChildInput): Promise<ChildResult> {
	let tmp: { dir: string; filePath: string } | undefined;
	try {
		tmp = writeTempPrompt(input.promptSourcePath, input.tmpPrefix);
		const args = input.buildArgs(tmp.filePath);
		const invocation = getPiInvocation(args);
		const childEnv = { ...input.env } as NodeJS.ProcessEnv;
		const started = Date.now();
		const spawnFn = input.spawnFn ?? spawn;

		let stderr = "";
		let state: AssistantState = { text: "", model: input.model, sawAssistant: false };
		let timedOut = false;
		let aborted = false;
		let stopKind: "aborted" | "hard_timeout" | undefined;
		let overflow = false;
		let settled = false;
		let pid: number | undefined;
		let eventCount = 0;
		const events: string[] = [];
		const recordLimit = jsonlRecordLimit(input.maxOutputBytes);

		const exitCode = await new Promise<number>((resolve, reject) => {
			const proc = spawnFn(invocation.command, invocation.args, {
				cwd: input.cwd,
				env: childEnv,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
				detached: process.platform !== "win32",
			});
			pid = proc.pid;
			let closed = false;
			let hardTimer: ReturnType<typeof setTimeout> | undefined;
			proc.stdin?.on("error", () => {
				/* EPIPE after exit must not crash the parent */
			});

			const finish = (code: number): void => {
				if (closed) return;
				closed = true;
				if (hardTimer) clearTimeout(hardTimer);
				input.signal?.removeEventListener("abort", onAbort);
				resolve(code);
			};

			const send = (command: Record<string, unknown>): boolean => writeStdin(proc.stdin, encodeRpc(command));

			const closeStdin = (): void => {
				try {
					proc.stdin?.end();
				} catch {
					/* already gone */
				}
			};

			const consume = (line: string): void => {
				if (!line.trim()) return;
				try {
					const parsed = JSON.parse(line);
					const type = jsonlEventType(parsed);
					if (type) {
						eventCount += 1;
						rememberEventType(events, type);
					}
					const cancel = uiCancelResponse(parsed);
					if (cancel) writeStdin(proc.stdin, cancel);
					state = applyAssistantSnapshot(state, parsed);
					if (isAgentSettled(parsed) && !settled) {
						settled = true;
						closeStdin();
					}
					try {
						input.onEvent?.(parsed);
					} catch {
						// ignore progress callback errors
					}
				} catch {
					// ignore non-JSON
				}
			};

			const onAbort = (): void => {
				aborted = true;
				if (!stopKind) stopKind = "aborted";
				send({ type: "abort" });
				killChildTree(proc);
			};

			try {
				input.onControl?.({
					wrap: (message) => {
						if (settled || aborted || timedOut || closed) return false;
						return send({ type: "steer", message: message && message.trim() ? message : DEFAULT_WRAP_MESSAGE });
					},
				});
			} catch {
				/* control callback must not break the child */
			}

			if (input.hardTimeoutMs > 0) {
				hardTimer = setTimeout(() => {
					timedOut = true;
					if (!stopKind) stopKind = "hard_timeout";
					killChildTree(proc);
				}, input.hardTimeoutMs);
			}

			if (input.signal) {
				if (input.signal.aborted) onAbort();
				else input.signal.addEventListener("abort", onAbort, { once: true });
			}

			send({ id: "p1", type: "prompt", message: `Task: ${input.task}` });

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
				if (hardTimer) clearTimeout(hardTimer);
				input.signal?.removeEventListener("abort", onAbort);
				reject(error);
			});
			proc.on("close", (code) => {
				if (buffer.trim() && !overflow) consume(buffer);
				finish(code ?? 1);
			});
		});

		const stopReason = resolveStopReason({ stopKind, overflow, state });
		const stderrTail = tailBytes(stderr, STDERR_TAIL_BYTES);
		const diag: ChildDiag = {
			command: invocation.command,
			args: redactChildArgs(invocation.args),
			hardTimeoutMs: input.hardTimeoutMs,
			durationMs: Date.now() - started,
			eventCount,
			events,
			sawAssistant: state.sawAssistant,
		};
		if (pid !== undefined) diag.pid = pid;
		const dump = summarizeChildRun({
			...diag,
			exitCode,
			stopReason,
			stderrTail,
		});
		return {
			text: finalizeChildText(state.text, dump, input.maxOutputBytes),
			exitCode,
			stderrTail,
			model: state.model,
			stopReason,
			diag,
		};
	} finally {
		if (tmp) rmSync(tmp.dir, { recursive: true, force: true });
	}
}

export function promptSourceFromDir(dir: string, name = "child.md"): string {
	return join(dir, "prompts", name);
}
