import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { assertNotNested, normalizeTask, resolveChildCwd } from "../child-runtime/policy.ts";
import type { PiInvocation } from "../child-runtime/spawn.ts";
import { Accounting } from "./accounting.ts";
import { archiveRoot, type ArchivedRun, type RunIdentity } from "./archive.ts";
import { describeCapabilities } from "./capabilities.ts";
import { FileCapacityBroker } from "./capacity.ts";
import { assertKind, resolveAgent, type AgentConfig, type DelegateConfig, type Kind } from "./config.ts";
import { JobScheduler, type JobSnapshot } from "./jobs.ts";
import { runChild } from "./spawn.ts";
import { isLocalModel } from "./tg.ts";

/** Shared acceptance/execution path. Hosts own consent, observers and lifecycle. */
export function enqueueDelegate(input: {
	scheduler: JobScheduler;
	accounting: Accounting;
	identity: Omit<RunIdentity, "tools" | "capabilities">;
	agent: AgentConfig;
	task: string;
	promptPath: string;
	timeoutMs: number;
	background: boolean;
	config: Pick<DelegateConfig, "hardTimeoutMs" | "maxOutputBytes">;
	signal?: AbortSignal;
	env?: NodeJS.Dict<string>;
	invocation?: PiInvocation;
	leaseGuardPath?: string;
	childRunner?: typeof runChild;
	onAccepted?: (archive: ArchivedRun) => void;
	beforeRun?: (archive: ArchivedRun, signal: AbortSignal) => Promise<void> | void;
}): JobSnapshot {
	const agent = { ...input.agent, tools: [...input.agent.tools] };
	const tools = agent.tools;
	const capabilities = describeCapabilities(tools);
	const local = isLocalModel(input.identity.requestedModel);
	const archive = input.accounting.create({ ...input.identity, tools, capabilities }, input.task, input.promptPath);
	try {
		input.onAccepted?.(archive);
		return input.scheduler.enqueue({
			archive: { runId: archive.data.runId, sessionFile: archive.paths.session }, capabilities,
			kind: input.identity.kind, model: input.identity.requestedModel, reasoning: agent.thinking,
			local, task: input.task, timeoutMs: input.timeoutMs,
			...(local ? { resourceGroup: { key: "local-delegate", capacity: 1 } } : {}),
			background: input.background, cancelOnAbort: input.background ? undefined : input.signal,
			run: (handle, childSignal, onEvent, onControl) => input.accounting.run(archive, handle.id, async onUsage => {
				const preparation = input.beforeRun?.(archive, childSignal);
				if (preparation) await preparation;
				childSignal.throwIfAborted();
				return (input.childRunner ?? runChild)({
					task: input.task, cwd: input.identity.cwd, model: input.identity.requestedModel,
					thinking: agent.thinking, tools: [...tools],
					...(local ? { resourceLease: handle.resourceLease, leaseStartupMs: 15000 } : {}),
					hardTimeoutMs: input.config.hardTimeoutMs, maxOutputBytes: input.config.maxOutputBytes,
					promptSourcePath: archive.paths.prompt, sessionFile: archive.paths.session,
					signal: childSignal, env: input.env ?? process.env,
					invocation: input.invocation, leaseGuardPath: input.leaseGuardPath,
					onEvent: event => { onUsage(event); onEvent(event); }, onControl,
				});
			}, childSignal),
		});
	} catch (error) {
		input.accounting.terminal(archive.data.runId, "refused", { status: "failed", stopReason: "error", exitCode: 1 });
		throw error;
	}
}

export type JobReceipt = Omit<JobSnapshot, "id" | "archive" | "background" | "queuedAt" | "startedAt" | "reason"> & {
	jobId: string;
	terminal: boolean;
	cwd: string;
	queueReason?: JobSnapshot["reason"];
	archive: { runId: string; sessionFile: string };
	durationMs?: number;
	elapsedMs?: number;
	queuedForMs: number;
};

export interface ServiceOptions {
	workspace: string;
	agentDir: string;
	config: DelegateConfig;
	promptDir: string;
	invocation: PiInvocation;
	leaseGuardPath: string;
	allowModelOverride?: boolean;
	env?: NodeJS.Dict<string>;
	/** Test/host injection; never exposed as an MCP parameter. */
	childRunner?: typeof runChild;
}

/** Connection-owned headless host; no Pi session, UI, snapshots or model calls. */
export class DelegateService {
	private readonly ownerId = randomUUID();
	private readonly workspace: string;
	private readonly config: DelegateConfig;
	private readonly accounting: Accounting;
	private readonly scheduler: JobScheduler;
	private readonly requests = new Map<string, { fingerprint: string; jobId: string }>();
	private readonly jobs = new Map<string, { internalId: string; cwd: string; finishedAt?: number }>();
	private closing?: Promise<void>;
	private closed = false;
	private readonly options: ServiceOptions;

	constructor(options: ServiceOptions) {
		this.options = options;
		assertNotNested(options.env ?? process.env);
		this.workspace = realpathSync(resolveChildCwd(options.workspace, process.cwd()));
		// Ignore even explicit inherited repository approvals: MCP has no consent UI.
		this.config = { ...options.config, snapshots: { defaultEnabled: false, repositories: {} } };
		this.accounting = new Accounting(archiveRoot(options.agentDir, options.env));
		this.scheduler = new JobScheduler({
			maxConcurrent: this.config.maxConcurrent, maxLocalConcurrent: this.config.maxLocalConcurrent,
			maxQueued: this.config.maxQueued,
			capacity: { tryAcquire: group => new FileCapacityBroker(join(options.agentDir, "delegate-capacity")).tryAcquire(group) },
			onSettled: snap => {
				const owned = snap.archive && this.jobs.get(snap.archive.runId);
				if (owned) owned.finishedAt = Date.now();
				return this.accounting.terminal(snap.archive?.runId, snap.id, {
					status: snap.failed ? "failed" : "done", stopReason: snap.stopReason, exitCode: snap.exitCode,
					finalization: snap.finalization, evidence: snap.outcome?.evidence,
				});
			},
		});
	}

	start(input: { kind: Kind; task: string; requestId: string; cwd?: string; model?: string }): { job: JobReceipt; reused: boolean } {
		if (this.closed) throw new Error("Delegate server is shutting down.");
		assertNotNested(this.options.env ?? process.env);
		const kind = assertKind(input.kind);
		const task = normalizeTask(input.task, this.config.maxTaskChars);
		if (typeof input.requestId !== "string" || !input.requestId.trim() || input.requestId.length > 128) throw new Error("requestId must be nonblank and at most 128 characters.");
		if (input.model !== undefined && !this.options.allowModelOverride) throw new Error("Model overrides are disabled; configure role models or start with --allow-model-override.");
		const cwd = realpathSync(resolveChildCwd(input.cwd, this.workspace));
		const subpath = relative(this.workspace, cwd);
		if (isAbsolute(subpath) || subpath === ".." || subpath.startsWith("../") || subpath.startsWith("..\\")) throw new Error("cwd must be inside the configured workspace (not a filesystem sandbox).");
		// Retries belong to their original acceptance, even after an operator changes role defaults.
		const fingerprint = JSON.stringify([kind, task, cwd, input.model ?? null]);
		const previous = this.requests.get(input.requestId);
		if (previous) {
			if (previous.fingerprint !== fingerprint) throw new Error("requestId was already used with different arguments.");
			return { job: this.receipt(previous.jobId), reused: true };
		}
		const resolved = resolveAgent(kind, input.model, this.config);
		// Scheduler retains collectible snapshots. Bound process-lifetime admission rather than evicting retry identities.
		if (this.jobs.size >= 256) throw new Error("This connection has accepted 256 jobs; collect results and restart the server before starting more.");
		const snap = enqueueDelegate({
			scheduler: this.scheduler, accounting: this.accounting,
			identity: { parentSessionId: this.ownerId, toolCallId: randomUUID(), kind, cwd,
				requestedModel: resolved.model, thinking: resolved.agent.thinking,
				savingsUnavailable: "MCP does not load the parent pricing registry/calibration estimates." },
			agent: resolved.agent, task, promptPath: join(this.options.promptDir, `${kind}.md`),
			timeoutMs: this.config.defaultTimeoutMs, background: true, config: this.config,
			env: this.options.env, invocation: this.options.invocation, leaseGuardPath: this.options.leaseGuardPath,
			childRunner: this.options.childRunner,
		});
		const jobId = snap.archive!.runId;
		this.jobs.set(jobId, { internalId: snap.id, cwd });
		this.requests.set(input.requestId, { fingerprint, jobId });
		return { job: this.receipt(jobId), reused: false };
	}

	async status(jobId: string, waitMs: number, signal?: AbortSignal): Promise<{ job: JobReceipt }> {
		if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 20000) throw new Error("waitMs must be an integer from 0 to 20000.");
		await this.scheduler.wait(this.owned(jobId).internalId, { timeoutMs: waitMs, signal });
		return { job: this.receipt(jobId) };
	}

	list(cursor = 0): { jobs: JobReceipt[]; nextCursor?: number } {
		if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > this.jobs.size) throw new Error("Invalid job-list cursor.");
		const ids = [...this.jobs.keys()];
		const jobs = ids.slice(cursor, cursor + 20).map(id => {
			const receipt = this.receipt(id);
			delete receipt.answer;
			delete receipt.stderrTail;
			receipt.task = receipt.task.length > 240 ? `${receipt.task.slice(0, 240)}…` : receipt.task;
			receipt.activity = receipt.activity.slice(-3);
			return receipt;
		});
		return { jobs, ...(cursor + 20 < ids.length ? { nextCursor: cursor + 20 } : {}) };
	}

	control(jobId: string, action: "wrap" | "cancel"): { job: JobReceipt } {
		const owned = this.owned(jobId);
		if (action === "wrap") this.scheduler.wrap(owned.internalId);
		else if (action === "cancel") this.scheduler.cancel(owned.internalId);
		else throw new Error("action must be wrap or cancel.");
		return { job: this.receipt(jobId) };
	}

	private owned(jobId: string) {
		const owned = this.jobs.get(jobId);
		if (!owned) throw new Error("Unknown jobId for this server connection; jobs cannot be adopted after restart.");
		return owned;
	}

	private receipt(jobId: string): JobReceipt {
		const owned = this.owned(jobId);
		const { id: _id, background: _background, queuedAt, startedAt, reason, archive, ...snap } = this.scheduler.get(owned.internalId);
		const terminal = snap.status === "done" || snap.status === "failed";
		const now = Date.now();
		return { ...snap, jobId, cwd: owned.cwd, terminal, archive: archive!,
			...(reason ? { queueReason: reason } : {}),
			queuedForMs: Math.max(0, (startedAt ?? owned.finishedAt ?? now) - (queuedAt ?? now)),
			...(startedAt && !terminal ? { elapsedMs: Math.max(0, now - startedAt) } : {}),
			...(terminal ? { durationMs: this.accounting.durationMs(jobId) } : {}),
		};
	}

	/** Trusted host settings only; queued/running workers retain their acceptance-time configuration. */
	updateRoleSettings(agents: DelegateConfig["agents"]): void {
		if (this.closed) throw new Error("Delegate server is shutting down.");
		this.config.agents = Object.fromEntries(Object.entries(agents).map(([kind, agent]) =>
			[kind, { ...agent, tools: [...agent.tools] }])) as DelegateConfig["agents"];
	}

	shutdown(): Promise<void> {
		this.closed = true;
		return this.closing ??= this.scheduler.shutdown().finally(() => this.accounting.close());
	}
}
