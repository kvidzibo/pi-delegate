/** Observed RPC lifecycle, not a task assessment or proof of useful/correct report text. */
export interface ResponseEvidence {
	source: "rpc";
	taskSent: boolean;
	agentSettled: boolean;
	finalizedMessages: number;
	retainedResponses: number;
	omittedPhases: number;
	unansweredWrap: boolean;
	openResponse: boolean;
	partialResponseRetained: boolean;
}

export const MAX_RETAINED_RESPONSES = 8;

export function copyResponseEvidence(value: unknown): ResponseEvidence | undefined {
	const raw = value as Partial<ResponseEvidence> | undefined;
	if (!raw || raw.source !== "rpc"
		|| ![raw.taskSent, raw.agentSettled, raw.unansweredWrap, raw.openResponse, raw.partialResponseRetained].every(value => typeof value === "boolean")
		|| ![raw.finalizedMessages, raw.retainedResponses, raw.omittedPhases].every(value => Number.isSafeInteger(value) && (value as number) >= 0)
		|| raw.retainedResponses! > MAX_RETAINED_RESPONSES || raw.retainedResponses! > raw.finalizedMessages!
		|| (raw.partialResponseRetained && !raw.openResponse)) return;
	return { source: "rpc", taskSent: raw.taskSent!, agentSettled: raw.agentSettled!, finalizedMessages: raw.finalizedMessages!,
		retainedResponses: raw.retainedResponses!, omittedPhases: raw.omittedPhases!, unansweredWrap: raw.unansweredWrap!,
		openResponse: raw.openResponse!, partialResponseRetained: raw.partialResponseRetained! };
}
