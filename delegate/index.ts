import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { fingerprint, loadSavingsSnapshot } from "./calibration.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, keyHint, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Container } from "@earendil-works/pi-tui";
import { assertNotNested, resolveChildCwd, truncateOutput } from "../child-runtime/policy.ts";
import { promptSourceFromDir } from "../child-runtime/spawn.ts";
import { copyFinalizationProgress } from "../child-runtime/guard-protocol.ts";
import { loadDelegateConfig, resolveAgent, type Kind } from "./config.ts";
import {
	delegateTargetLine,
	knownKind,
} from "./display.ts";
import { JobScheduler, parseDelegateCall, type JobSnapshot } from "./jobs.ts";
import { NOTIFY_CUSTOM_TYPE, NotifyGate, shouldConsume, type NotifyDetails } from "./notify.ts";
import { runChild } from "./spawn.ts";
import { Accounting } from "./accounting.ts";
import { archiveRoot } from "./archive.ts";
import { isLocalModel } from "./tg.ts";
import { renderChildCall, renderChildResult, renderJobBoard, renderNotifyMessage, type RowState } from "./view.ts";
import { CARD_STATE_TYPE, JobCards, isTerminal, type CardDetails } from "./cards.ts";
import { JobBoard, plainBoardTheme, type BoardUi } from "./board.ts";
import { projectJobBoard } from "./panel.ts";
import { LocalControl } from "./local-control.ts";
import { LocalCommand } from "./local-command.ts";
import { ModelCommand } from "./model-command.ts";
import { capabilityContent, copyCapabilities, describeCapabilities, type CapabilityManifest } from "./capabilities.ts";
import { copyOutcome, outcomeContent } from "./outcomes.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

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
		const wait = snap.reason === "local-off" ? "Local delegation is OFF; waiting for /delegate-local on."
			: snap.reason === "local-unavailable" ? "Local delegation control unavailable; dispatch paused."
			: snap.reason === "resource" ? `Waiting for shared resource${snap.resource ? ` ${snap.resource.key}` : ""}.`
			: snap.reason === "gpu" ? "Waiting for gpu." : snap.reason === "slot" ? "Waiting for slot." : "Waiting.";
		return `bg ${snap.id} queued${why}\nquietForMs: ${snap.quietForMs ?? 0}\n${wait} jobId waits, wrap:true wraps, cancel:true kills. timeoutMs 0 peeks.`;
	}
	if (snap.status === "running") {
		const lines = [`bg ${snap.id} running`, `quietForMs: ${snap.quietForMs ?? 0}`];
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
	const modelCommand = new ModelCommand(config, configPaths);
	const accounting = new Accounting(archiveRoot(agentDir()));
	const localControl = new LocalControl(join(agentDir(), "delegate-local"));
	const cards = new JobCards();
	const origins = new Map<string, string>();
	const uiDetails = (snap: JobSnapshot, extra: CardDetails = {}): CardDetails => detailsFromSnap(snap, {
		originToolCallId: snap.archive ? origins.get(snap.archive.runId) : undefined,
		background: snap.background, callType: "spawn", ...extra,
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
		localAdmission: localControl,
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

	const localCommand = new LocalCommand(localControl, () => scheduler.refreshLocalState());

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
		const collect = typeof args.jobId === "string" || saved?.details?.callType === "collect";
		const snapshot = !collect && !context.isError && saved?.details?.ok !== false ? cards.get(context.toolCallId) : undefined;
		const details: CardDetails = { ...saved?.details, ...snapshot };
		const kind = knownKind(details.kind) ?? knownKind(args.kind);
		details.kind ??= kind;
		details.model ??= args.model ?? (kind ? config.agents[kind].model : undefined);
		details.task ??= args.task;
		details.jobId ??= args.jobId;
		details.operation ??= args.cancel ? "cancel" : args.wrap ? "wrap" : args.timeoutMs === 0 ? "peek" : "wait";
		if (!snapshot && !collect && !context.isPartial && (details.status === "queued" || details.status === "running")) details.historical = true;
		return { details, content: snapshot ? undefined : saved?.content, collect, expanded: context.expanded,
			live: Boolean(snapshot && cards.isLive(context.toolCallId)),
			isPartial: snapshot ? !isTerminal(snapshot) : context.isPartial, isError: context.isError };
	};

	pi.on("session_start", async (_event, ctx) => {
		shuttingDown = false;
		bindUi(ctx);
		localCommand.start(ctx);
		cards.restore(ctx.sessionManager.getBranch?.() ?? []);
		await accounting.activate(ctx.sessionManager.getSessionId(), ctx.hasUI ? ctx.ui : undefined);
	});
	pi.on("session_tree", (_event, ctx) => cards.restore(ctx.sessionManager.getBranch()));
	pi.registerCommand("delegate", {
		description: "Show each delegate role's model and choose from available Pi models. Saves defaults for new children.",
		handler: (args, ctx) => modelCommand.command(args, ctx),
	});
	pi.registerCommand("delegate-local", {
		description: "Show the shared local-delegation on/off picker, or set on|off|status. Existing jobs drain; hosted work is unchanged.",
		getArgumentCompletions: (prefix) => ["on", "off", "status"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: (args, ctx) => localCommand.command(args, ctx),
	});
	pi.registerCommand("delegate-stats", {
		description: "Recorded child usage: session (default), today, all, or rebuild the export ledger. No model calls.",
		getArgumentCompletions: (prefix) => ["session", "today", "all", "rebuild"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const scope = args.trim() || "session";
			if (scope !== "session" && scope !== "today" && scope !== "all" && scope !== "rebuild") {
				ctx.ui.notify("Usage: /delegate-stats [session|today|all|rebuild]", "warning"); return;
			}
			const report = await accounting.report(scope === "rebuild" ? "all" : scope, ctx.sessionManager.getSessionId(), scope === "rebuild");
			ctx.ui.notify(report, "info");
		},
	});
	// Pi ignores isError on execute() return values. Keep our structured details
	// and mark failed results through the supported result-event hook instead.
	pi.on("tool_result", (event) => {
		if (event.toolName === "delegate" && (event.details as { ok?: boolean } | undefined)?.ok === false) {
			return { isError: true };
		}
	});
	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		modelCommand.stop();
		localCommand.stop();
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
			"Local delegate jobs may queue under maxLocalConcurrent; hosted jobs can run independently. Running children retain their slots until they stop.",
		],
		parameters: Type.Object({
			task: Type.Optional(Type.String({ description: "Task for the child. Required to spawn. Max 20000 chars." })),
			kind: Type.Optional(Type.String({ description: "recon, implement, review, or oracle. Required to spawn." })),
			cwd: Type.Optional(
				Type.String({ description: "Child working directory. Relative paths resolve against parent cwd." }),
			),
			timeoutMs: Type.Optional(
				Type.Integer({
					description:
						"Wait budget, never a kill. Spawn/fg: first wait. jobId: max wait (omit = until done or quiet). 0 with jobId = peek.",
				}),
			),
			model: Type.Optional(
				Type.String({
					description: "Override child model. Any Pi model id (provider/id).",
				}),
			),
			background: Type.Optional(
				Type.Boolean({ description: "Return jobId now; child runs in the background." }),
			),
			jobId: Type.Optional(Type.String({ description: "Wait, peek, wrap, or cancel an existing job." })),
			wrap: Type.Optional(
				Type.Boolean({ description: "With jobId: steer child to wrap up. Does not interrupt the current tool." }),
			),
			cancel: Type.Optional(Type.Boolean({ description: "With jobId: abort and kill the child." })),
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
				const parsed = parseDelegateCall(params, config);
				const operation = params.cancel ? "cancel" : params.wrap ? "wrap" : params.timeoutMs === 0 ? "peek" : "wait";

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
					if (local) localControl.assertEnabled();
					update({
						content: [{ type: "text" as const, text: delegateTargetLine(kind, resolved.model) }, ...capabilityContent(capabilities)],
						details: { kind, model: resolved.model, task: parsed.task, pending: true, background: parsed.background, capabilities: copyCapabilities(capabilities) },
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
					const archive = accounting.create({
						parentSessionId: ctx.sessionManager.getSessionId(), parentSessionFile: ctx.sessionManager.getSessionFile(),
						toolCallId, kind, cwd, requestedModel: resolved.model, thinking: resolved.agent.thinking, tools, capabilities,
						savings: savingsInfo.snapshot, savingsUnavailable: savingsInfo.reason,
					}, parsed.task, promptPath);
					origins.set(archive.data.runId, toolCallId);
					cards.begin(toolCallId, { kind, model: resolved.model, task: parsed.task, status: "queued", capabilities: copyCapabilities(capabilities) });
					try {
						snap = scheduler.enqueue({
							archive: { runId: archive.data.runId, sessionFile: archive.paths.session }, capabilities,
							kind, model: resolved.model, local, task: parsed.task, timeoutMs: parsed.timeoutMs,
							background: parsed.background, cancelOnAbort: parsed.background ? undefined : signal,
							run: (handle, childSignal, onEvent, onControl) => accounting.run(archive, handle.id, (onUsage) => childRunner({
								task: parsed.task, cwd, model: resolved.model, thinking: resolved.agent.thinking,
								tools: [...tools], offline: resolved.agent.offline,
								hardTimeoutMs: config.hardTimeoutMs, maxOutputBytes: config.maxOutputBytes,
								promptSourcePath: archive.paths.prompt, sessionFile: archive.paths.session,
								signal: childSignal, env: process.env,
								onEvent: (event) => { onUsage(event); onEvent(event); }, onControl,
							})),
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
						if (snap.status === "queued" || snap.status === "running") {
							snap = scheduler.promoteBackground(snap.id);
						}
					}
				}

				const collect = parsed.mode === "collect";
				const pending = snap.status === "queued" || snap.status === "running";
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
						callType: "collect", operation, background: true, pending,
						answer: pending ? snap.answer : text,
					} : pending ? { background: true, pending: true } : { exitCode, answer: text }),
				});
			} catch (error) {
				cards.forget(toolCallId);
				const message = error instanceof Error ? error.message : String(error);
				return errorResult(message, capabilities);
			}
		},
		renderCall(args, theme, context) {
			context.state.delegateArgs = args;
			cards.watch(context.toolCallId, context.invalidate);
			return renderChildCall({ theme, read: () => readRow(context) });
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			context.state.delegateResult = result;
			return renderChildResult({ theme, read: () => readRow({ ...context, expanded, isPartial }),
				expandHint: keyHint("app.tools.expand", "full result and tool details") });
		},
	});
}
