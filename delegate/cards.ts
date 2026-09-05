// UI-only state. Short job IDs are reused after reload; origin tool-call IDs are not.
export const CARD_STATE_TYPE = "delegate-job-state";
export type CardDetails = Record<string, unknown>;

export function isTerminal(details: CardDetails): boolean {
	return details.status === "done" || details.status === "failed";
}

export class JobCards {
	private readonly snapshots = new Map<string, CardDetails>();
	private readonly live = new Set<string>();
	private readonly owned = new Set<string>();
	private readonly observers = new Map<string, () => void>();

	get(origin: string): CardDetails | undefined { return this.snapshots.get(origin); }
	isLive(origin: string): boolean { return this.live.has(origin); }

	begin(origin: string, details: CardDetails): void {
		this.live.add(origin);
		this.owned.add(origin);
		this.update(origin, details);
	}

	watch(origin: string, invalidate: (() => void) | undefined): void {
		if (this.live.has(origin) && invalidate) this.observers.set(origin, invalidate);
	}

	update(origin: string, details: CardDetails): void {
		// A fast completion can precede the initial pending tool result.
		if (isTerminal(this.snapshots.get(origin) ?? {}) && !isTerminal(details)) return;
		this.snapshots.set(origin, { ...details, originToolCallId: origin });
		const invalidate = this.observers.get(origin);
		if (isTerminal(details)) {
			this.live.delete(origin);
			this.observers.delete(origin);
		}
		try { invalidate?.(); } catch { /* A dead row must not affect the child. */ }
	}

	forget(origin: string): void {
		this.snapshots.delete(origin);
		this.live.delete(origin);
		this.owned.delete(origin);
		this.observers.delete(origin);
	}

	restore(entries: readonly unknown[]): void {
		// Jobs owned by this runtime remain authoritative even if they finish on another branch.
		// Replace only restored history when navigating /tree.
		for (const origin of this.snapshots.keys()) if (!this.owned.has(origin)) this.snapshots.delete(origin);
		for (const entry of entries) {
			if (!entry || typeof entry !== "object") continue;
			const rec = entry as { type?: string; customType?: string; data?: CardDetails; message?: { role?: string; toolName?: string; details?: CardDetails } };
			const details = rec.type === "custom" && rec.customType === CARD_STATE_TYPE ? rec.data
				: rec.type === "message" && rec.message?.role === "toolResult" && rec.message.toolName === "delegate" ? rec.message.details : undefined;
			if (!details || typeof details.originToolCallId !== "string") continue;
			const origin = details.originToolCallId;
			if (!this.owned.has(origin)) this.update(origin, { ...details, historical: !isTerminal(details) });
		}
	}

	clear(): void {
		this.snapshots.clear();
		this.live.clear();
		this.owned.clear();
		this.observers.clear();
	}
}
