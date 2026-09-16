import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface LocalAdmission {
	enabled(): boolean;
	acquire(): (() => void) | undefined;
}

export type LocalStatus = { enabled: boolean; active: number; uncertain: number };
type State = { enabled: boolean; revision: string };
export const LOCAL_OFF_MESSAGE = "delegate refused: local delegation is OFF. Use /delegate-local on to enable it. Hosted delegation is unchanged; no automatic fallback.";

function missing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function privateDirectory(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	const stat = lstatSync(path);
	if (!stat.isDirectory() || (process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))) {
		throw new Error(`Local delegation directory must be private and owned by you: ${path}`);
	}
}

function processAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Shared only by participating processes using the same local agent directory. No server control. */
export class LocalControl implements LocalAdmission {
	readonly root: string;
	private readonly alive: (pid: number) => boolean;

	constructor(root: string, alive = processAlive) {
		this.root = root;
		this.alive = alive;
	}

	private prepare(): void {
		privateDirectory(this.root);
		privateDirectory(join(this.root, "active"));
	}

	private state(): State {
		this.prepare();
		let fd: number;
		try { fd = openSync(join(this.root, "state.json"), constants.O_RDONLY | constants.O_NOFOLLOW); }
		catch (error) { if (missing(error)) return { enabled: true, revision: "initial" }; throw error; }
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile() || stat.size > 1024) throw new Error("Invalid local delegation state file");
			const value = JSON.parse(readFileSync(fd, "utf8"));
			if (typeof value?.enabled !== "boolean" || typeof value?.revision !== "string" || !/^[\da-f-]{36}$/.test(value.revision)) {
				throw new Error("Invalid local delegation state");
			}
			return value;
		} finally { closeSync(fd); }
	}

	enabled(): boolean { return this.state().enabled; }

	assertEnabled(): void {
		if (!this.enabled()) throw new Error(LOCAL_OFF_MESSAGE);
	}

	setEnabled(enabled: boolean): void {
		this.prepare();
		const revision = randomUUID();
		const temp = join(this.root, `${revision}.tmp`);
		try {
			writeFileSync(temp, JSON.stringify({ enabled, revision }), { flag: "wx", mode: 0o600 });
			renameSync(temp, join(this.root, "state.json"));
		} finally {
			try { unlinkSync(temp); } catch (error) { if (!missing(error)) throw error; }
		}
	}

	acquire(): (() => void) | undefined {
		this.prepare();
		const path = join(this.root, "active", `${process.pid}.${randomUUID()}`);
		// Publish BEFORE checking the switch: an OFF snapshot either counts this reservation,
		// or this caller observes OFF and cannot start. No check-then-spawn gap or stale cache.
		writeFileSync(path, "", { flag: "wx", mode: 0o600 });
		const release = () => { try { unlinkSync(path); } catch (error) { if (!missing(error)) throw error; } };
		try {
			if (this.enabled()) return release;
		} catch (error) { release(); throw error; }
		release();
		return undefined;
	}

	status(): LocalStatus {
		for (let attempt = 0; attempt < 3; attempt++) {
			const before = this.state();
			let active = 0, uncertain = 0;
			for (const entry of readdirSync(join(this.root, "active"), { withFileTypes: true })) {
				const match = /^(\d+)\.[\da-f-]{36}$/.exec(entry.name);
				const pid = Number(match?.[1]);
				if (entry.isFile() && Number.isSafeInteger(pid) && pid > 0 && this.alive(pid)) active++;
				else uncertain++;
			}
			// Detect concurrent changes (including ON -> OFF -> ON); never pair a stale
			// activity scan with a new OFF state and falsely report idle.
			if (before.revision === this.state().revision) return { enabled: before.enabled, active, uncertain };
		}
		throw new Error("Local delegation status changed while reading; retry /delegate-local status.");
	}
}

export function localStatusText(status: LocalStatus): string {
	const count = `${status.active} ${status.active === 1 ? "job" : "jobs"}`;
	const activity = status.active ? status.enabled ? `${count} active` : `draining ${count}` : "idle";
	return `Local delegation: ${status.enabled ? "ON" : "OFF"} · ${status.uncertain ? `${status.active} active · ${status.uncertain} unverified (not idle)` : activity}`;
}
