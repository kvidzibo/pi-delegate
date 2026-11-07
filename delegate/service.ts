import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Accounting } from "./accounting.ts";
import type { ArchivedRun, RunIdentity } from "./archive.ts";
import { describeCapabilities } from "./capabilities.ts";
import type { AgentConfig, DelegateConfig } from "./config.ts";
import { JobScheduler, type JobSnapshot } from "./jobs.ts";
import { runChild } from "./spawn.ts";
import { isLocalModel } from "./tg.ts";

/** Empty templates preserve the exact existing system prompt. */
export function agentPrompt(agent: Pick<AgentConfig, "prompt" | "responseTemplate">): string {
	return agent.responseTemplate?.trim()
		? `${agent.prompt}\n\n## Response format\nFollow this template for your final response. Treat placeholders as guidance, not facts; do not invent findings, resolutions or commit hashes.\n\n${agent.responseTemplate}`
		: agent.prompt;
}

/** Acceptance/execution path. Snapshot role policy before queue admission. */
export function enqueueDelegate(input: {
	scheduler: JobScheduler;
	accounting: Accounting;
	identity: Omit<RunIdentity, "tools" | "capabilities">;
	agent: AgentConfig;
	task: string;
	timeoutMs: number;
	background: boolean;
	config: Pick<DelegateConfig, "hardTimeoutMs" | "maxOutputBytes">;
	signal?: AbortSignal;
	env?: NodeJS.Dict<string>;
	childRunner?: typeof runChild;
	onAccepted?: (archive: ArchivedRun) => void;
}): JobSnapshot {
	if (input.agent.enabled === false) throw new Error(`delegate refused: ${input.identity.kind} is disabled in configuration.`);
	const agent = { ...input.agent, tools: [...input.agent.tools] };
	const tools = agent.tools;
	const capabilities = describeCapabilities(tools);
	const local = isLocalModel(input.identity.requestedModel);
	const archive = input.accounting.create({ ...input.identity, tools, capabilities }, input.task, agentPrompt(agent));
	try {
		input.onAccepted?.(archive);
		return input.scheduler.enqueue({
			archive: { runId: archive.data.runId, sessionFile: archive.paths.session }, capabilities,
			kind: input.identity.kind, model: input.identity.requestedModel, reasoning: agent.thinking,
			local, task: input.task, timeoutMs: input.timeoutMs,
			...(local ? { resourceGroup: { key: "local-delegate", capacity: 1 } } : {}),
			background: input.background, cancelOnAbort: input.background ? undefined : input.signal,
			run: async (handle, childSignal, onEvent, onControl) => {
				const result = await input.accounting.run(archive, handle.id, onUsage => {
					childSignal.throwIfAborted();
					return (input.childRunner ?? runChild)({
						task: input.task, cwd: input.identity.cwd, model: input.identity.requestedModel,
						thinking: agent.thinking, tools: [...tools], extensions: agent.extensions,
						...(local ? { resourceLease: handle.resourceLease, leaseStartupMs: 15000 } : {}),
						hardTimeoutMs: input.config.hardTimeoutMs, maxOutputBytes: input.config.maxOutputBytes,
						promptSourcePath: archive.paths.prompt, sessionFile: archive.paths.session,
						signal: childSignal, env: input.env ?? process.env,
						onEvent: event => { onUsage(event); onEvent(event); }, onControl,
					});
				}, childSignal);
				// Saving is harness-owned; never ask the child to write or reveal a path.
				// Keep empty-output failure semantics and all execution/evidence fields intact.
				if (!agent.saveToFile || !result.text) return result;
				let directory: string | undefined;
				try {
					directory = mkdtempSync(join(tmpdir(), "pi-delegate-result-"));
					const responseFile = join(directory, "response.md");
					writeFileSync(responseFile, result.text, { encoding: "utf8", mode: 0o600, flag: "wx" });
					return { ...result, text: `Response saved to: ${responseFile}`, responseFile };
				} catch (error) {
					if (directory) { try { rmSync(directory, { recursive: true, force: true }); } catch { /* Best-effort cleanup of this private directory. */ } }
					const warning = `Could not save response to temporary file: ${error instanceof Error ? error.message : String(error)}`;
					return { ...result, text: `${warning}\n\n${result.text}`, recordingError: [result.recordingError, warning].filter(Boolean).join("\n") };
				}
			},
		});
	} catch (error) {
		input.accounting.terminal(archive.data.runId, "refused", { status: "failed", stopReason: "error", exitCode: 1 });
		throw error;
	}
}
