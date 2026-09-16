export const HEADROOM_EXIT_CODE = 79;
export const HEADROOM_STDERR_PREFIX = "delegate-context-refusal: ";
export type HeadroomProgress = {
	policyId: string;
	phase: "starting" | "ready" | "checked" | "limited" | "compaction-blocked" | "refused" | "refusal-exit";
	/** Sticky: a prior request may have reached the limit even if the latest one fits. */
	limited: boolean;
	inputBytes?: number;
	inputLimitBytes?: number;
	reservedTokens?: number;
	clippedToolResults?: number;
	detail?: string;
};

/** Caller bounds stderr lines. Ignore ordinary diagnostics and receipts from another child. */
export function parseHeadroomRefusal(line: string, nonce: string): HeadroomProgress | undefined {
	if (!line.startsWith(HEADROOM_STDERR_PREFIX)) return;
	try {
		const raw = JSON.parse(line.slice(HEADROOM_STDERR_PREFIX.length));
		if (raw?.nonce !== nonce) return;
		const progress = copyHeadroomProgress(raw.headroom);
		return progress?.phase === "refused" && progress.limited ? progress : undefined;
	} catch { return; }
}

export function copyHeadroomProgress(value: unknown): HeadroomProgress | undefined {
	const raw = value as Partial<HeadroomProgress> | undefined;
	if (!raw || typeof raw.policyId !== "string" || !/^[a-f0-9]{64}$/.test(raw.policyId)
		|| !["starting", "ready", "checked", "limited", "compaction-blocked", "refused", "refusal-exit"].includes(raw.phase as string)
		|| typeof raw.limited !== "boolean" || (raw.detail !== undefined && (typeof raw.detail !== "string" || raw.detail.length > 300))) return;
	const result: HeadroomProgress = { policyId: raw.policyId, phase: raw.phase!, limited: raw.limited };
	for (const key of ["inputBytes", "inputLimitBytes", "reservedTokens", "clippedToolResults"] as const) {
		const number = raw[key];
		if (number !== undefined) {
			if (!Number.isSafeInteger(number) || number < 0 || number > 64 * 1024 * 1024) return;
			result[key] = number;
		}
	}
	if (raw.detail !== undefined) result.detail = raw.detail;
	return result;
}
