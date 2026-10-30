import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_TIMER_MS, truncateOutput, truncateToUtf8Bytes } from "./policy.ts";
import { canDiscardOversizedEvent, JsonlReader, RPC_RECORD_LIMIT_BYTES } from "./jsonl.ts";
import { AnswerHistory, answerExplanation } from "./answers.ts";
import type { ResponseEvidence } from "./evidence.ts";
import { verifyLease, type InheritedLease } from "./lease.ts";
import { LEASE_ENV, LeaseStartup } from "./lease-startup.ts";
import type { FinalizationProgress } from "./guard-protocol.ts";

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
	recordingError?: string;
	finalization?: FinalizationProgress;
	evidence?: ResponseEvidence;
}

export interface AssistantSnapshot {
	assistant: boolean;
	text: string;
	provider?: string;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

export interface AssistantState {
	text: string;
	model: string;
	stopReason?: string;
	errorMessage?: string;
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
	env: NodeJS.Dict<string>;
	buildArgs: (promptPath: string) => string[];
	signal?: AbortSignal;
	onEvent?: (event: unknown) => void;
	onControl?: (ctl: ChildControl) => void;
	/** Optional fail-closed startup handshake, before the task is sent to the child. */
	beforePrompt?: (signal: AbortSignal) => Promise<void>;
	/** Borrowed locked descriptor, inherited by the child; requires lease startup acknowledgement. */
	resourceLease?: InheritedLease;
	/** Explicit lease-only handshake. No runtime/tool policy changes. */
	leaseStartupMs?: number;
	spawnFn?: SpawnFn;
	killTree?: (proc: ChildProcess) => void;
}

export const DEFAULT_WRAP_MESSAGE =
	"Stop starting new work. Finish the current tool if it is already running. Write the remaining answer now.";

const STDERR_TAIL_BYTES = 4096;
const DIALOG_UI_METHODS = new Set(["select", "confirm", "input", "editor"]);

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

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
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
		provider?: unknown;
		model?: unknown;
		stopReason?: unknown;
		errorMessage?: unknown;
		content?: unknown;
	};
	if (message.role !== "assistant") return empty;
	const blocks: string[] = [];
	if (Array.isArray(message.content)) {
		for (const part of message.content) {
			if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
				const value = (part as { text?: unknown }).text;
				if (typeof value === "string" && value.length > 0) blocks.push(value);
			}
		}
	}
	const text = blocks.join("\n");
	const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
	return {
		assistant: true,
		text,
		provider: typeof message.provider === "string" ? message.provider.trim() || undefined : undefined,
		model: typeof message.model === "string" ? message.model.trim() || undefined : undefined,
		stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
		errorMessage,
	};
}

export function applyAssistantSnapshot(current: AssistantState, event: unknown, maxBytes?: number): AssistantState {
	const snap = extractAssistantText(event);
	if (!snap.assistant) return current;
	return {
		text: maxBytes === undefined ? snap.text : truncateOutput(snap.text, maxBytes),
		// Pi sends provider and model ID separately; IDs may themselves contain slashes.
		model: snap.provider && snap.model ? `${snap.provider}/${snap.model}` : current.model,
		stopReason: snap.stopReason,
		errorMessage: maxBytes === undefined || snap.errorMessage === undefined ? snap.errorMessage : truncateOutput(snap.errorMessage, maxBytes),
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

function resolveStopReason(input: {
	stopKind?: "aborted" | "hard_timeout";
	failure?: { reason: "error" | "protocol-error"; text: string };
	state: AssistantState;
}): string | undefined {
	if (input.stopKind) return input.stopKind;
	if (input.failure) return input.failure.reason;
	if (input.state.stopReason === "error" || input.state.stopReason === "length") return input.state.stopReason;
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
	if ("execution" in input && input.execution !== undefined) throw new Error("Execution/headroom guard APIs are retired; refusing to launch without the requested policy.");
	// The caller owns the private, per-run archive snapshot. Fail before spawning if unreadable.
	readFileSync(input.promptSourcePath);
	if (!Number.isSafeInteger(input.hardTimeoutMs) || input.hardTimeoutMs < 0 || input.hardTimeoutMs > MAX_TIMER_MS) {
		throw new Error("Invalid hardTimeoutMs: must be a supported timer duration.");
	}
	const lease = input.resourceLease !== undefined ? { ...input.resourceLease } : undefined;
	if (input.leaseStartupMs !== undefined && (!lease || !Number.isSafeInteger(input.leaseStartupMs)
		|| input.leaseStartupMs < 1 || input.leaseStartupMs > MAX_TIMER_MS)) throw new Error("Invalid lease-only startup policy.");
	if (lease) {
		if (input.leaseStartupMs === undefined) throw new Error("Inherited resource leases require explicit lease-only startup.");
		verifyLease(lease.fd, lease);
	}
	const nonce = lease ? randomUUID() : undefined;
	const leaseConfig = lease ? { nonce: nonce!, lease: { dev: lease.dev, ino: lease.ino } } : undefined;
	const leaseStartup = leaseConfig ? new LeaseStartup(leaseConfig, input.leaseStartupMs!) : undefined;
	const args = [...input.buildArgs(input.promptSourcePath)];
	const childEnv = { ...input.env } as NodeJS.ProcessEnv;
	if (leaseConfig) {
		args.push("--extension", fileURLToPath(new URL("./lease-guard.ts", import.meta.url)));
		childEnv[LEASE_ENV] = JSON.stringify(leaseConfig);
	}
	const invocation = getPiInvocation(args);
	const started = Date.now();
	const spawnFn = input.spawnFn ?? spawn;
	const terminate = input.killTree ?? killChildTree;

	let stderr = "";
	let state: AssistantState = { text: "", model: input.model, sawAssistant: false };
	const answers = new AnswerHistory(input.maxOutputBytes);
	// Correlate delivered steering by exact text without retaining arbitrary control messages.
	const pendingWraps = new Map<string, number>();
	const wrapKey = (text: string) => createHash("sha256").update(text).digest("hex");
	let initialUserSeen = false;
	let timedOut = false;
	let aborted = false;
	let stopKind: "aborted" | "hard_timeout" | undefined;
	let failure: { reason: "error" | "protocol-error"; text: string } | undefined;
	let taskDispatched = false;
	let startupWrap: string | undefined;
	let openResponse = false;
	let settled = false;
	let pid: number | undefined;
	let eventCount = 0;
	const events: string[] = [];

	const exitCode = await new Promise<number>((resolve, reject) => {
		const proc = spawnFn(invocation.command, invocation.args, {
			cwd: input.cwd,
			env: childEnv,
			shell: false,
			stdio: ["pipe", "pipe", "pipe", ...(lease ? [lease.fd] : [])],
			detached: process.platform !== "win32",
		});
		pid = proc.pid;
		let closed = false;
		const startup = new AbortController();
		let hardTimer: ReturnType<typeof setTimeout> | undefined;
		proc.stdin?.on("error", () => {
			/* EPIPE after exit must not crash the parent */
		});

		const finish = (code: number): void => {
			if (closed) return;
			closed = true;
			if (leaseStartup && !taskDispatched && !failure && !stopKind) {
				failure = { reason: "error", text: "Child exited before the leased task was dispatched." };
			}
			startup.abort();
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

		const fail = (reason: "error" | "protocol-error", text: string): void => {
			if (closed || stopKind || failure) return;
			failure = { reason, text };
			startup.abort();
			closeStdin();
			terminate(proc);
		};
		const steer = (text: string): boolean => {
			if (settled || closed || stopKind || failure) return false;
			const key = wrapKey(text), count = pendingWraps.get(key) ?? 0;
			if (!count && pendingWraps.size >= 64) return false;
			pendingWraps.set(key, count + 1);
			if (send({ type: "steer", message: text })) return true;
			if (count) pendingWraps.set(key, count); else pendingWraps.delete(key);
			return false;
		};

		const consume = (line: string): void => {
			if (closed || stopKind || failure || !line.trim()) return;
			try {
				const parsed = JSON.parse(line);
				const type = jsonlEventType(parsed);
				if (type) {
					eventCount += 1;
					rememberEventType(events, type);
				}
				if (type === "response" && parsed.id === "p1" && parsed.command === "prompt" && parsed.success === false) {
					fail("error", typeof parsed.error === "string" && parsed.error.trim() ? parsed.error : "Child rejected the RPC prompt.");
					return;
				}
				leaseStartup?.accept(parsed);
				if (failure || stopKind || closed) return;
				const cancel = failure ? undefined : uiCancelResponse(parsed);
				if (cancel) writeStdin(proc.stdin, cancel);
				if (type === "message_end" && parsed.message?.role === "user") {
					const content = parsed.message.content;
					const text = typeof content === "string" ? content : Array.isArray(content)
						? content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("") : "";
					if (!initialUserSeen && text === `Task: ${input.task}`) initialUserSeen = true;
					else {
						const key = wrapKey(text), pending = pendingWraps.get(key);
						if (pending) {
							if (pending === 1) pendingWraps.delete(key); else pendingWraps.set(key, pending - 1);
							answers.beginWrap();
						}
					}
				}
				if (parsed.message?.role === "assistant") {
					if (type === "message_start") openResponse = true;
					else if (type === "message_end") openResponse = false;
				}
				const next = applyAssistantSnapshot(state, parsed, input.maxOutputBytes);
				if (next !== state) { state = next; answers.observe(state); }
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
			if (closed || failure || stopKind) return;
			aborted = true;
			if (!stopKind) stopKind = "aborted";
			startup.abort();
			send({ type: "abort" });
			terminate(proc);
		};

		try {
			input.onControl?.({
				wrap: (message) => {
					if (settled || aborted || timedOut || closed || failure) return false;
					const text = message && message.trim() ? message : DEFAULT_WRAP_MESSAGE;
					if (leaseStartup && !taskDispatched) { startupWrap ??= text; return true; }
					return steer(text);
				},
			});
		} catch {
			/* control callback must not break the child */
		}

		if (input.hardTimeoutMs > 0) {
			hardTimer = setTimeout(() => {
				if (closed || failure || stopKind) return;
				timedOut = true;
				if (!stopKind) stopKind = "hard_timeout";
				startup.abort();
				terminate(proc);
			}, input.hardTimeoutMs);
		}

		if (input.signal) {
			if (input.signal.aborted) onAbort();
			else input.signal.addEventListener("abort", onAbort, { once: true });
		}

		proc.stdout?.setEncoding("utf8");
		proc.stderr?.setEncoding("utf8");
		const reader = new JsonlReader({
			maxBytes: RPC_RECORD_LIMIT_BYTES,
			onLine: consume,
			onOversized: (prefix) => {
				if (canDiscardOversizedEvent(prefix)) {
					consume('{"type":"oversized_event_skipped"}');
				} else {
					fail("protocol-error", `Child RPC record exceeds the ${RPC_RECORD_LIMIT_BYTES}-byte transport limit.`);
				}
			},
		});
		proc.stdout?.on("data", (chunk: string) => {
			if (!closed && !stopKind && !failure) reader.write(chunk);
		});
		proc.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
			if (Buffer.byteLength(stderr, "utf8") > STDERR_TAIL_BYTES * 4) {
				stderr = tailBytes(stderr, STDERR_TAIL_BYTES);
			}
		});
		proc.on("error", (error) => {
			closed = true;
			startup.abort();
			if (hardTimer) clearTimeout(hardTimer);
			input.signal?.removeEventListener("abort", onAbort);
			reject(error);
		});
		proc.on("close", (code) => {
			reader.end();
			finish(code ?? 1);
		});
		const startupFailure = (error: unknown) => {
			if (!closed && !stopKind && !failure) fail("error", `Child startup handshake failed: ${String(error)}`);
		};
		const startPrompt = () => {
			if (closed || taskDispatched || stopKind || failure) return;
			// Recheck after beforePrompt: a later acknowledgement may have invalidated readiness.
			try { leaseStartup?.assertReady(); }
			catch (error) { fail("error", String(error)); return; }
			taskDispatched = send({ id: "p1", type: "prompt", message: `Task: ${input.task}` });
			if (taskDispatched) {
				if (startupWrap) { steer(startupWrap); startupWrap = undefined; }
			}
			else if (leaseStartup) fail("error", "Could not send the leased child task.");
		};
		if (input.beforePrompt || leaseStartup) {
			Promise.resolve().then(async () => {
				if (leaseStartup) await leaseStartup.wait(startup.signal);
				if (input.beforePrompt) await input.beforePrompt(startup.signal);
			}).then(startPrompt, startupFailure);
		} else startPrompt();
	});

	const stopReason = !stopKind && !failure && answers.awaitingResponse ? "no-assistant-output"
		: resolveStopReason({ stopKind, failure, state });
	const explanation = answerExplanation({ ...state, stopReason });
	const assistantText = explanation
		? state.text ? `${explanation}\n\nPartial assistant output:\n${state.text}` : explanation
		: state.text || state.errorMessage || "";
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
		text: finalizeChildText(answers.format(failure?.text ?? assistantText, failure?.text ?? explanation), dump, input.maxOutputBytes),
		exitCode,
		stderrTail,
		model: state.model,
		stopReason,
		diag,
		evidence: answers.evidence(taskDispatched, openResponse, settled),
	};
}
