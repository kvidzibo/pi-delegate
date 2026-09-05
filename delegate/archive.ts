import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { readdir, readFile, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { emptyUsage, record, sessionUsage, totalTokens, UsageMeter, validUsage, type UsageSummary } from "./usage.ts";
import type { Kind } from "./config.ts";

export type RunRecord = {
	version: 1;
	revision: number;
	runId: string;
	parentSessionId: string;
	parentSessionFile?: string;
	toolCallId: string;
	jobId?: string;
	kind: Kind;
	cwd: string;
	requestedModel: string;
	actualModel?: string;
	thinking: string;
	tools: string[];
	createdAt: string;
	startedAt?: string;
	finishedAt?: string;
	status: "queued" | "running" | "done" | "failed";
	stopReason?: string;
	exitCode?: number;
	durationMs: number;
	usage: UsageSummary;
	recordingError?: string;
};

export type RunIdentity = Pick<RunRecord, "parentSessionId" | "parentSessionFile" | "toolCallId" | "kind" | "cwd" | "requestedModel" | "thinking" | "tools">;
export type Outcome = { status: "done" | "failed"; stopReason?: string; exitCode?: number };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function archiveRoot(agentDir: string, env: NodeJS.Dict<string> = process.env): string {
	return resolve(env.PI_DELEGATE_ARCHIVE_DIR?.trim() || join(agentDir, "delegate"));
}

export function runPaths(root: string, id: string) {
	if (!UUID.test(id)) throw new Error("Invalid delegate archive run ID");
	const dir = join(root, "runs", id);
	return { dir, session: join(dir, "session.jsonl"), metadata: join(dir, "metadata.json"), prompt: join(dir, "system-prompt.md"), task: join(dir, "task.md") };
}

function privateDirectory(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Archive directory is not a real directory: ${path}`);
	if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) {
		throw new Error(`Archive directory must be owned by you with mode 0700: ${path}`);
	}
}

function atomicJson(path: string, data: unknown): void {
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temp, `${JSON.stringify(data)}\n`, { flag: "wx", mode: 0o600 });
		renameSync(temp, path);
	} finally {
		try { unlinkSync(temp); } catch { /* only our disposable metadata temp, never archived data */ }
	}
}

/** One append syscall per small record. The per-run metadata is authoritative if an append is interrupted. */
export function appendLedger(root: string, data: RunRecord): void {
	const fd = openSync(join(root, "usage.jsonl"), constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error("Delegate ledger must be a private regular file");
		const last = Buffer.alloc(1);
		const separator = stat.size > 0 && readSync(fd, last, 0, 1, stat.size - 1) === 1 && last[0] !== 10 ? "\n" : "";
		// Isolate a torn previous tail so the first rebuild row is not swallowed by it.
		const buffer = Buffer.from(`${separator}${JSON.stringify(data)}\n`);
		if (writeSync(fd, buffer) !== buffer.length) throw new Error("Short delegate ledger write; rebuild from archives");
	} finally { closeSync(fd); }
}

export class ArchivedRun {
	readonly paths: ReturnType<typeof runPaths>;
	readonly meter: UsageMeter;
	readonly data: RunRecord;
	private finished = false;
	private errorNotified = false;
	private onError: (message: string) => void;
	private root: string;

	constructor(root: string, identity: RunIdentity, task: string, promptPath: string, onError: (message: string) => void = () => {}) {
		this.root = root;
		this.onError = onError;
		privateDirectory(root);
		privateDirectory(join(root, "runs"));
		const runId = randomUUID();
		this.paths = runPaths(root, runId);
		// Never reuse or replace an existing run directory.
		mkdirSync(this.paths.dir, { mode: 0o700 });
		this.meter = new UsageMeter(identity.requestedModel);
		this.data = { ...identity, tools: [...identity.tools], version: 1, revision: 0, runId, createdAt: new Date().toISOString(), status: "queued", durationMs: 0, usage: emptyUsage() };
		// A valid pre-created header persists even when Pi never accepts its first prompt.
		writeFileSync(this.paths.session, `${JSON.stringify({ type: "session", version: 3, id: runId, timestamp: this.data.createdAt, cwd: identity.cwd, parentSession: identity.parentSessionFile })}\n`, { flag: "wx", mode: 0o600 });
		writeFileSync(this.paths.task, task, { flag: "wx", mode: 0o600 });
		writeFileSync(this.paths.prompt, readFileSync(promptPath), { flag: "wx", mode: 0o600 });
		atomicJson(this.paths.metadata, this.data);
	}

	start(jobId: string): void {
		this.data.jobId = jobId;
		this.data.startedAt = new Date().toISOString();
		this.data.status = "running";
		this.data.revision++;
		// Refuse launch if recording cannot be established. Do not silently run without an archive.
		atomicJson(this.paths.metadata, this.data);
	}

	observe(event: unknown): boolean {
		if (this.finished) return false;
		const result = this.meter.observe(event);
		if (result.changed) {
			this.data.actualModel = this.meter.resolvedModel;
			this.data.usage = this.meter.snapshot();
			if (result.checkpoint) this.persist();
		}
		return result.changed;
	}

	failRecording(error: unknown): void {
		this.data.recordingError = `Delegate recording incomplete: ${error instanceof Error ? error.message : String(error)}`;
		this.data.usage.incomplete = true;
		if (!this.errorNotified) {
			this.errorNotified = true;
			try { this.onError(this.data.recordingError); } catch { /* diagnostics cannot alter the child outcome */ }
		}
	}

	private persist(): void {
		this.data.revision++;
		try { atomicJson(this.paths.metadata, this.data); } catch (error) { this.failRecording(error); }
	}

	private complete(outcome: Outcome): void {
		this.finished = true;
		Object.assign(this.data, outcome, { finishedAt: new Date().toISOString() });
		this.data.durationMs = this.data.startedAt ? Math.max(0, Date.now() - Date.parse(this.data.startedAt)) : 0;
		this.persist();
		try { appendLedger(this.root, this.data); } catch (error) { this.failRecording(error); this.persist(); }
	}

	finishQueued(jobId: string, outcome: Outcome): void {
		if (this.finished || this.data.startedAt) return;
		this.data.jobId = jobId;
		this.complete(outcome);
	}

	async finish(outcome: Outcome): Promise<void> {
		if (this.finished) return;
		try {
			const native = await sessionUsage(this.paths.session, this.data.requestedModel);
			const live = this.meter.snapshot();
			// A killed in-flight turn can have reported usage but no persisted message_end.
			// Keep that observed lower bound, flagged incomplete, instead of losing it.
			if (totalTokens(live) > totalTokens(native)) { this.data.usage = live; this.data.usage.incomplete = true; }
			else { this.data.usage = native; this.data.usage.incomplete ||= live.incomplete; }
			this.data.usage.incomplete ||= !this.meter.settled || this.data.usage.reported === 0 || Boolean(this.data.recordingError);
		} catch (error) { this.failRecording(error); }
		this.complete(outcome);
	}
}

function validRecord(value: unknown, id: string): value is RunRecord {
	const r = record(value);
	return r.version === 1 && Number.isSafeInteger(r.revision) && r.revision >= 0 && r.runId === id && UUID.test(id)
		&& ["parentSessionId", "toolCallId", "cwd", "requestedModel", "thinking", "createdAt"].every((k) => typeof r[k] === "string")
		&& ["recon", "implement", "review", "oracle"].includes(r.kind)
		&& ["queued", "running", "done", "failed"].includes(r.status)
		&& Array.isArray(r.tools) && r.tools.every((t: unknown) => typeof t === "string")
		&& Number.isFinite(Date.parse(r.createdAt)) && Number.isFinite(r.durationMs) && r.durationMs >= 0;
}

export type ArchiveWarning = { message: string; parentSessionId?: string; createdAt?: string };

export async function loadRuns(root: string, options: { rebuild?: boolean; activeIds?: Set<string> } = {}): Promise<{ runs: RunRecord[]; warnings: ArchiveWarning[] }> {
	const result: { runs: RunRecord[]; warnings: ArchiveWarning[] } = { runs: [], warnings: [] };
	let dirs;
	try { dirs = await readdir(join(root, "runs"), { withFileTypes: true }); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.warnings.push({ message: `Cannot read delegate archive: ${String(error)}` });
		return result;
	}
	for (const dir of dirs) {
		if (!UUID.test(dir.name)) continue;
		let owner: Omit<ArchiveWarning, "message"> = {};
		try {
			if (!dir.isDirectory()) throw new Error("Run path is not a real directory");
			const paths = runPaths(root, dir.name);
			if (!(await lstat(paths.metadata)).isFile()) throw new Error("Metadata is not a regular file");
			const data: unknown = JSON.parse(await readFile(paths.metadata, "utf8"));
			const raw = record(data);
			owner = { parentSessionId: typeof raw.parentSessionId === "string" ? raw.parentSessionId : undefined, createdAt: typeof raw.createdAt === "string" && Number.isFinite(Date.parse(raw.createdAt)) ? raw.createdAt : undefined };
			if (!validRecord(data, dir.name)) throw new Error("Invalid or unsupported run metadata");
			const active = options.activeIds?.has(data.runId);
			const previousUsage = validUsage(data.usage) ? data.usage : undefined;
			if (!previousUsage && active) throw new Error("Invalid usage summary for active run");
			if (!active && (options.rebuild || data.status === "running" || !previousUsage)) {
				if (!(await lstat(paths.session)).isFile()) throw new Error("Transcript is not a regular file");
				const usage = await sessionUsage(paths.session, data.requestedModel);
				// Never erase reported partial usage that could not reach a native finalized entry.
				if (!previousUsage || totalTokens(usage) >= totalTokens(previousUsage)) data.usage = { ...usage, incomplete: usage.incomplete || Boolean(previousUsage?.incomplete) };
				else data.usage.incomplete = true;
				if (data.status === "queued" || data.status === "running" || data.recordingError || (data.startedAt && !data.usage.reported)) data.usage.incomplete = true;
				// Rebuild appends corrected snapshots, never rewrites/deletes historical ledger rows.
				// Leave metadata alone: another Pi process may still own this run.
				if (options.rebuild) appendLedger(root, data);
			}
			if (!active && data.status === "queued") data.usage.incomplete = true;
			result.runs.push(data);
		} catch (error) { result.warnings.push({ ...owner, message: `Archive ${dir.name}: ${String(error)}` }); }
	}
	return result;
}
