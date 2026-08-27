import { runPiChild, type ChildResult } from "../child-runtime/spawn.ts";

export type { ChildResult };

export interface ChildArgsInput {
	model: string;
	thinking: string;
	tools: string[];
	promptPath: string;
	task: string;
	offline?: boolean;
}

export interface RunChildInput {
	task: string;
	cwd: string;
	model: string;
	thinking: string;
	tools: string[];
	offline?: boolean;
	timeoutMs: number;
	maxOutputBytes: number;
	promptSourcePath: string;
	signal?: AbortSignal;
	env?: NodeJS.Dict<string>;
	onEvent?: (event: unknown) => void;
}

let activeChildren = 0;

export function buildChildArgs(input: ChildArgsInput): string[] {
	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
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
		`Task: ${input.task}`,
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

export async function runChild(input: RunChildInput): Promise<ChildResult> {
	return runPiChild({
		cwd: input.cwd,
		model: input.model,
		timeoutMs: input.timeoutMs,
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
				task: input.task,
				offline: input.offline,
			}),
		signal: input.signal,
		onEvent: input.onEvent,
	});
}

export function acquireSlot(maxConcurrent: number): void {
	if (activeChildren >= maxConcurrent) {
		throw new Error(`delegate refused: ${activeChildren} already running (max ${maxConcurrent}).`);
	}
	activeChildren += 1;
}

export function releaseSlot(): void {
	if (activeChildren > 0) activeChildren -= 1;
}

export async function withSlot<T>(maxConcurrent: number, fn: () => Promise<T>): Promise<T> {
	acquireSlot(maxConcurrent);
	try {
		return await fn();
	} finally {
		releaseSlot();
	}
}
