import { sameLease, validateLeaseIdentity, type LeaseIdentity } from "./lease.ts";

export const LEASE_ENV = "PI_DELEGATE_LEASE_STARTUP";
export const LEASE_NOTICE = "delegate-lease-ready";
export type LeaseStartupConfig = { nonce: string; lease: LeaseIdentity };

export function validateLeaseStartup(value: unknown): LeaseStartupConfig {
	const raw = value as Partial<LeaseStartupConfig> | undefined;
	if (!raw || typeof raw.nonce !== "string" || !/^[a-zA-Z0-9-]{16,64}$/.test(raw.nonce)) throw new Error("Invalid lease startup nonce.");
	return { nonce: raw.nonce, lease: validateLeaseIdentity(raw.lease) };
}

/** Startup acknowledgement only: no tool replacement, finalization or runtime deadline. */
export class LeaseStartup {
	private ready = false;
	private error?: Error;
	private changed?: () => void;
	private config: LeaseStartupConfig;
	private timeoutMs: number;
	constructor(config: LeaseStartupConfig, timeoutMs: number) { this.config = config; this.timeoutMs = timeoutMs; }

	accept(event: unknown): void {
		const raw = event as { type?: string; method?: string; message?: string } | undefined;
		if (raw?.type !== "extension_ui_request" || raw.method !== "notify" || typeof raw.message !== "string") return;
		let notice: any;
		try { notice = JSON.parse(raw.message); } catch { return; }
		if (notice?.type !== LEASE_NOTICE || notice.nonce !== this.config.nonce) return;
		try {
			if (notice.version !== 1 || !sameLease(validateLeaseIdentity(notice.lease), this.config.lease)) throw new Error("Child did not acknowledge the expected resource lease.");
			this.ready = true;
		} catch (error) { this.error = error instanceof Error ? error : new Error(String(error)); }
		this.changed?.();
	}

	assertReady(): void {
		if (this.error) throw this.error;
		if (!this.ready) throw new Error("Child resource lease has not been acknowledged.");
	}

	wait(signal: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", check); this.changed = undefined; };
			const check = () => {
				if (signal.aborted || this.error) { cleanup(); reject(this.error ?? new Error("Lease startup stopped.")); }
				else if (this.ready) { cleanup(); resolve(); }
			};
			const timer = setTimeout(() => { this.error = new Error("Child resource lease startup timed out; no task sent."); check(); }, this.timeoutMs);
			this.changed = check;
			signal.addEventListener("abort", check, { once: true });
			check();
		});
	}
}
