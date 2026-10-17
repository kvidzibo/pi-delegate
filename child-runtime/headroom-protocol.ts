/** Read-only compatibility schema for historical archive metadata. */
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
