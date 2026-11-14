import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assertRepairAttempts, compileResponseSchema, DEFAULT_REPAIR_ATTEMPTS } from "../child-runtime/response-schema.ts";
import { isFailedChildResult } from "../child-runtime/policy.ts";
import { Accounting } from "./accounting.ts";
import type { ArchivedRun, RunIdentity } from "./archive.ts";
import { describeCapabilities } from "./capabilities.ts";
import type { AgentConfig, DelegateConfig } from "./config.ts";
import { JobScheduler, type JobSnapshot } from "./jobs.ts";
import { runChild } from "./spawn.ts";
import { isLocalModel } from "./tg.ts";
import { parseCompletionHook } from "./config.ts";
import { runCompletionHook, type CompletionHookResult } from "./completion-hook.ts";

/** Empty templates preserve the exact existing system prompt. */
export function agentPrompt(agent: Pick<AgentConfig, "prompt" | "responseTemplate" | "responseSchema">): string {
	if (agent.responseSchema != null) return `${agent.prompt}\n\n## Response format\nReturn exactly one JSON value matching this draft-07 JSON Schema. No Markdown fences or surrounding prose. This schema takes precedence over other response-format instructions. Do not invent facts to fill fields.\n\n${JSON.stringify(agent.responseSchema, null, 2)}`;
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
	const agent = structuredClone(input.agent);
	const config = { ...input.config };
	const validateResponse = agent.responseSchema == null ? undefined : compileResponseSchema(agent.responseSchema);
	const hook = agent.completionHook == null ? null : parseCompletionHook(agent.completionHook);
	const repairAttempts = agent.responseRepairAttempts ?? DEFAULT_REPAIR_ATTEMPTS;
	assertRepairAttempts(repairAttempts);
	const tools = agent.tools;
	const capabilities = describeCapabilities(tools);
	const local = isLocalModel(input.identity.requestedModel);
	const archive = input.accounting.create({ ...input.identity, tools, capabilities }, input.task, agentPrompt(agent));
	let responseText: string | undefined;
	try {
		if (hook) writeFileSync(join(archive.paths.dir, "completion-hook-config.json"), JSON.stringify(hook), { mode: 0o600, flag: "wx" });
		let responseFormatPath: string | undefined;
		if (agent.responseSchema != null) {
			responseFormatPath = join(dirname(archive.paths.prompt), "response-format.json");
			writeFileSync(responseFormatPath, JSON.stringify({ schema: agent.responseSchema, repairAttempts, maxOutputBytes: config.maxOutputBytes }), { mode: 0o600, flag: "wx" });
		}
		input.onAccepted?.(archive);
		return input.scheduler.enqueue({
			archive: { runId: archive.data.runId, sessionFile: archive.paths.session }, capabilities,
			kind: input.identity.kind, model: input.identity.requestedModel, reasoning: agent.thinking,
			local, task: input.task, timeoutMs: input.timeoutMs,
			...(local ? { resourceGroup: { key: "local-delegate", capacity: 1 } } : {}),
			background: input.background, cancelOnAbort: input.background ? undefined : input.signal,
			...(hook ? { onComplete: async (snap: JobSnapshot): Promise<CompletionHookResult> => {
				// Covers jobs cancelled before dispatch, even outside the extension's scheduler wiring.
				input.accounting.terminal(archive.data.runId, snap.id, {
					status: snap.failed ? "failed" : "done", stopReason: snap.stopReason, exitCode: snap.exitCode,
					finalization: snap.finalization, evidence: snap.outcome?.evidence,
				});
				archive.recordCompletionHook({ status: "running", durationMs: 0 });
				let result: CompletionHookResult;
				try {
					const text = responseText ?? snap.answer ?? "";
					let json: unknown;
					let schemaValidated = false;
					if (!snap.failed && validateResponse) {
						json = JSON.parse(text);
						schemaValidated = Boolean(validateResponse(json));
						if (!schemaValidated) throw new Error("Completion hook response failed schema validation.");
					}
					const payload = {
						version: 1, event: "delegate.completed", runId: archive.data.runId, jobId: snap.id,
						role: snap.kind, status: snap.status, outcome: snap.outcome,
						stopReason: snap.stopReason ?? null, exitCode: snap.exitCode ?? null,
						model: snap.model, requestedModel: archive.data.requestedModel, reasoning: agent.thinking,
						cwd: input.identity.cwd, durationMs: archive.data.durationMs,
						parentSessionId: archive.data.parentSessionId, toolCallId: archive.data.toolCallId,
						paths: { ...archive.paths, response: snap.responseFile ?? null },
						recordingError: snap.recordingError ?? archive.data.recordingError ?? null,
						response: { text, schemaValidated, ...(schemaValidated ? { json } : {}) },
					};
					writeFileSync(join(archive.paths.dir, "completion-hook-input.json"), JSON.stringify(payload), { mode: 0o600, flag: "wx" });
					result = await runCompletionHook(hook, payload, input.identity.cwd);
				} catch (error) {
					result = { status: "failed", durationMs: 0, error: error instanceof Error ? error.message : String(error) };
				}
				archive.recordCompletionHook(result);
				return result;
			} } : {}),
			run: async (handle, childSignal, onEvent, onControl) => {
				const result = await input.accounting.run(archive, handle.id, onUsage => {
					childSignal.throwIfAborted();
					return (input.childRunner ?? runChild)({
						task: input.task, cwd: input.identity.cwd, model: input.identity.requestedModel,
						thinking: agent.thinking, tools: [...tools], extensions: agent.extensions,
						...(local ? { resourceLease: handle.resourceLease, leaseStartupMs: 15000 } : {}),
						hardTimeoutMs: config.hardTimeoutMs, maxOutputBytes: config.maxOutputBytes,
						promptSourcePath: archive.paths.prompt, sessionFile: archive.paths.session, responseFormatPath,
						signal: childSignal, env: input.env ?? process.env,
						onEvent: event => { onUsage(event); onEvent(event); }, onControl,
					});
				}, childSignal);
				responseText = result.text;
				// Saving is harness-owned; never ask the child to write or reveal a path.
				// Keep empty-output failure semantics and all execution/evidence fields intact.
				if (!agent.saveToFile || !result.text) return result;
				let directory: string | undefined;
				try {
					directory = mkdtempSync(join(tmpdir(), "pi-delegate-result-"));
					const responseFile = join(directory, agent.responseSchema != null && !isFailedChildResult(result) ? "response.json" : "response.md");
					writeFileSync(responseFile, result.text, { encoding: "utf8", mode: 0o600, flag: "wx" });
					return { ...result, text: `Response saved to: ${responseFile}`, responseFile };
				} catch (error) {
					if (directory) { try { rmSync(directory, { recursive: true, force: true }); } catch { /* Best-effort cleanup of this private directory. */ } }
					const warning = `Could not save response to temporary file: ${error instanceof Error ? error.message : String(error)}`;
					return { ...result, text: agent.responseSchema != null && !isFailedChildResult(result) ? result.text : `${warning}\n\n${result.text}`,
						recordingError: [result.recordingError, warning].filter(Boolean).join("\n") };
				}
			},
		});
	} catch (error) {
		input.accounting.terminal(archive.data.runId, "refused", { status: "failed", stopReason: "error", exitCode: 1 });
		throw error;
	}
}
