import { copyHeadroomProgress, type HeadroomProgress } from "./headroom-protocol.ts";

/** Read-only compatibility schema for historical archive metadata. */
export type FinalizationReason = "wrap" | "execution_budget" | "context_budget";
export type FinalizationProgress = {
	phase: "starting" | "requested" | "running" | "draining" | "answering";
	reason?: FinalizationReason;
	activeTools?: number;
	headroom?: HeadroomProgress;
};

export function copyFinalizationProgress(value: unknown): FinalizationProgress | undefined {
	const raw = value as Partial<FinalizationProgress> | undefined;
	if (!raw || !["starting", "running", "requested", "draining", "answering"].includes(raw.phase as string)
		|| (raw.reason !== undefined && !["wrap", "execution_budget", "context_budget"].includes(raw.reason))
		|| (raw.activeTools !== undefined && (!Number.isSafeInteger(raw.activeTools) || raw.activeTools < 0))) return;
	const headroom = raw.headroom === undefined ? undefined : copyHeadroomProgress(raw.headroom);
	if (raw.headroom !== undefined && !headroom) return;
	return { phase: raw.phase!, ...(raw.reason ? { reason: raw.reason } : {}),
		...(raw.activeTools !== undefined ? { activeTools: raw.activeTools } : {}), ...(headroom ? { headroom } : {}) };
}
