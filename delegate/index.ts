import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { fingerprint, loadSavingsSnapshot } from "./calibration.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, keyHint, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { Container, Text } from "@earendil-works/pi-tui";
import { assertNotNested, resolveChildCwd, truncateOutput } from "../child-runtime/policy.ts";
import { promptSourceFromDir } from "../child-runtime/spawn.ts";
import { copyFinalizationProgress } from "../child-runtime/guard-protocol.ts";
import { loadDelegateConfig, resolveAgent, type Kind } from "./config.ts";
import {
	delegateTargetLine,
	durationContent,
	knownKind,
} from "./display.ts";
import { JobScheduler, parseDelegateCall, type JobSnapshot } from "./jobs.ts";
import { NOTIFY_CUSTOM_TYPE, NotifyGate, shouldConsume, type NotifyDetails } from "./notify.ts";
import { runChild } from "./spawn.ts";
import { Accounting } from "./accounting.ts";
import { registerDelegateCommand } from "./command.ts";
import { showStats } from "./stats-view.ts";
import { showJobs } from "./jobs-view.ts";
import { archiveRoot } from "./archive.ts";
import { isLocalModel } from "./tg.ts";
import { renderChildCall, renderChildResult, renderJobBoard, renderNotifyMessage, type RowState } from "./view.ts";
import { CARD_STATE_TYPE, JobCards, isTerminal, type CardDetails } from "./cards.ts";
import { JobBoard, plainBoardTheme, type BoardUi } from "./board.ts";
import { projectJobBoard } from "./panel.ts";
import { ModelCommand } from "./model-command.ts";
import { capabilityContent, copyCapabilities, describeCapabilities, type CapabilityManifest } from "./capabilities.ts";
import { copyOutcome, outcomeContent } from "./outcomes.ts";
import { respondToBusyQuery } from "./busy-guard.ts";
import { FileCapacityBroker } from "./capacity.ts";
import { snapshotCommand } from "./snapshot-command.ts";
import { AUDIT_CHECKS, parseAuditCall, SnapshotAudits } from "./snapshot-audit.ts";
import { captureRepository, formatSnapshotBytes, repositoryFor, repositorySnapshotStats, snapshotDirectory, snapshotEnabled, snapshotNeedsAudit, snapshotSettings, type Repository } from "./snapshots.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

// Validation happens before execute: admit empty placeholders at the schema boundary too.
const optionalArgument = <T extends TSchema>(schema: T) => Type.Optional(Type.Union([
	schema, Type.Null(), Type.String({ pattern: "^\\s*$" }),
], { description: schema.description }));

function agentDir(): string {
	return typeof getAgentDir === "function" ? getAgentDir() : join(homedir(), ".pi", "agent");
}

function errorResult(message: string, requested?: CapabilityManifest) {
	const capabilities = copyCapabilities(requested);
	return {
		content: [{ type: "text" as const, text: message }, ...capabilityContent(capabilities)],
		details: { ok: false, ...(capabilities ? { capabilities } : {}) },
		isError: true,
	};
}

type ViewContext = {
	toolCallId: string;
	state: Record<string, unknown>;
	args?: Record<string, unknown>;
	isPartial: boolean;
	expanded: boolean;
	isError?: boolean;
	invalidate?: () => void;
};

function receiptText(snap: JobSnapshot): string {
	if (snap.status === "queued") {
		const why = snap.reason ? ` ${snap.reason}` : "";
		const wait = snap.reason === "resource" ? `Waiting for shared resource${snap.resource ? ` ${snap.resource.key}` : ""}.`
			: snap.reason === "gpu" ? "Waiting for gpu." : snap.reason === "slot" ? "Waiting for slot." : "Waiting.";
		return `bg ${snap.id} queued${why}\nquietForMs: ${snap.quietForMs ?? 0}\n${wait} jobId waits, wrap:true wraps, cancel:true kills. timeoutMs 0 peeks.`;
	}
	if (snap.status === "running") {
		const lines = [`${snap.cancellationRequested ? "job" : "bg"} ${snap.id} running`, `quietForMs: ${snap.quietForMs ?? 0}`];
		if (snap.cancellationRequested) lines.push("Cancellation requested; waiting for child cleanup. Slot still held.");
		if (snap.resource) lines.push(`resource: ${snap.resource.key} · shared capacity ${snap.resource.capacity} · ${snap.resource.state}`);
		if (snap.resourceError) lines.push(snap.resourceError);
		if (snap.finalization?.phase === "requested") lines.push("finalization requested; enforcement not yet acknowledged");
		else if (snap.finalization?.phase === "draining") lines.push(`finalization enforced; ${snap.finalization.activeTools ?? "unknown"} current tools draining`);
		else if (snap.finalization?.phase === "answering") lines.push("finalization enforced; waiting for the final answer");
		else if (snap.wrapped) lines.push("wrap queued (current tool may finish first)");
		const headroom = snap.finalization?.headroom;
		if (headroom) {
			lines.push(`context policy: ${headroom.phase}${headroom.inputBytes === undefined ? "" : `; ${headroom.inputBytes}/${headroom.inputLimitBytes} payload bytes`}`);
			if (headroom.clippedToolResults) lines.push(`tool results shortened in request: ${headroom.clippedToolResults}; native evidence retained`);
		}
		for (const item of snap.activity.slice(-3)) {
			lines.push(`${item.mark} ${item.name}${item.args ? ` ${item.args}` : ""}`);
		}
		if (snap.current) {
			lines.push(`current: ${snap.current.name}${snap.current.args ? ` ${snap.current.args}` : ""}`);
		}
		lines.push("Slot still held. jobId waits, wrap:true wraps, cancel:true kills. timeoutMs 0 peeks.");
		return lines.join("\n");
	}
	const answer = snap.answer || snap.stderrTail || snap.stopReason || "(no output)";
	return snap.resourceError ? `${snap.resourceError}\n\n${answer}` : answer;
}

function formatOutput(input: {
	text: string;
	failed: boolean;
	stopReason?: string;
	exitCode: number;
	maxBytes: number;
	kind: Kind;
	model?: string;
	details: Record<string, unknown>;
}) {
	const body = [
		delegateTargetLine(input.kind, input.model),
		truncateOutput(input.text || "(no output)", input.maxBytes),
	].join("\n\n");
	return {
		content: [
			{
				type: "text" as const,
				text: input.failed ? `delegate failed (${input.stopReason || input.exitCode}): ${body}` : body,
			},
			...durationContent(input.details.durationMs),
			...capabilityContent(input.details.capabilities),
			...outcomeContent(input.details.outcome),
		],
		details: { ok: !input.failed, ...input.details },
		isError: input.failed,
	};
}

function detailsFromSnap(snap: JobSnapshot, extra: Record<string, unknown> = {}): Record<string, unknown> {
	const details: Record<string, unknown> = {
		kind: snap.kind,
		model: snap.model,
		...(snap.reasoning === undefined ? {} : { reasoning: snap.reasoning }),
		jobId: snap.id,
		status: snap.status,
		activity: [...snap.activity],
		task: snap.task,
		...extra,
	};
	if (snap.archive) { details.runId = snap.archive.runId; details.sessionFile = snap.archive.sessionFile; }
	if (snap.capabilities) details.capabilities = copyCapabilities(snap.capabilities);
	if (snap.outcome) details.outcome = copyOutcome(snap.outcome);
	if (snap.recordingError) details.recordingError = snap.recordingError;
	if (snap.current) details.current = snap.current;
	if (snap.thinking) details.phase = "thinking";
	if (snap.tg) details.tg = snap.tg;
	if (snap.reason) details.reason = snap.reason;
	if (snap.exitCode !== undefined) details.exitCode = snap.exitCode;
	if (snap.stopReason) details.stopReason = snap.stopReason;
	if (snap.stderrTail) details.stderrTail = snap.stderrTail;
	if (snap.answer) details.answer = snap.answer;
	details.terminal = snap.status === "done" || snap.status === "failed";
	if (snap.quietForMs !== undefined) details.quietForMs = snap.quietForMs;
	if (snap.cancellationRequested) details.cancellationRequested = true;
	if (snap.wrapped) details.wrapped = true;
	if (snap.finalization) details.finalization = copyFinalizationProgress(snap.finalization);
	if (snap.resource) details.resource = { ...snap.resource };
	if (snap.resourceError) details.resourceError = snap.resourceError;
	return details;
}

export default function delegate(pi: ExtensionAPI, childRunner: typeof runChild = runChild) {
	if (process.env.PI_DELEGATE_CHILD === "1") return;

	const configPaths = {
		shippedPath: join(EXTENSION_DIR, "config.json"),
		userPath:
			process.env.PI_DELEGATE_SKIP_USER_CONFIG === "1"
				? undefined
				: join(agentDir(), "delegate.json"),
	};
	const config = loadDelegateConfig(configPaths);
	const audits = new SnapshotAudits(pi, config, configPaths, agentDir());
	const modelCommand = new ModelCommand(config, configPaths);
	const accounting = new Accounting(archiveRoot(agentDir()));
	const cards = new JobCards();
	const origins = new Map<string, string>();
	const lastChecks = new Map<string, number>();
	const uiDetails = (snap: JobSnapshot, extra: CardDetails = {}): CardDetails => detailsFromSnap(snap, {
		originToolCallId: snap.archive ? origins.get(snap.archive.runId) : undefined,
		background: snap.background, callType: "spawn", ...extra,
		...((snap.status === "done" || snap.status === "failed") ? { durationMs: accounting.durationMs(snap.archive?.runId) } : {}),
	});
	const updateCard = (snap: JobSnapshot): void => {
		const origin = snap.archive ? origins.get(snap.archive.runId) : undefined;
		if (!origin) return;
		const wasTerminal = isTerminal(cards.get(origin) ?? {});
		const terminal = snap.status === "done" || snap.status === "failed";
		const details = uiDetails(snap, { ok: !snap.failed, displayWarning: cards.get(origin)?.displayWarning,
			answer: terminal ? receiptText(snap) : undefined });
		cards.update(origin, details);
		if (isTerminal(details) && !wasTerminal) {
			try { pi.appendEntry(CARD_STATE_TYPE, details); }
			catch { cards.update(origin, { ...details, displayWarning: "Could not save delegate display state; the child archive is separate." }); }
		}
	};
	const board = new JobBoard(renderJobBoard, () => new Container(), (state) => renderJobBoard(state, 100, 10, plainBoardTheme, false, ""));
	let ui: BoardUi | undefined;
	let mode: string | undefined;
	let hasUI = false;
	let shuttingDown = false;
	let sessionCtx: { isIdle?: () => boolean } | undefined;

	const paintBoard = (): void => {
		if (!ui?.setWidget) return;
		const rows = scheduler.active();
		board.paint(ui, mode, projectJobBoard(rows, { maxLocalConcurrent: config.maxLocalConcurrent }));
	};

	const gate = new NotifyGate({
		isLive: () => !shuttingDown && hasUI && typeof pi.sendMessage === "function",
		isBusy: () => {
			try {
				return sessionCtx?.isIdle?.() === false;
			} catch {
				return false;
			}
		},
		send: (payload) => {
			pi.sendMessage(payload, { deliverAs: "followUp", triggerTurn: true });
		},
	});

	const scheduler = new JobScheduler({
		// All local providers intentionally share one user-scoped slot, independent of archive paths.
		// Lazy acquisition leaves hosted work usable when Linux/flock is unavailable.
		capacity: { tryAcquire: group => new FileCapacityBroker(join(agentDir(), "delegate-capacity")).tryAcquire(group) },
		maxConcurrent: config.maxConcurrent,
		maxLocalConcurrent: config.maxLocalConcurrent,
		maxQueued: config.maxQueued,
		onChange: (snap) => { if (snap) updateCard(snap); paintBoard(); },
		onTerminal: (snap) => gate.schedule(snap),
		onSettled: (snap) => accounting.terminal(snap.archive?.runId, snap.id, {
			status: snap.failed ? "failed" : "done", stopReason: snap.stopReason, exitCode: snap.exitCode,
			finalization: snap.finalization, evidence: snap.outcome?.evidence,
		}),
	});

	// A tool wait can end long before its child does. Observe each parent run instead
	// of tying background cancellation to the spawn/collect call that happened to be active.
	let parentSignal: AbortSignal | undefined;
	const onParentAbort = (): void => {
		audits.cancel();
		// Include completed jobs whose notices are still waiting for the parent to go idle.
		for (const snap of scheduler.list()) gate.consume(snap.id);
		scheduler.cancelAll();
	};
	const detachParentAbort = (): void => {
		parentSignal?.removeEventListener("abort", onParentAbort);
		parentSignal = undefined;
	};
	pi.on("agent_start", (_event, ctx) => {
		detachParentAbort();
		parentSignal = ctx.signal;
		if (parentSignal?.aborted) onParentAbort();
		else parentSignal?.addEventListener("abort", onParentAbort, { once: true });
	});
	pi.on("agent_settled", () => { detachParentAbort(); audits.endTurn(); });
	pi.on("session_compact", () => audits.cancel());

	const bindUi = (ctx: { ui?: BoardUi; mode?: string; hasUI?: boolean; isIdle?: () => boolean }): void => {
		if (ctx.ui && typeof ctx.ui.setWidget === "function") ui = ctx.ui;
		if (ctx.mode) mode = ctx.mode;
		if (typeof ctx.hasUI === "boolean") hasUI = ctx.hasUI;
		if (typeof ctx.isIdle === "function") sessionCtx = ctx;
	};

	if (typeof pi.registerMessageRenderer === "function") {
		pi.registerMessageRenderer<NotifyDetails>(NOTIFY_CUSTOM_TYPE, (message, { expanded }, theme) => {
			const details = message.details;
			if (!details) return undefined;
			return renderNotifyMessage({ theme, details, expanded });
		});
	}

	const readRow = (context: ViewContext): RowState => {
		const args = context.args ?? (context.state.delegateArgs as Record<string, unknown> | undefined) ?? {};
		const saved = context.state.delegateResult as { details?: CardDetails; content?: RowState["content"] } | undefined;
		const jobId = typeof args.jobId === "string" ? args.jobId.trim() || undefined : undefined;
		const collect = saved?.details?.callType === "collect" || (saved?.details?.callType !== "spawn" && jobId !== undefined);
		const snapshot = !collect && !context.isError && saved?.details?.ok !== false ? cards.get(context.toolCallId) : undefined;
		const details: CardDetails = { ...saved?.details, ...snapshot };
		const kind = knownKind(details.kind) ?? knownKind(args.kind);
		details.kind ??= kind;
		details.model ??= args.model ?? (kind ? config.agents[kind].model : undefined);
		details.task ??= args.task;
		details.jobId ??= jobId;
		details.operation ??= args.cancel === true ? "cancel" : args.wrap === true ? "wrap" : args.timeoutMs === 0 ? "peek" : "wait";
		if (!snapshot && !collect && !context.isPartial && (details.status === "queued" || details.status === "running")) details.historical = true;
		return { details, content: snapshot ? undefined : saved?.content, collect, expanded: context.expanded,
			live: Boolean(snapshot && cards.isLive(context.toolCallId)),
			isPartial: snapshot ? !isTerminal(snapshot) : context.isPartial, isError: context.isError };
	};

	let captureContext: ExtensionContext | undefined;
	let captureStatusGeneration = 0;
	let captureStatusController: AbortController | undefined;
	const showCaptureStartup = async (ctx: ExtensionContext): Promise<void> => {
		captureStatusController?.abort();
		const controller = new AbortController();
		captureStatusController = controller;
		const generation = ++captureStatusGeneration;
		try {
			let lines: string[] | undefined;
			if (config.snapshots.defaultEnabled || Object.values(config.snapshots.repositories).some(Boolean)) {
				const repo = await repositoryFor(ctx.cwd, controller.signal);
				if (snapshotNeedsAudit(repo, config.snapshots)) {
					await audits.request(ctx, repo!, controller.signal);
					return;
				}
				if (snapshotEnabled(repo, config.snapshots)) {
					const directory = snapshotDirectory(agentDir(), config.snapshots);
					const stats = await repositorySnapshotStats(repo!, directory, controller.signal);
					lines = [`Eval repository capture enabled · ${stats.count} snapshots · ${formatSnapshotBytes(stats.bytes)}`, `Storage: ${directory}`];
				}
			}
			if (lines && !controller.signal.aborted && !shuttingDown && captureContext === ctx && generation === captureStatusGeneration) {
				ctx.ui.notify(lines.join("\n"), "info");
			}
		} catch (error) {
			// UI is an observer, never a dependency of capture/child execution.
			if (controller.signal.aborted || shuttingDown || captureContext !== ctx || generation !== captureStatusGeneration) return;
			try { ctx.ui.notify(`Snapshot storage: ${error instanceof Error ? error.message : String(error)}`, "error"); } catch { /* detached UI */ }
		}
	};
	let busyUnsubscribe: (() => void) | undefined;
	pi.on("session_start", async (event, ctx) => {
		shuttingDown = false;
		audits.cancel();
		busyUnsubscribe?.();
		const events = pi.events;
		if (events?.on) {
			busyUnsubscribe = events.on("delegate:query-busy", (payload) => {
				respondToBusyQuery(payload, shuttingDown || scheduler.active().length > 0);
			});
		}
		bindUi(ctx);
		cards.restore(ctx.sessionManager.getBranch?.() ?? []);
		await accounting.activate(ctx.sessionManager.getSessionId(), ctx.hasUI ? ctx.ui : undefined);
		captureStatusController?.abort();
		captureContext = ctx;
		if (ctx.hasUI && event.reason !== "reload") void showCaptureStartup(ctx);
	});
	pi.on("session_tree", (_event, ctx) => { audits.cancel(); cards.restore(ctx.sessionManager.getBranch()); });
	const dialogs = new AbortController();
	registerDelegateCommand(pi, [{
		name: "models",
		description: "Choose role models and reasoning levels",
		handler: (args, ctx) => modelCommand.command(args, ctx),
	}, {
		name: "snapshots",
		description: "Configure eval repository capture (off by default)",
		handler: async (args, ctx) => {
			await snapshotCommand(args, ctx, config, configPaths, agentDir(), dialogs.signal, audits);
		},
	}, {
		name: "stats",
		description: "Recorded child usage (no model calls)",
		complete: (prefix) => ["session", "today", "all", "rebuild"].filter(value => value.startsWith(prefix)),
		handler: async (args, ctx) => {
			const scope = args.trim() || "session";
			if (scope !== "session" && scope !== "today" && scope !== "all" && scope !== "rebuild") {
				ctx.ui.notify("Usage: /pi-delegate stats [session|today|all|rebuild]", "warning"); return;
			}
			const report = await accounting.report(scope === "rebuild" ? "all" : scope, ctx.sessionManager.getSessionId(), scope === "rebuild");
			await showStats(ctx, report, {
				scope: scope === "rebuild" ? "all" : scope,
				signal: dialogs.signal,
				load: next => accounting.report(next, ctx.sessionManager.getSessionId()),
			});
		},
	}, {
		name: "jobs",
		description: "Browse active and queued delegates",
		handler: async (args, ctx) => {
			if (args.trim()) { ctx.ui.notify("Usage: /pi-delegate jobs", "warning"); return; }
			await showJobs(ctx, () => projectJobBoard(scheduler.active(), { maxLocalConcurrent: config.maxLocalConcurrent }), dialogs.signal);
		},
	}], dialogs.signal);
	// Pi ignores isError on execute() return values. Keep our structured details
	// and mark failed results through the supported result-event hook instead.
	pi.on("tool_result", (event) => {
		if (event.toolName === "delegate" && (event.details as { ok?: boolean } | undefined)?.ok === false) {
			return { isError: true };
		}
	});
	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		audits.cancel();
		dialogs.abort();
		busyUnsubscribe?.();
		busyUnsubscribe = undefined;
		detachParentAbort();
		modelCommand.stop();
		captureContext = undefined;
		captureStatusController?.abort();
		captureStatusController = undefined;
		++captureStatusGeneration;
		gate.shutdown();
		await scheduler.shutdown();
		accounting.close();
		board.close(ui);
		ui = undefined;
		mode = undefined;
		hasUI = false;
		sessionCtx = undefined;
		cards.clear();
		origins.clear();
		lastChecks.clear();
	});

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		renderShell: "self",
		description:
			"Child agent. recon/implement/review/oracle. Model from config. background returns jobId. jobId waits/peeks/wraps/cancels. timeoutMs is wait budget, never kills. Interactive mode may inject a completion notice. Local models share maxLocalConcurrent. No nesting.",
		promptSnippet: "Route isolated work to a named delegate agent. Model comes from config or the model argument.",
		promptGuidelines: [
			"Before each substantial task, assess delegate; use it for isolated child work only when expected speed or quality gain exceeds coordination and validation cost.",
			"Use delegate as the only parent-child tool. One child per call. No nesting.",
			"With delegate, the parent owns decomposition, architecture and security judgment, ambiguity resolution, main implementation, destructive or external actions, integration, final validation and the final answer.",
			"Use delegate kind recon for read-only repo mapping, file lookup, failure reproduction notes and narrow review evidence; never edits or broad judgment. Do not send recon images or long inherited context.",
			"Use delegate kind implement only for bounded edits and tests. Give parallel children disjoint files and scopes; avoid parent/child write races.",
			"Use delegate kind review only if implementation failed or independent judgment is required; review and oracle remain read-only.",
			"Use delegate kind oracle only as a last resort, without parallel delegates.",
			"For delegate, omit model to use the configured role default unless the user explicitly requests another model. Do not guess model IDs or silently substitute a fallback. Overrides keep the kind's tools, prompt, thinking level and offline setting.",
			"Give every delegate a self-contained task with the goal, exact cwd/targets, relevant context, evidence or checks required, acceptance criteria and stop rules. Children must not commit, push, merge, publish, release or expand scope.",
			"Inspect every delegate result and diff, rerun relevant checks and validate the integrated result. Child reports and completion receipts are evidence, not proof of correctness.",
			"For 'review loop <model>', call delegate with kind review and the requested model; address findings and review again until none important remain. If blocked, report it rather than substituting a model or claiming a clean review.",
			"delegate background:true returns jobId immediately; the child keeps running.",
			"delegate timeoutMs is a wait budget, never a kill. Foreground expiry auto-backgrounds and returns a short check-in.",
			"With delegate jobId, omit timeoutMs to wait until done or 60s quiet; timeoutMs:0 peeks.",
			"On a nonterminal delegate check-in, inspect current/recent tools and quietForMs. Wait while useful progress continues; silence or wait expiry alone does not prove a stall.",
			"For a suspected delegate stall, request wrap:true once, then wait again in a separate call; allow the current turn/tools and final report time to finish.",
			"Before delegate cancel:true for a suspected stall, fetch and inspect a fresh jobId/timeoutMs:0 snapshot in a separate call. Cancel only if post-wrap checks still show a stall; explicit user stop or unsafe/out-of-scope work may cancel immediately.",
			"delegate wrap:true is advisory steering, not an interrupt or delivery acknowledgement. cancel:true aborts and kills.",
			"Collect full delegate results with jobId even after an interactive completion notice; print/JSON stays pull-only.",
			"Use recorded delegate durationMs and Duration as authoritative elapsed timing; recover missing timing from archived metadata.json. Use Unknown only when timing cannot be recovered.",
			"Local delegate jobs may queue under maxLocalConcurrent; hosted jobs can run independently. Running children retain their slots until they stop.",
			"Only for a user-approved pending snapshot safety audit, submit auditId and auditResult without child/job arguments. Audit results never launch a child; passed requires substantive checks and no demonstrated secrets or hard capture blockers. Coverage gaps and non-blocking risks belong in warnings and do not prevent enabling. Never include secret values.",
		],
		parameters: Type.Object({
			task: optionalArgument(Type.String({ description: "Task for the child. Required to spawn. Max 20000 chars." })),
			kind: optionalArgument(Type.String({ description: "recon, implement, review, or oracle. Required to spawn." })),
			cwd: optionalArgument(
				Type.String({ description: "Child working directory. Relative paths resolve against parent cwd." }),
			),
			timeoutMs: optionalArgument(
				Type.Integer({
					description:
						"Wait budget, never a kill. Spawn/fg: first wait. jobId: max wait (omit = until done or quiet). 0 with jobId = peek.",
				}),
			),
			model: optionalArgument(
				Type.String({
					description: "Override child model. Any Pi model id (provider/id).",
				}),
			),
			background: optionalArgument(
				Type.Boolean({ description: "Return jobId now; child runs in the background." }),
			),
			jobId: optionalArgument(Type.String({ description: "Wait, peek, wrap, or cancel an existing job." })),
			wrap: optionalArgument(
				Type.Boolean({ description: "With jobId: steer child to wrap up. Does not interrupt the current tool." }),
			),
			cancel: optionalArgument(Type.Boolean({ description: "With jobId: abort and kill the child." })),
			auditId: optionalArgument(Type.String({ description: "ID of the user-approved pending snapshot safety audit. Only with auditResult; no child/job arguments." })),
			auditResult: optionalArgument(Type.Object({
				verdict: Type.Union([Type.Literal("passed"), Type.Literal("blocked"), Type.Literal("incomplete")]),
				checked: Type.Array(Type.Union(AUDIT_CHECKS.map(check => Type.Literal(check))), { maxItems: AUDIT_CHECKS.length, uniqueItems: true }),
				issues: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 32, description: "Demonstrated secrets or hard capture blockers: redacted paths/categories only, never secret values. Must be empty for passed." }),
				warnings: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 32, description: "Non-blocking privacy/storage risks, unverified secret-like literals and coverage gaps; redacted paths/categories only. Do not prevent passed." })),
			}, { additionalProperties: false, description: "Best-effort safety audit, not a child task. passed means no secret leak was demonstrated after substantive checks; partial coverage and warnings are allowed." })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			let capabilities: CapabilityManifest | undefined;
			const update = (result: Parameters<NonNullable<typeof onUpdate>>[0]): void => {
				try { onUpdate?.(result); }
				catch { /* Progress observers must never change job acceptance or outcomes. */ }
			};
			try {
				assertNotNested(process.env, "delegate");
				bindUi(ctx);
				const auditCall = parseAuditCall(params);
				if (auditCall) {
					const message = await audits.submit(ctx, auditCall.auditId, auditCall.auditResult, signal);
					return { content: [{ type: "text" as const, text: message }], details: { ok: true, snapshotAudit: true, auditVerdict: auditCall.auditResult.verdict } };
				}
				const parsed = parseDelegateCall(params, config);
				if (parsed.mode === "spawn" && audits.active) throw new Error("A snapshot safety audit is pending; finish it before launching delegates.");
				const operation = parsed.mode === "collect"
					? parsed.cancel ? "cancel" : parsed.wrap ? "wrap" : parsed.peek ? "peek" : "wait"
					: "wait";

				const publish = (snap: JobSnapshot, background: boolean, pending: boolean): void => {
					updateCard(snap);
					update({
						content: [{ type: "text" as const, text: delegateTargetLine(snap.kind, snap.model) }, ...capabilityContent(snap.capabilities)],
						details: {
							...uiDetails(snap, { pending, background, callType: parsed.mode, operation }),
						},
					});
				};

				let snap: JobSnapshot;
				if (parsed.mode === "collect") {
					const current = scheduler.get(parsed.jobId);
					capabilities = copyCapabilities(current.capabilities);
					publish(current, true, current.status === "queued" || current.status === "running");
					if (parsed.cancel) scheduler.cancel(parsed.jobId);
					else if (parsed.wrap) scheduler.wrap(parsed.jobId);
					const peek = parsed.peek === true;
					snap = await scheduler.wait(parsed.jobId, {
						timeoutMs: peek ? 0 : parsed.waitMs,
						quietMs: peek || parsed.cancel ? undefined : config.checkIntervalMs,
						signal: peek ? undefined : signal,
						onSnapshot: (next) => publish(next, true, next.status === "queued" || next.status === "running"),
					});
				} else {
					const kind = parsed.kind;
					const cwd = resolveChildCwd(parsed.cwd, ctx.cwd, "delegate");
					const resolved = resolveAgent(kind, parsed.modelOverride, config);
					const tools = [...resolved.agent.tools];
					capabilities = describeCapabilities(tools);
					const local = isLocalModel(resolved.model);
					update({
						content: [{ type: "text" as const, text: delegateTargetLine(kind, resolved.model) }, ...capabilityContent(capabilities)],
						details: { kind, model: resolved.model, reasoning: resolved.agent.thinking, task: parsed.task, pending: true, background: parsed.background, capabilities: copyCapabilities(capabilities) },
					});

					const promptPath = promptSourceFromDir(EXTENSION_DIR, `${kind}.md`);
					let savingsInfo: ReturnType<typeof loadSavingsSnapshot> = {};
					if (local) {
						const alternative = config.localAlternatives[resolved.model];
						try {
							const slash = alternative?.model.indexOf("/") ?? -1;
							const pricedModel = alternative && ctx.modelRegistry.find(alternative.model.slice(0, slash), alternative.model.slice(slash + 1));
							savingsInfo = alternative && !isLocalModel(alternative.model) ? loadSavingsSnapshot({
								key: { localModel: resolved.model, alternativeModel: alternative.model, kind, localThinking: resolved.agent.thinking,
									alternativeThinking: alternative.thinking, tools, promptHash: fingerprint(readFileSync(promptPath, "utf8")) },
								files: config.calibrationProfiles, pricing: pricedModel?.cost,
							}) : { reason: "No hosted alternative configured for this local model" };
						} catch { savingsInfo = { reason: "Alternative pricing/calibration unavailable" }; }
					}
					// Freeze capture policy on acceptance; queued jobs capture their eventual start state.
					const captureConfig = snapshotSettings(config.snapshots);
					const captureDirectory = snapshotDirectory(agentDir(), captureConfig);
					const archive = accounting.create({
						parentSessionId: ctx.sessionManager.getSessionId(), parentSessionFile: ctx.sessionManager.getSessionFile(),
						toolCallId, kind, cwd, requestedModel: resolved.model, thinking: resolved.agent.thinking, tools, capabilities,
						savings: savingsInfo.snapshot, savingsUnavailable: savingsInfo.reason,
					}, parsed.task, promptPath);
					origins.set(archive.data.runId, toolCallId);
					cards.begin(toolCallId, { kind, model: resolved.model, reasoning: resolved.agent.thinking, task: parsed.task, status: "queued", capabilities: copyCapabilities(capabilities) });
					try {
						snap = scheduler.enqueue({
							archive: { runId: archive.data.runId, sessionFile: archive.paths.session }, capabilities,
							kind, model: resolved.model, reasoning: resolved.agent.thinking, local, task: parsed.task, timeoutMs: parsed.timeoutMs,
							...(local ? { resourceGroup: { key: "local-delegate", capacity: 1 } } : {}),
							background: parsed.background, cancelOnAbort: parsed.background ? undefined : signal,
							run: (handle, childSignal, onEvent, onControl) => accounting.run(archive, handle.id, async (onUsage) => {
								let capturedRepository: Repository | undefined;
								if (audits.active) throw new Error("A snapshot safety audit is pending; queued delegate launch refused.");
								if (captureConfig.defaultEnabled || Object.values(captureConfig.repositories).some(Boolean)) {
									childSignal.throwIfAborted();
									const repo = await repositoryFor(cwd, childSignal);
									if (snapshotNeedsAudit(repo, captureConfig)) throw new Error("Snapshot capture requires a user-approved safety audit for this repository. Open /pi-delegate snapshots before launching a delegate.");
									if (snapshotEnabled(repo, captureConfig)) {
										if (audits.active || !snapshotEnabled(repo, config.snapshots)) throw new Error("Snapshot capture permission was revoked; retry after the safety audit or settings change.");
										const snapshot = await captureRepository(repo!, captureDirectory, archive.data.runId, childSignal);
										archive.attachSnapshot(snapshot);
										capturedRepository = repo;
									}
								}
								childSignal.throwIfAborted();
								if (audits.active) throw new Error("A snapshot safety audit is pending; delegate launch refused.");
								if (capturedRepository && !snapshotEnabled(capturedRepository, config.snapshots)) throw new Error("Snapshot capture permission was revoked; delegate launch refused.");
								return childRunner({
								task: parsed.task, cwd, model: resolved.model, thinking: resolved.agent.thinking,
								tools: [...tools], offline: resolved.agent.offline,
								...(local ? { resourceLease: handle.resourceLease, leaseStartupMs: 15000 } : {}),
								hardTimeoutMs: config.hardTimeoutMs, maxOutputBytes: config.maxOutputBytes,
								promptSourcePath: archive.paths.prompt, sessionFile: archive.paths.session,
								signal: childSignal, env: process.env,
								onEvent: (event) => { onUsage(event); onEvent(event); }, onControl,
								});
							}, childSignal),
						});
					} catch (error) {
						accounting.terminal(archive.data.runId, "refused", { status: "failed", stopReason: "error", exitCode: 1 });
						throw error;
					}
					publish(snap, parsed.background, snap.status === "queued" || snap.status === "running");
					if (!parsed.background) {
						snap = await scheduler.wait(snap.id, {
							timeoutMs: parsed.timeoutMs,
							signal,
							onSnapshot: (next) => publish(next, false, next.status === "queued" || next.status === "running"),
						});
						if (!signal?.aborted && (snap.status === "queued" || snap.status === "running")) {
							snap = scheduler.promoteBackground(snap.id);
						}
					}
				}

				const collect = parsed.mode === "collect";
				const pending = snap.status === "queued" || snap.status === "running";
				// Freeze timing when a check returns, never when its history row repaints.
				const checkTiming: CardDetails = {};
				if (collect && pending && !parsed.wrap && !parsed.cancel) {
					const checkedAt = Date.now();
					const previous = lastChecks.get(snap.id);
					checkTiming.checkedAt = checkedAt;
					checkTiming.elapsedMs = Math.max(0, checkedAt - (snap.startedAt ?? snap.queuedAt ?? checkedAt));
					if (previous !== undefined) checkTiming.sincePreviousCheckMs = Math.max(0, checkedAt - previous);
					lastChecks.set(snap.id, checkedAt);
				}
				const failed = !pending && snap.failed;
				const exitCode = snap.exitCode ?? (failed ? 1 : 0);
				// Preserve foreground answer capping and the richer empty-answer fallback on collection.
				const text = collect || pending ? receiptText(snap)
					: truncateOutput(snap.answer || snap.stderrTail || "(no output)", config.maxOutputBytes);
				updateCard(snap);
				if (collect && shouldConsume(snap)) gate.consume(snap.id);
				return formatOutput({
					text,
					failed,
					stopReason: snap.stopReason,
					exitCode,
					maxBytes: config.maxOutputBytes,
					kind: snap.kind,
					model: snap.model,
					details: uiDetails(snap, collect ? {
						callType: "collect", operation, background: true, pending, ...checkTiming,
						answer: pending ? snap.answer : text,
					} : pending ? { background: snap.background, pending: true } : { exitCode, answer: text }),
				});
			} catch (error) {
				cards.forget(toolCallId);
				const message = error instanceof Error ? error.message : String(error);
				return errorResult(message, capabilities);
			}
		},
		renderCall(args, theme, context) {
			context.state.delegateArgs = args;
			if (args.auditId) return new Text(theme.fg("toolTitle", "delegate · snapshot safety audit"), 0, 0);
			cards.watch(context.toolCallId, context.invalidate);
			return renderChildCall({ theme, read: () => readRow(context) });
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			context.state.delegateResult = result;
			const auditDetails = result.details as { snapshotAudit?: boolean; auditVerdict?: string; ok?: boolean } | undefined;
			const auditArgs = context.state.delegateArgs as { auditId?: string } | undefined;
			if (auditDetails?.snapshotAudit || auditArgs?.auditId) {
				const color = auditDetails?.ok === false ? "error" : auditDetails?.auditVerdict === "passed" ? "muted" : "warning";
				return new Text(theme.fg(color, result.content.filter(item => item.type === "text").map(item => (item as { text: string }).text).join("\n")), 0, 0);
			}
			return renderChildResult({ theme, read: () => readRow({ ...context, expanded, isPartial }),
				expandHint: keyHint("app.tools.expand", "full result and tool details") });
		},
	});
}
