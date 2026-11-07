/** Correlated private RPC notice, with a bounded wait before dispatching any task. */
export class NoticeStartup {
	private ready = false;
	private error?: Error;
	private changed?: () => void;
	private readonly acceptNotice: (notice: any) => boolean;
	private readonly label: string;
	private readonly timeoutMs: number;
	constructor(acceptNotice: (notice: any) => boolean, label: string, timeoutMs: number) {
		this.acceptNotice = acceptNotice; this.label = label; this.timeoutMs = timeoutMs;
	}

	accept(event: unknown): void {
		const raw = event as { type?: string; method?: string; message?: string } | undefined;
		if (raw?.type !== "extension_ui_request" || raw.method !== "notify" || typeof raw.message !== "string") return;
		let notice: unknown;
		try { notice = JSON.parse(raw.message); } catch { return; }
		try { if (this.acceptNotice(notice)) this.ready = true; }
		catch (error) { this.error = error instanceof Error ? error : new Error(String(error)); }
		this.changed?.();
	}

	assertReady(): void {
		if (this.error) throw this.error;
		if (!this.ready) throw new Error(`${this.label} has not been acknowledged.`);
	}

	wait(signal: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", check); this.changed = undefined; };
			const check = () => {
				if (signal.aborted || this.error) { cleanup(); reject(this.error ?? new Error(`${this.label} startup stopped.`)); }
				else if (this.ready) { cleanup(); resolve(); }
			};
			const timer = setTimeout(() => { this.error = new Error(`${this.label} startup timed out; no task sent.`); check(); }, this.timeoutMs);
			this.changed = check;
			signal.addEventListener("abort", check, { once: true });
			check();
		});
	}
}
