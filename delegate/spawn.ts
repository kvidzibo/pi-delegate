import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runPiChild, type ChildControl, type ChildResult } from "../child-runtime/spawn.ts";

export interface ChildArgsInput {
	model: string;
	thinking: string;
	tools: string[];
	promptPath: string;
	sessionFile: string;
	offline?: boolean;
}

export interface RunChildInput {
	task: string;
	cwd: string;
	model: string;
	thinking: string;
	tools: string[];
	offline?: boolean;
	hardTimeoutMs: number;
	maxOutputBytes: number;
	promptSourcePath: string;
	sessionFile: string;
	signal?: AbortSignal;
	env?: NodeJS.Dict<string>;
	onEvent?: (event: unknown) => void;
	onControl?: (ctl: ChildControl) => void;
}

export function buildChildArgs(input: ChildArgsInput): string[] {
	const args = [
		"--mode",
		"rpc",
		"--session",
		input.sessionFile,
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
	];
	if (input.offline) args.push("--offline");
	args.push(
		"--model",
		input.model,
		"--thinking",
		input.thinking,
		"--tools",
		input.tools.join(","),
		"--system-prompt",
		input.promptPath,
	);
	return args;
}

export function buildChildEnv(env: NodeJS.Dict<string> | undefined): NodeJS.ProcessEnv {
	return {
		...env,
		PI_DELEGATE_CHILD: "1",
		PI_DELEGATE_CHILD_DEPTH: "1",
	};
}

export function delegateLogPath(env: NodeJS.Dict<string> = process.env): string | undefined {
	if (env.PI_DELEGATE_LOG === "0") return undefined;
	if (typeof env.PI_DELEGATE_LOG === "string" && env.PI_DELEGATE_LOG.length > 0) {
		return env.PI_DELEGATE_LOG;
	}
	return join(homedir(), ".pi", "agent", "delegate.log");
}

export function appendDelegateLog(path: string, record: Record<string, unknown>): void {
	appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

function logChildResult(input: RunChildInput, result: ChildResult): void {
	const path = delegateLogPath(input.env ?? process.env);
	if (!path) return;
	try {
		appendDelegateLog(path, {
			ts: new Date().toISOString(),
			model: result.model ?? input.model,
			stopReason: result.stopReason,
			exitCode: result.exitCode,
			hardTimeoutMs: input.hardTimeoutMs,
			durationMs: result.diag?.durationMs,
			pid: result.diag?.pid,
			command: result.diag?.command,
			args: result.diag?.args,
			eventCount: result.diag?.eventCount,
			events: result.diag?.events,
			sawAssistant: result.diag?.sawAssistant,
			stderrTail: result.stderrTail,
		});
	} catch {
		/* logging must not hide the child result */
	}
}

export async function runChild(input: RunChildInput): Promise<ChildResult> {
	const result = await runPiChild({
		cwd: input.cwd,
		model: input.model,
		task: input.task,
		hardTimeoutMs: input.hardTimeoutMs,
		maxOutputBytes: input.maxOutputBytes,
		promptSourcePath: input.promptSourcePath,
		tmpPrefix: "pi-delegate-",
		env: buildChildEnv(input.env),
		buildArgs: (promptPath) =>
			buildChildArgs({
				model: input.model,
				thinking: input.thinking,
				tools: input.tools,
				promptPath,
				sessionFile: input.sessionFile,
				offline: input.offline,
			}),
		signal: input.signal,
		onEvent: input.onEvent,
		onControl: input.onControl,
	});
	logChildResult(input, result);
	return result;
}
