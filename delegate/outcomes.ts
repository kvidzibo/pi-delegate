import { copyResponseEvidence, type ResponseEvidence } from "../child-runtime/evidence.ts";
import type { FinalizationProgress } from "../child-runtime/guard-protocol.ts";
import { truncateOutput } from "../child-runtime/policy.ts";

const EXECUTIONS = ["queued", "running", "finished", "failed", "cancelled", "limited"] as const;
const LIMITS = ["output-token-limit", "execution-budget", "context-budget", "hard-timeout", "finalization-timeout",
	"missing-final-output", "unsettled-response", "unanswered-wrap", "omitted-phases"] as const;
type Limit = typeof LIMITS[number];
const BUDGETS: Record<string, Limit> = { length: "output-token-limit", execution_budget: "execution-budget",
	context_budget: "context-budget", hard_timeout: "hard-timeout", finalization_timeout: "finalization-timeout" };

export interface ExecutionOutcome {
	version: 1;
	execution: typeof EXECUTIONS[number];
	taskAssessment: "not-performed";
	responses: "pending" | "unrecorded" | "none" | "observed" | "unsettled";
	limitations: Limit[];
	evidence?: ResponseEvidence;
}

function responseState(execution: ExecutionOutcome["execution"], evidence?: ResponseEvidence): ExecutionOutcome["responses"] {
	if (execution === "queued" || execution === "running") return "pending";
	if (!evidence) return "unrecorded";
	if (!evidence.finalizedMessages && !evidence.openResponse && !evidence.unansweredWrap) return "none";
	if (evidence.openResponse || evidence.unansweredWrap || !evidence.agentSettled) return "unsettled";
	return "observed";
}

function evidenceLimits(evidence?: ResponseEvidence): Limit[] {
	if (!evidence) return [];
	return [...(evidence.openResponse || (evidence.finalizedMessages > 0 && !evidence.agentSettled) ? ["unsettled-response" as const] : []),
		...(evidence.unansweredWrap ? ["unanswered-wrap" as const] : []), ...(evidence.omittedPhases ? ["omitted-phases" as const] : [])];
}

/** Runtime signals only. Deliberately accepts no report prose or inferred test/task verdict. */
export function describeOutcome(input: {
	status: "queued" | "running" | "done" | "failed";
	stopReason?: string;
	evidence?: unknown;
	finalization?: FinalizationProgress;
}): ExecutionOutcome {
	const evidence = copyResponseEvidence(input.evidence), limitations = new Set<Limit>();
	const budget = Object.hasOwn(BUDGETS, input.stopReason ?? "") ? BUDGETS[input.stopReason!] : undefined;
	const pending = input.status === "queued" || input.status === "running";
	const execution = pending ? input.status as "queued" | "running" : input.stopReason === "aborted" ? "cancelled"
		: budget ? "limited" : input.status === "done" ? "finished" : "failed";
	if (budget) limitations.add(budget);
	if (input.finalization?.reason === "execution_budget") limitations.add("execution-budget");
	if (input.finalization?.reason === "context_budget" || input.finalization?.headroom?.limited) limitations.add("context-budget");
	if (input.stopReason === "no-assistant-output") limitations.add("missing-final-output");
	if (input.stopReason === "incomplete-output") limitations.add("unsettled-response");
	for (const limit of evidenceLimits(evidence)) limitations.add(limit);
	return { version: 1, execution, taskAssessment: "not-performed", responses: responseState(execution, evidence),
		limitations: LIMITS.filter(limit => limitations.has(limit)), ...(evidence ? { evidence } : {}) };
}

export function copyOutcome(value: unknown): ExecutionOutcome | undefined {
	const raw = value as Partial<ExecutionOutcome> | undefined;
	if (!raw || raw.version !== 1 || raw.taskAssessment !== "not-performed" || !(EXECUTIONS as readonly unknown[]).includes(raw.execution)
		|| !Array.isArray(raw.limitations) || raw.limitations.length > LIMITS.length
		|| !raw.limitations.every(limit => (LIMITS as readonly unknown[]).includes(limit)) || new Set(raw.limitations).size !== raw.limitations.length) return;
	const evidence = copyResponseEvidence(raw.evidence);
	if ((raw.evidence !== undefined && !evidence) || raw.responses !== responseState(raw.execution!, evidence)
		|| evidenceLimits(evidence).some(limit => !raw.limitations!.includes(limit))
		|| (raw.execution === "limited" && !Object.values(BUDGETS).some(limit => raw.limitations!.includes(limit)))) return;
	return { version: 1, execution: raw.execution!, taskAssessment: "not-performed", responses: raw.responses,
		limitations: LIMITS.filter(limit => raw.limitations!.includes(limit)), ...(evidence ? { evidence } : {}) };
}

/** Worker completion is not a task-success verdict. Health/cleanup warnings remain separate fields. */
export function outcomeContent(value: unknown): Array<{ type: "text"; text: string }> {
	const outcome = copyOutcome(value);
	if (!outcome || outcome.execution === "queued" || outcome.execution === "running") return [];
	const evidence = outcome.evidence;
	const lines = [`Worker execution: ${outcome.execution}. Task correctness: not assessed by delegate.`,
		`Response lifecycle: ${outcome.responses}.`,
		...(evidence ? [`RPC observations: task sent ${evidence.taskSent}; agent settled ${evidence.agentSettled}; finalized messages ${evidence.finalizedMessages}; retained phase responses ${evidence.retainedResponses}; open response ${evidence.openResponse}.`,
			...(evidence.partialResponseRetained ? ["An incomplete streamed response was retained."] : [])] : ["No RPC evidence metadata recorded; report wording is not a verification signal."]),
		...(outcome.limitations.length ? [`Limitations: ${outcome.limitations.join(", ")}.`] : [])];
	return [{ type: "text", text: truncateOutput(lines.join("\n"), 512) }];
}
