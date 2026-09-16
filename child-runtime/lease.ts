import { fstatSync } from "node:fs";

export const CHILD_LEASE_FD = 3;
export type LeaseIdentity = { dev: string; ino: string };
/** Borrowed parent descriptor. The scheduler owns and closes it, not the runner. */
export type InheritedLease = LeaseIdentity & { fd: number };

export function validateLeaseIdentity(value: unknown): LeaseIdentity {
	const raw = value as Partial<LeaseIdentity> | undefined;
	if (!raw || ![raw.dev, raw.ino].every(value => typeof value === "string" && /^\d{1,32}$/.test(value))) {
		throw new Error("Invalid resource lease identity.");
	}
	return { dev: raw.dev!, ino: raw.ino! };
}

export function sameLease(left: LeaseIdentity | undefined, right: LeaseIdentity | undefined): boolean {
	return left === undefined ? right === undefined : right !== undefined && left.dev === right.dev && left.ino === right.ino;
}

export function readLeaseIdentity(fd: number): LeaseIdentity {
	if (process.platform !== "linux") throw new Error("Inherited resource leases require Linux.");
	if (!Number.isSafeInteger(fd) || fd < 3) throw new Error("Resource lease requires a non-stdio file descriptor.");
	const stat = fstatSync(fd, { bigint: true });
	if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o077n) !== 0n) {
		throw new Error("Resource lease must be an owned private regular file with one stable link.");
	}
	return { dev: String(stat.dev), ino: String(stat.ino) };
}

export function verifyLease(fd: number, identity: LeaseIdentity): void {
	if (!sameLease(readLeaseIdentity(fd), validateLeaseIdentity(identity))) throw new Error("Resource lease descriptor identity changed.");
}
