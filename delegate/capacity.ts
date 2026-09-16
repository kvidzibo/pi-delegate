import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { readLeaseIdentity, type InheritedLease } from "../child-runtime/lease.ts";

export type ResourceGroup = { key: string; capacity: number };
export type ResourceClaim = ResourceGroup & { slot: number };
export interface ResourceLease {
	readonly claim: ResourceClaim;
	readonly inherited: InheritedLease;
	release(): void;
}
export interface CapacityBroker {
	/** Undefined means busy. Errors fail closed; never fall back to an uncoordinated launch. */
	tryAcquire(group: ResourceGroup): ResourceLease | undefined;
}

const MAX_CAPACITY = 64;
const CONFLICT_EXIT = 100;
const NOFOLLOW = constants.O_NOFOLLOW;

export function validateResourceGroup(value: ResourceGroup): ResourceGroup {
	if (!value || typeof value.key !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value.key)
		|| !Number.isSafeInteger(value.capacity) || value.capacity < 1 || value.capacity > MAX_CAPACITY) {
		throw new Error(`Resource group requires an explicit key and capacity from 1 to ${MAX_CAPACITY}.`);
	}
	return { key: value.key, capacity: value.capacity };
}

function privateDirectory(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) {
		throw new Error(`Resource directory must be owned by you, private (0700), and not a symlink: ${path}`);
	}
}

function close(fd: number): void {
	try { closeSync(fd); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error; }
}

function closeAll(fds: readonly number[]): void {
	let failure: unknown;
	for (const fd of fds) { try { close(fd); } catch (error) { failure ??= error; } }
	if (failure) throw failure;
}

function openLock(path: string): number {
	const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | NOFOLLOW | constants.O_NONBLOCK, 0o600);
	try { readLeaseIdentity(fd); return fd; } catch (error) { close(fd); throw error; }
}

/**
 * Linux flock leases are open-file-description locks, not PID/mtime records.
 * The utility acquires a lock on an inherited duplicate; our descriptor retains it after utility exit.
 * Passing that descriptor to the Pi child keeps occupancy after parent death, with kernel crash cleanup.
 */
export class FileCapacityBroker implements CapacityBroker {
	readonly root: string;
	private readonly flockPath: string;

	constructor(root: string, options: { flockPath?: string } = {}) {
		if (process.platform !== "linux") throw new Error("Cross-session resource capacity requires Linux flock.");
		if (!isAbsolute(root)) throw new Error("Resource coordination directory must be absolute.");
		this.root = root;
		this.flockPath = options.flockPath ?? "/usr/bin/flock";
		if (!isAbsolute(this.flockPath)) throw new Error("flock executable must be an absolute trusted path.");
	}

	private lock(fd: number): boolean {
		const result = spawnSync(this.flockPath, ["--exclusive", "--nonblock", "--conflict-exit-code", String(CONFLICT_EXIT), "3"], {
			stdio: ["ignore", "ignore", "pipe", fd], encoding: "utf8", maxBuffer: 4096, timeout: 500, killSignal: "SIGKILL",
			env: { LC_ALL: "C" },
		});
		if (result.error) throw new Error(`Resource locking unavailable: ${result.error.message}`);
		if (result.status === 0) return true;
		if (result.status === CONFLICT_EXIT) return false;
		throw new Error(`Resource locking failed (${result.signal ?? result.status}): ${result.stderr?.trim() || "no diagnostic"}`);
	}

	private metadata(path: string, key: string): ResourceGroup | undefined {
		let fd: number;
		try { fd = openSync(path, constants.O_RDONLY | NOFOLLOW | constants.O_NONBLOCK); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
		try {
			readLeaseIdentity(fd);
			if (fstatSync(fd).size > 4096) throw new Error("Resource metadata is too large.");
			const buffer = Buffer.alloc(4097), count = readSync(fd, buffer, 0, buffer.length, null);
			if (count > 4096) throw new Error("Resource metadata is too large.");
			const data = JSON.parse(buffer.subarray(0, count).toString("utf8"));
			if (data.version !== 1 || data.key !== key) throw new Error("Resource metadata identity/version mismatch.");
			return validateResourceGroup(data);
		} finally { close(fd); }
	}

	private writeMetadata(path: string, group: ResourceGroup): void {
		const temp = `${path}.${randomUUID()}.tmp`;
		try {
			const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
			try { writeFileSync(fd, JSON.stringify({ version: 1, ...group }) + "\n"); fsyncSync(fd); } finally { close(fd); }
			renameSync(temp, path);
		} finally { try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
	}

	tryAcquire(input: ResourceGroup): ResourceLease | undefined {
		const group = validateResourceGroup(input);
		privateDirectory(this.root);
		const dir = join(this.root, createHash("sha256").update(group.key).digest("hex"));
		privateDirectory(dir);
		const mutex = openLock(join(dir, "catalog.lock"));
		let acquired: ResourceLease | undefined;
		try {
			if (!this.lock(mutex)) return;
			const metadata = join(dir, "capacity.json"), previous = this.metadata(metadata, group.key);
			if (!previous || previous.capacity !== group.capacity) {
				// Capacity may change only while every extant slot is idle. Stable lock files are NEVER unlinked.
				const held: number[] = [];
				try {
					const slots = readdirSync(dir).filter(name => /^slot-\d+\.lock$/.test(name));
					if (slots.length > MAX_CAPACITY || slots.some(name => Number(name.slice(5, -5)) >= MAX_CAPACITY)) throw new Error("Invalid resource slot catalog.");
					for (const name of slots) {
						const fd = openLock(join(dir, name)); held.push(fd);
						if (!this.lock(fd)) throw new Error(`Resource ${group.key} capacity conflicts with live leases; wait for the group to become idle and use consistent limits.`);
					}
					this.writeMetadata(metadata, group);
				} finally { closeAll(held); }
			}
			for (let slot = 0; slot < group.capacity; slot++) {
				const fd = openLock(join(dir, `slot-${slot}.lock`));
				let retained = false;
				try {
					if (!this.lock(fd)) continue;
					const inherited: InheritedLease = Object.freeze({ fd, ...readLeaseIdentity(fd) });
					let released = false;
					retained = true;
					return acquired = { claim: Object.freeze({ ...group, slot }), inherited,
						release: () => { if (released) return; released = true; close(fd); },
					};
				} finally { if (!retained) close(fd); }
			}
			return;
		} finally {
			try { close(mutex); } catch (error) {
				// A lease is not handed off until enclosing cleanup also succeeds.
				try { acquired?.release(); }
				catch (releaseError) { throw new AggregateError([error, releaseError], "Resource acquisition cleanup failed."); }
				throw error;
			}
		}
	}
}
