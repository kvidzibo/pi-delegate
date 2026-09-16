export type FinalizationState = {
	phase: "running" | "draining" | "answering";
	activeTools: number;
};

/** Check at the tool body, not just parallel-batch preflight or model tool selection. */
export class FinalizationGate {
	private requested = false;
	private activeTools = 0;
	private readonly onChange?: (state: FinalizationState) => void;

	constructor(onChange?: (state: FinalizationState) => void) { this.onChange = onChange; }

	snapshot(): FinalizationState {
		return { phase: !this.requested ? "running" : this.activeTools ? "draining" : "answering", activeTools: this.activeTools };
	}

	request(): FinalizationState {
		if (!this.requested) { this.requested = true; this.notify(); }
		return this.snapshot();
	}

	async execute<T>(run: () => Promise<T>): Promise<T> {
		if (this.requested) throw new Error("Delegate finalization blocks fresh tool execution.");
		this.activeTools++;
		try {
			// Enter the body before notifying observers; a reentrant request cannot acknowledge first.
			const pending = run();
			this.notify();
			return await pending;
		} finally { this.activeTools--; this.notify(); }
	}

	private notify(): void {
		try { this.onChange?.(this.snapshot()); }
		catch { /* Observers cannot change execution authority or tool outcomes. */ }
	}
}
