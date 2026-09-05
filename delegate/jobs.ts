import { isFailedChildResult, normalizeTask, normalizeTimeoutMs } from "../child-runtime/policy.ts";
import { DEFAULT_WRAP_MESSAGE, type ChildControl, type ChildResult } from "../child-runtime/spawn.ts";
import { assertKind, type Kind } from "./config.ts";
import {
	applyProgress,
	clipThinkingTail,
	createProgress,
	parseChildProgress,
	type ActivityItem,
	type ProgressState,
} from "./display.ts";
import { applyTgEvent, createTgMeter, visibleChildTg, type TgMeter } from "./tg.ts";

export type JobStatus = "queued" | "running" | "done" | "failed";
export type QueueReason = "gpu" | "slot";

export type JobHandle = {
	id: string;
	kind: Kind;
	model: string;
	local: boolean;
	task: string;
	timeoutMs: number;
};

export type JobRun = (
	job: JobHandle,
	signal: AbortSignal,
	onEvent: (event: unknown) => void,
	onControl: (ctl: ChildControl) => void,
) => Promise<ChildResult>;

export type ArchiveRef = { runId: string; sessionFile: string };

export type JobSnapshot = {
	archive?: ArchiveRef;
	recordingError?: string;
	id: string;
	kind: Kind;
	model: string;
	local: boolean;
	task: string;
	status: JobStatus;
	failed: boolean;
	reason?: QueueReason;
	activity: ActivityItem[];
	current?: ActivityItem;
	thinking?: string;
	tg?: string;
	answer?: string;
	exitCode?: number;
	stopReason?: string;
	stderrTail?: string;
	background: boolean;
	wrapped?: boolean;
	quietForMs?: number;
};

export type EnqueueInput = {
	archive?: ArchiveRef;
	kind: Kind;
	model: string;
	local: boolean;
	task: string;
	timeoutMs: number;
	run: JobRun;
	background?: boolean;
	cancelOnAbort?: AbortSignal;
};

export type WaitInput = {
	timeoutMs?: number;
	quietMs?: number;
	signal?: AbortSignal;
	onSnapshot?: (snap: JobSnapshot) => void;
};

export type SchedulerLimits = {
	maxConcurrent: number;
	maxLocalConcurrent: number;
	maxQueued: number;
};

export type ParsedCall =
	| {
			mode: "spawn";
			background: boolean;
			kind: Kind;
			task: string;
			timeoutMs: number;
			modelOverride?: string;
			cwd?: string;
	  }
	| {
			mode: "collect";
			jobId: string;
			peek: boolean;
			waitMs?: number;
			wrap?: boolean;
			cancel?: boolean;
	  };

type InternalJob = {
	archive?: ArchiveRef;
	id: string;
	kind: Kind;
	model: string;
	local: boolean;
	task: string;
	timeoutMs: number;
	run?: JobRun;
	status: JobStatus;
	controller: AbortController;
	progress: ProgressState;
	meter: TgMeter;
	result?: ChildResult;
	errorMessage?: string;
	exitCode?: number;
	stopReason?: string;
	listeners: Set<(snap: JobSnapshot) => void>;
	cancelAbort?: { signal: AbortSignal; onAbort: () => void };
	background: boolean;
	terminalEmitted: boolean;
	accountingSettled: boolean;
	recordingError?: string;
	wrapped: boolean;
	queuedAt: number;
	startedAt?: number;
	lastEventAt?: number;
	control?: ChildControl;
};

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function optionalString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function parseDelegateCall(
	params: unknown,
	config: { maxTaskChars: number; defaultTimeoutMs: number; maxTimeoutMs: number },
): ParsedCall {
	const rec = asRecord(params);
	if (rec.background !== undefined && rec.background !== true && rec.background !== false) {
		throw new Error("delegate refused: background must be boolean.");
	}
	if (rec.wrap !== undefined && rec.wrap !== true && rec.wrap !== false) {
		throw new Error("delegate refused: wrap must be boolean.");
	}
	if (rec.cancel !== undefined && rec.cancel !== true && rec.cancel !== false) {
		throw new Error("delegate refused: cancel must be boolean.");
	}
	const jobId = optionalString(rec.jobId);
	if ((rec.wrap === true || rec.cancel === true) && !jobId) {
		throw new Error("delegate refused: wrap/cancel require jobId.");
	}
	if (jobId) {
		if (rec.background === true) throw new Error("delegate refused: jobId cannot combine with background.");
		if (rec.wrap === true && rec.cancel === true) {
			throw new Error("delegate refused: wrap cannot combine with cancel.");
		}
		if (rec.kind !== undefined || rec.task !== undefined || rec.cwd !== undefined || rec.model !== undefined) {
			throw new Error("delegate refused: jobId cannot combine with spawn fields.");
		}
		const raw = rec.timeoutMs;
		const collect: Extract<ParsedCall, { mode: "collect" }> = { mode: "collect", jobId, peek: false };
		if (rec.wrap === true) collect.wrap = true;
		if (rec.cancel === true) collect.cancel = true;
		if (raw === undefined || raw === null) return collect;
		if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
			throw new Error("delegate refused: timeoutMs must be an integer >= 0.");
		}
		collect.waitMs = raw;
		collect.peek = raw === 0;
		return collect;
	}
	const kind = assertKind(rec.kind);
	const task = normalizeTask(rec.task, config.maxTaskChars, "delegate");
	const timeoutMs = normalizeTimeoutMs(rec.timeoutMs, config, "delegate");
	const parsed: ParsedCall = {
		mode: "spawn",
		background: rec.background === true,
		kind,
		task,
		timeoutMs,
	};
	const modelOverride = optionalString(rec.model);
	if (modelOverride) parsed.modelOverride = modelOverride;
	const cwd = typeof rec.cwd === "string" ? rec.cwd : undefined;
	if (cwd !== undefined) parsed.cwd = cwd;
	return parsed;
}

export class JobScheduler {
	private seq = 0;
	private closed = false;
	private pumping = false;
	private pumpAgain = false;
	private readonly jobs: InternalJob[] = [];
	private readonly limits: SchedulerLimits;
	private readonly onChange?: (snap?: JobSnapshot) => void;
	private readonly onTerminal?: (snap: JobSnapshot) => void;
	private readonly onSettled?: (snap: JobSnapshot) => string | void;

	constructor(input: SchedulerLimits & { onChange?: (snap?: JobSnapshot) => void; onTerminal?: (snap: JobSnapshot) => void; onSettled?: (snap: JobSnapshot) => string | void }) {
		this.limits = {
			maxConcurrent: input.maxConcurrent,
			maxLocalConcurrent: input.maxLocalConcurrent,
			maxQueued: input.maxQueued,
		};
		this.onChange = input.onChange;
		this.onTerminal = input.onTerminal;
		this.onSettled = input.onSettled;
	}

	enqueue(input: EnqueueInput): JobSnapshot {
		if (this.closed) throw new Error("delegate refused: scheduler shutdown.");
		if (!this.canStart(input.local) && this.queuedCount() >= this.limits.maxQueued) {
			throw new Error(
				`delegate refused: ${this.queuedCount()} already queued (max ${this.limits.maxQueued}).`,
			);
		}
		this.seq += 1;
		const job: InternalJob = {
			archive: input.archive,
			id: `d${this.seq.toString(16).padStart(4, "0")}`,
			kind: input.kind,
			model: input.model,
			local: input.local,
			task: input.task,
			timeoutMs: input.timeoutMs,
			run: input.run,
			status: "queued",
			controller: new AbortController(),
			progress: createProgress(),
			meter: createTgMeter(),
			listeners: new Set(),
			background: input.background === true,
			terminalEmitted: false,
			accountingSettled: false,
			wrapped: false,
			queuedAt: Date.now(),
		};
		if (input.cancelOnAbort) {
			const onAbort = (): void => {
				this.cancel(job.id);
			};
			if (input.cancelOnAbort.aborted) {
				this.jobs.push(job);
				this.cancel(job.id);
				return this.snapshot(job);
			}
			input.cancelOnAbort.addEventListener("abort", onAbort, { once: true });
			job.cancelAbort = { signal: input.cancelOnAbort, onAbort };
		}
		this.jobs.push(job);
		this.pump();
		this.notify(job);
		return this.snapshot(job);
	}

	get(id: string): JobSnapshot {
		const job = this.find(id);
		if (!job) throw new Error(`delegate refused: unknown jobId ${id}.`);
		return this.snapshot(job);
	}

	list(): JobSnapshot[] {
		return this.jobs.map((job) => this.snapshot(job));
	}

	active(): JobSnapshot[] {
		return this.jobs.filter((job) => job.status === "queued" || job.status === "running").map((job) => this.snapshot(job));
	}

	async wait(id: string, input: WaitInput = {}): Promise<JobSnapshot> {
		const job = this.find(id);
		if (!job) throw new Error(`delegate refused: unknown jobId ${id}.`);
		const peek = input.timeoutMs === 0;
		const snap = this.snapshot(job);
		this.safeSnapshot(input.onSnapshot, snap);
		if (peek || this.terminal(job)) return snap;
		return new Promise((resolve) => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let quietTimer: ReturnType<typeof setTimeout> | undefined;
			const finish = (): void => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(this.snapshot(job));
			};
			const armQuiet = (): void => {
				if (quietTimer) {
					clearTimeout(quietTimer);
					quietTimer = undefined;
				}
				if (!input.quietMs || input.quietMs <= 0) return;
				if (job.status !== "running" && job.status !== "queued") return;
				const last = job.lastEventAt ?? job.startedAt ?? job.queuedAt;
				const remaining = input.quietMs - (Date.now() - last);
				quietTimer = setTimeout(finish, Math.max(0, remaining));
			};
			const onSnap = (next: JobSnapshot): void => {
				this.safeSnapshot(input.onSnapshot, next);
				if (next.status === "done" || next.status === "failed") finish();
				else armQuiet();
			};
			const onAbort = (): void => {
				finish();
			};
			const cleanup = (): void => {
				job.listeners.delete(onSnap);
				input.signal?.removeEventListener("abort", onAbort);
				if (timer) clearTimeout(timer);
				if (quietTimer) clearTimeout(quietTimer);
			};
			job.listeners.add(onSnap);
			if (input.signal) {
				if (input.signal.aborted) {
					finish();
					return;
				}
				input.signal.addEventListener("abort", onAbort, { once: true });
			}
			if (input.timeoutMs !== undefined && input.timeoutMs > 0) {
				timer = setTimeout(finish, input.timeoutMs);
			}
			armQuiet();
			if (this.terminal(job)) finish();
		});
	}

	promoteBackground(id: string): JobSnapshot {
		const job = this.find(id);
		if (!job) throw new Error(`delegate refused: unknown jobId ${id}.`);
		job.background = true;
		this.detachAbort(job);
		this.notify(job);
		return this.snapshot(job);
	}

	wrap(id: string, message?: string): JobSnapshot {
		const job = this.find(id);
		if (!job) throw new Error(`delegate refused: unknown jobId ${id}.`);
		if (this.terminal(job)) return this.snapshot(job);
		if (job.status === "queued") {
			this.cancel(id);
			return this.get(id);
		}
		job.wrapped = true;
		try {
			job.control?.wrap(message ?? DEFAULT_WRAP_MESSAGE);
		} catch {
			/* wrap must not break the scheduler */
		}
		this.notify(job);
		return this.snapshot(job);
	}

	cancel(id: string): void {
		const job = this.find(id);
		if (!job || this.terminal(job)) return;
		if (job.status === "queued") {
			job.status = "failed";
			job.stopReason = "aborted";
			job.exitCode = 1;
			this.releaseRuntime(job);
			try {
				this.notify(job);
			} finally {
				try {
					this.emitTerminal(job);
				} finally {
					this.pump();
				}
			}
			return;
		}
		job.controller.abort();
	}

	async shutdown(): Promise<void> {
		this.closed = true;
		const running: Promise<void>[] = [];
		for (const job of this.jobs) {
			if (job.status === "queued") this.cancel(job.id);
			else if (job.status === "running") {
				job.controller.abort();
				running.push(
					new Promise((resolve) => {
						if (this.terminal(job)) {
							resolve();
							return;
						}
						const done = (): void => {
							job.listeners.delete(doneSnap);
							resolve();
						};
						const doneSnap = (snap: JobSnapshot): void => {
							if (snap.status === "done" || snap.status === "failed") done();
						};
						job.listeners.add(doneSnap);
					}),
				);
			}
		}
		await Promise.all(running);
		this.notify();
	}

	private find(id: string): InternalJob | undefined {
		return this.jobs.find((job) => job.id === id);
	}

	private terminal(job: InternalJob): boolean {
		return job.status === "done" || job.status === "failed";
	}

	private queuedCount(): number {
		return this.jobs.filter((job) => job.status === "queued").length;
	}

	private runningJobs(): InternalJob[] {
		return this.jobs.filter((job) => job.status === "running");
	}

	private canStart(local: boolean): boolean {
		if (this.closed) return false;
		const running = this.runningJobs();
		if (running.length >= this.limits.maxConcurrent) return false;
		if (local && running.filter((job) => job.local).length >= this.limits.maxLocalConcurrent) return false;
		return true;
	}

	private queueReason(job: InternalJob): QueueReason | undefined {
		if (job.status !== "queued") return undefined;
		const running = this.runningJobs();
		if (job.local && running.filter((item) => item.local).length >= this.limits.maxLocalConcurrent) return "gpu";
		return "slot";
	}

	private handle(job: InternalJob): JobHandle {
		return {
			id: job.id,
			kind: job.kind,
			model: job.model,
			local: job.local,
			task: job.task,
			timeoutMs: job.timeoutMs,
		};
	}

	private snapshot(job: InternalJob): JobSnapshot {
		const failed =
			job.status === "failed" || (job.status === "done" && job.result ? isFailedChildResult(job.result) : false);
		const thinking = clipThinkingTail(job.progress.thinking ?? "") || undefined;
		const tg =
			job.status === "running" || job.status === "done" || job.status === "failed"
				? visibleChildTg(job.model, job.meter, undefined)
				: undefined;
		const snap: JobSnapshot = {
			...(job.archive ? { archive: { ...job.archive } } : {}),
			id: job.id,
			kind: job.kind,
			model: job.model,
			local: job.local,
			task: job.task,
			status: job.status,
			failed,
			activity: [...job.progress.done],
			current: job.status === "running" ? job.progress.current : undefined,
			background: job.background,
		};
		if (job.recordingError) snap.recordingError = job.recordingError;
		if (job.wrapped) snap.wrapped = true;
		if (job.status === "running" || job.status === "queued") {
			const last = job.lastEventAt ?? job.startedAt ?? job.queuedAt;
			snap.quietForMs = Math.max(0, Date.now() - last);
		}
		const reason = this.queueReason(job);
		if (reason) snap.reason = reason;
		if (thinking) snap.thinking = thinking;
		if (tg) snap.tg = tg;
		if (job.result) {
			snap.answer = job.result.text;
			snap.exitCode = job.result.exitCode;
			snap.stopReason = job.result.stopReason;
			snap.stderrTail = job.result.stderrTail;
			if (job.result.recordingError) snap.recordingError = job.result.recordingError;
		} else if (job.status === "failed") {
			snap.exitCode = job.exitCode ?? 1;
			snap.stopReason = job.stopReason;
			snap.answer = job.errorMessage;
		}
		return snap;
	}

	private emit(job: InternalJob): void {
		const snap = this.snapshot(job);
		for (const listener of [...job.listeners]) {
			try {
				listener(snap);
			} catch {
				/* listener errors must not break the scheduler */
			}
		}
	}

	private notify(job?: InternalJob): void {
		if (job && this.terminal(job) && !job.accountingSettled) {
			job.accountingSettled = true;
			try { job.recordingError = this.onSettled?.(this.snapshot(job)) || undefined; }
			catch { job.recordingError = "Delegate recording incomplete: terminal accounting callback failed."; }
		}
		if (job) this.emit(job);
		try {
			this.onChange?.(job ? this.snapshot(job) : undefined);
		} catch {
			/* widget errors must not break the scheduler */
		}
	}

	private safeSnapshot(onSnapshot: ((snap: JobSnapshot) => void) | undefined, snap: JobSnapshot): void {
		if (!onSnapshot) return;
		try {
			onSnapshot(snap);
		} catch {
			/* wait observers must not break collect */
		}
	}

	private detachAbort(job: InternalJob): void {
		if (!job.cancelAbort) return;
		job.cancelAbort.signal.removeEventListener("abort", job.cancelAbort.onAbort);
		job.cancelAbort = undefined;
	}

	private releaseRuntime(job: InternalJob): void {
		this.detachAbort(job);
		// Keep collectible snapshots, not closures retaining the process and uncapped RPC state.
		job.control = undefined;
		job.run = undefined;
	}

	private pump(): void {
		if (this.pumping) {
			this.pumpAgain = true;
			return;
		}
		this.pumping = true;
		try {
			do {
				this.pumpAgain = false;
				while (true) {
					const next = this.jobs.find((job) => job.status === "queued" && this.canStart(job.local));
					if (!next) break;
					this.start(next);
				}
			} while (this.pumpAgain);
		} finally {
			this.pumping = false;
		}
	}

	private start(job: InternalJob): void {
		job.status = "running";
		job.startedAt = Date.now();
		job.lastEventAt = job.startedAt;
		try {
			this.notify(job);
		} finally {
			void this.execute(job);
		}
	}

	private async execute(job: InternalJob): Promise<void> {
		try {
			const run = job.run;
			if (!run) throw new Error("delegate job has no runner.");
			const result = await run(
				this.handle(job),
				job.controller.signal,
				(event) => {
					if (job.status !== "running") return;
					job.lastEventAt = Date.now();
					const item = parseChildProgress(event);
					if (item) applyProgress(job.progress, item);
					if (job.local) applyTgEvent(job.meter, event);
					this.notify(job);
				},
				(ctl) => {
					if (job.status === "running") job.control = ctl;
				},
			);
			if (job.status === "queued") return;
			job.result = result;
			job.status = isFailedChildResult(result) ? "failed" : "done";
			if (result.model) job.model = result.model;
		} catch (error) {
			if (job.status !== "failed" || !job.result) {
				job.status = "failed";
				job.stopReason = job.controller.signal.aborted ? "aborted" : "error";
				job.errorMessage = error instanceof Error ? error.message : String(error);
				job.exitCode = 1;
			}
		} finally {
			this.releaseRuntime(job);
			try {
				this.notify(job);
			} finally {
				try {
					this.emitTerminal(job);
				} finally {
					this.pump();
				}
			}
		}
	}

	private emitTerminal(job: InternalJob): void {
		if (job.terminalEmitted) return;
		if (!this.terminal(job)) return;
		job.terminalEmitted = true;
		if (this.closed || !this.onTerminal) return;
		try {
			this.onTerminal(this.snapshot(job));
		} catch {
			/* notify errors must not break the scheduler */
		}
	}
}
