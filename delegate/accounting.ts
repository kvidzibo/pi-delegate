import { isFailedChildResult } from "../child-runtime/policy.ts";
import type { ChildResult } from "../child-runtime/spawn.ts";
import { ArchivedRun, loadRuns, type RunIdentity, type RunRecord, type Outcome, type ArchiveWarning } from "./archive.ts";
import { infobar, inScope, statsReport, type StatsScope } from "./stats.ts";

export type AccountingUI = {
	setStatus: (key: string, text: string | undefined) => void;
	notify: (text: string, type?: "info" | "warning" | "error") => void;
};

/** One controller per extension/session lifetime. No factory timers, files, or provider calls. */
export class Accounting {
	readonly root: string;
	private sessionId = "";
	private ui?: AccountingUI;
	private records = new Map<string, RunRecord>();
	private active = new Map<string, ArchivedRun>();
	private warnings: ArchiveWarning[] = [];
	private generation = 0;
	private lastStatus?: string;

	constructor(root: string) { this.root = root; }

	async activate(sessionId: string, ui?: AccountingUI): Promise<void> {
		const generation = ++this.generation;
		this.sessionId = sessionId; this.ui = ui; this.lastStatus = undefined;
		this.records.clear(); this.warnings = [];
		for (const [id, archive] of this.active) this.records.set(id, archive.data);
		this.paint();
		const loaded = await loadRuns(this.root, { activeIds: new Set(this.active.keys()) });
		if (generation !== this.generation) return;
		for (const run of loaded.runs) if (run.parentSessionId === sessionId && !this.records.has(run.runId)) this.records.set(run.runId, run);
		this.warnings = loaded.warnings;
		this.paint();
	}

	private paint(): void {
		const text = infobar([...this.records.values()].filter((r) => r.parentSessionId === this.sessionId),
			this.warnings.some((w) => w.parentSessionId === this.sessionId), this.warnings.some((w) => !w.parentSessionId));
		if (text !== this.lastStatus) {
			try { this.ui?.setStatus("delegate-usage", text); this.lastStatus = text; } catch { /* UI is an observer, not a job dependency */ }
		}
	}

	private warn = (warning: ArchiveWarning): void => {
		this.warnings.push(warning);
		try {
			if (this.ui) this.ui.notify(warning.message, "warning");
			else process.stderr.write(`${warning.message}\n`);
		} catch { /* observer failure must not change child outcomes */ }
		this.paint();
	};

	create(identity: RunIdentity, task: string, promptPath: string): ArchivedRun {
		const archive: ArchivedRun = new ArchivedRun(this.root, identity, task, promptPath, (message) => this.warn({ message, parentSessionId: identity.parentSessionId, createdAt: archive.data.createdAt }));
		this.active.set(archive.data.runId, archive);
		this.records.set(archive.data.runId, archive.data);
		this.paint();
		return archive;
	}

	async run(archive: ArchivedRun, jobId: string, execute: (onEvent: (event: unknown) => void) => Promise<ChildResult>): Promise<ChildResult> {
		try {
			archive.start(jobId);
			this.paint();
			const result = await execute((event) => { if (archive.observe(event)) this.paint(); });
			await archive.finish({ status: isFailedChildResult(result) ? "failed" : "done", stopReason: result.stopReason, exitCode: result.exitCode });
			return { ...result, ...(archive.data.recordingError ? { recordingError: archive.data.recordingError } : {}) };
		} catch (error) {
			await archive.finish({ status: "failed", stopReason: "error", exitCode: 1 });
			throw error;
		} finally {
			this.active.delete(archive.data.runId);
			this.paint();
		}
	}

	/** Also called for queued cancellation and session shutdown, not just completion notifications. */
	terminal(runId: string | undefined, jobId: string, outcome: Outcome): string | undefined {
		if (!runId) return;
		const archive = this.active.get(runId);
		if (!archive) return this.records.get(runId)?.recordingError;
		archive.finishQueued(jobId, outcome);
		if (archive.data.finishedAt) this.active.delete(runId);
		this.paint();
		return archive.data.recordingError;
	}

	async report(scope: StatsScope, sessionId: string, rebuild = false): Promise<string> {
		const loaded = await loadRuns(this.root, { rebuild, activeIds: new Set(this.active.keys()) });
		const runs = new Map(loaded.runs.map((run) => [run.runId, run]));
		for (const [id, archive] of this.active) runs.set(id, archive.data);
		// Memory retains recording-error outcomes even when disk writes failed.
		for (const [id, run] of this.records) if (run.recordingError) runs.set(id, run);
		const warnings = [...loaded.warnings, ...this.warnings];
		const scoped = warnings.filter((w) => scope === "all" || (scope === "session" ? w.parentSessionId === sessionId : w.createdAt && inScope({ createdAt: w.createdAt, parentSessionId: w.parentSessionId ?? "" }, "today", sessionId))).map((w) => w.message);
		if (scope !== "all" && warnings.some((w) => scope === "session" ? !w.parentSessionId : !w.createdAt)) {
			scoped.push("Some archive errors cannot be attributed to this scope; totals may be incomplete. Use /delegate-stats all for archive diagnostics.");
		}
		return statsReport([...runs.values()].filter((run) => inScope(run, scope, sessionId)), this.root, scope, [...new Set(scoped)]);
	}

	close(): void {
		++this.generation;
		try { this.ui?.setStatus("delegate-usage", undefined); } catch { /* UI may already be gone */ }
		this.ui = undefined; this.lastStatus = undefined;
		this.records.clear(); this.active.clear(); this.warnings = [];
	}
}
