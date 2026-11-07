import { sameLease, validateLeaseIdentity, type LeaseIdentity } from "./lease.ts";
import { NoticeStartup } from "./startup.ts";

export const LEASE_ENV = "PI_DELEGATE_LEASE_STARTUP";
export const LEASE_NOTICE = "delegate-lease-ready";
export type LeaseStartupConfig = { nonce: string; lease: LeaseIdentity };

export function validateLeaseStartup(value: unknown): LeaseStartupConfig {
	const raw = value as Partial<LeaseStartupConfig> | undefined;
	if (!raw || typeof raw.nonce !== "string" || !/^[a-zA-Z0-9-]{16,64}$/.test(raw.nonce)) throw new Error("Invalid lease startup nonce.");
	return { nonce: raw.nonce, lease: validateLeaseIdentity(raw.lease) };
}

/** Startup acknowledgement only: no tool replacement, finalization or runtime deadline. */
export class LeaseStartup extends NoticeStartup {
	constructor(config: LeaseStartupConfig, timeoutMs: number) {
		super(notice => {
			if (notice?.type !== LEASE_NOTICE || notice.nonce !== config.nonce) return false;
			if (notice.version !== 1 || !sameLease(validateLeaseIdentity(notice.lease), config.lease)) throw new Error("Child did not acknowledge the expected resource lease.");
			return true;
		}, "Child resource lease", timeoutMs);
	}
}
