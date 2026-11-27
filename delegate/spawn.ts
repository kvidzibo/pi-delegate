import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runPiChild, type ChildControl, type ChildResult } from "../child-runtime/spawn.ts";
import type { InheritedLease } from "../child-runtime/lease.ts";
import { SPEED_ENV, type Speed } from "../child-runtime/speed.ts";
import { providerExtension } from "./provider-extension.ts";

const SERVICE_TIER_EXTENSION = fileURLToPath(new URL("../child-runtime/service-tier.ts", import.meta.url));

export interface ChildArgsInput {
	model: string;
	thinking: string;
	tools: string[];
	extensions?: boolean;
	/** Loads the private service-tier extension; the child still checks model eligibility. */
	speed?: Speed;
	/** Extension that registers the model's provider; needed only when extensions are off. */
	providerExtension?: string;
	promptPath: string;
	sessionFile: string;
}

export interface RunChildInput {
	task: string;
	cwd: string;
	model: string;
	thinking: string;
	tools: string[];
	extensions?: boolean;
	speed?: Speed;
	hardTimeoutMs: number;
	maxOutputBytes: number;
	promptSourcePath: string;
	responseFormatPath?: string;
	sessionFile: string;
	signal?: AbortSignal;
	env?: NodeJS.Dict<string>;
	onEvent?: (event: unknown) => void;
	onControl?: (ctl: ChildControl) => void;
	resourceLease?: InheritedLease;
	leaseStartupMs?: number;
}

export function buildChildArgs(input: ChildArgsInput): string[] {
	const args = [
		"--mode",
		"rpc",
		"--session",
		input.sessionFile,
		...(input.extensions ? [] : ["--no-extensions"]),
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
	];
	args.push(
		"--model",
		input.model,
		"--thinking",
		input.thinking,
		...(input.tools.length ? ["--tools", input.tools.join(",")] : ["--no-tools", "--no-mcp"]),
		"--system-prompt",
		input.promptPath,
	);
	if (input.speed && input.speed !== "standard") args.push("--extension", SERVICE_TIER_EXTENSION);
	if (!input.extensions && input.providerExtension) args.push("--extension", input.providerExtension);
	return args;
}

export function buildChildEnv(env: NodeJS.Dict<string> | undefined, speed?: Speed): NodeJS.ProcessEnv {
	const next: NodeJS.ProcessEnv = {
		...env,
		PI_DELEGATE_CHILD: "1",
		PI_DELEGATE_CHILD_DEPTH: "1",
	};
	delete next[SPEED_ENV];
	if (speed && speed !== "standard") next[SPEED_ENV] = speed;
	return next;
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
	if ("execution" in input && input.execution !== undefined) throw new Error("Execution/headroom guard APIs are retired; refusing to launch without the requested policy.");
	// --no-extensions also drops the extension that registers the model's provider.
	const provider = input.extensions ? undefined : await providerExtension(input.model);
	const result = await runPiChild({
		cwd: input.cwd,
		model: input.model,
		task: input.task,
		hardTimeoutMs: input.hardTimeoutMs,
		maxOutputBytes: input.maxOutputBytes,
		promptSourcePath: input.promptSourcePath,
		responseFormatPath: input.responseFormatPath,
		env: buildChildEnv(input.env, input.speed),
		buildArgs: (promptPath) =>
			buildChildArgs({
				model: input.model,
				thinking: input.thinking,
				tools: input.tools,
				extensions: input.extensions,
				speed: input.speed,
				providerExtension: provider,
				promptPath,
				sessionFile: input.sessionFile,
			}),
		signal: input.signal,
		onEvent: input.onEvent,
		onControl: input.onControl,
		resourceLease: input.resourceLease,
		leaseStartupMs: input.leaseStartupMs,
	});
	logChildResult(input, result);
	return result;
}
