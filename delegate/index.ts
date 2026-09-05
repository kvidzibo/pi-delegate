import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { assertNotNested, resolveChildCwd, truncateOutput } from "../child-runtime/policy.ts";
import { promptSourceFromDir } from "../child-runtime/spawn.ts";
import { loadDelegateConfig, resolveAgent, type Kind } from "./config.ts";
import {
	delegateTargetLine,
	formatJobBoard,
	knownKind,
	type JobBoardRow,
} from "./display.ts";
import { JobScheduler, parseDelegateCall, type JobSnapshot } from "./jobs.ts";
import { NOTIFY_CUSTOM_TYPE, NotifyGate, shouldConsume, type NotifyDetails } from "./notify.ts";
import { runChild } from "./spawn.ts";
import { isLocalModel } from "./tg.ts";
import { renderChildCall, renderChildResult, renderNotifyMessage } from "./view.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

function agentDir(): string {
	return typeof getAgentDir === "function" ? getAgentDir() : join(homedir(), ".pi", "agent");
}

function errorResult(message: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: { ok: false },
		isError: true,
	};
}

type LiveTarget = {
	kind: Kind;
	model: string;
	thinking?: string;
	tg?: string;
	jobId?: string;
	status?: string;
	background?: boolean;
};

function snapshotBoard(snap: JobSnapshot): JobBoardRow | undefined {
	if (snap.status !== "queued" && snap.status !== "running") return undefined;
	const row: JobBoardRow = {
		id: snap.id,
		kind: snap.kind,
		model: snap.model,
		local: snap.local,
		status: snap.status,
	};
	if (snap.reason) row.reason = snap.reason;
	if (snap.tg) row.tg = snap.tg;
	if (snap.current) row.current = snap.current;
	return row;
}

function receiptText(snap: JobSnapshot): string {
	if (snap.status === "queued") {
		const why = snap.reason === "gpu" ? " gpu" : snap.reason === "slot" ? " slot" : "";
		const wait = snap.reason === "gpu" ? "Waiting for gpu." : snap.reason === "slot" ? "Waiting for slot." : "Waiting.";
		return `bg ${snap.id} queued${why}\nquietForMs: ${snap.quietForMs ?? 0}\n${wait} jobId waits, wrap:true wraps, cancel:true kills. timeoutMs 0 peeks.`;
	}
	if (snap.status === "running") {
		const lines = [`bg ${snap.id} running`, `quietForMs: ${snap.quietForMs ?? 0}`];
		if (snap.wrapped) lines.push("wrap queued (current tool may finish first)");
		for (const item of snap.activity.slice(-3)) {
			lines.push(`${item.mark} ${item.name}${item.args ? ` ${item.args}` : ""}`);
		}
		if (snap.current) {
			lines.push(`current: ${snap.current.name}${snap.current.args ? ` ${snap.current.args}` : ""}`);
		}
		lines.push("Slot still held. jobId waits, wrap:true wraps, cancel:true kills. timeoutMs 0 peeks.");
		return lines.join("\n");
	}
	return snap.answer || snap.stderrTail || snap.stopReason || "(no output)";
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
	if (snap.current) details.current = snap.current;
	if (snap.thinking) details.thinking = snap.thinking;
	if (snap.tg) details.tg = snap.tg;
	if (snap.reason) details.reason = snap.reason;
	if (snap.exitCode !== undefined) details.exitCode = snap.exitCode;
	if (snap.stopReason) details.stopReason = snap.stopReason;
	if (snap.stderrTail) details.stderrTail = snap.stderrTail;
	if (snap.answer) details.answer = snap.answer;
	details.terminal = snap.status === "done" || snap.status === "failed";
	if (snap.quietForMs !== undefined) details.quietForMs = snap.quietForMs;
	if (snap.wrapped) details.wrapped = true;
	return details;
}

export default function delegate(pi: ExtensionAPI) {
	if (process.env.PI_DELEGATE_CHILD === "1") return;

	const config = loadDelegateConfig({
		shippedPath: join(EXTENSION_DIR, "config.json"),
		userPath:
			process.env.PI_DELEGATE_SKIP_USER_CONFIG === "1"
				? undefined
				: join(agentDir(), "delegate.json"),
	});
	const liveTargets = new Map<string, LiveTarget>();
	type WidgetUi = { setWidget: (id: string, lines: string[] | undefined) => void };
	let ui: WidgetUi | undefined;
	let hasUI = false;
	let shuttingDown = false;
	let sessionCtx: { isIdle?: () => boolean } | undefined;

	const paintBoard = (): void => {
		if (!ui?.setWidget) return;
		const rows = scheduler
			.active()
			.map(snapshotBoard)
			.filter((row): row is JobBoardRow => Boolean(row));
		if (rows.length === 0) {
			ui.setWidget("delegate", undefined);
			return;
		}
		ui.setWidget("delegate", formatJobBoard(rows, { maxLocalConcurrent: config.maxLocalConcurrent }));
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
		maxConcurrent: config.maxConcurrent,
		maxLocalConcurrent: config.maxLocalConcurrent,
		maxQueued: config.maxQueued,
		onChange: paintBoard,
		onTerminal: (snap) => gate.schedule(snap),
	});

	const bindUi = (ctx: { ui?: WidgetUi; hasUI?: boolean; isIdle?: () => boolean }): void => {
		if (ctx.ui && typeof ctx.ui.setWidget === "function") ui = ctx.ui;
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

	const liveFromSnap = (toolCallId: string, snap: JobSnapshot, background: boolean): LiveTarget => {
		const live: LiveTarget = { kind: snap.kind, model: snap.model };
		if (snap.thinking) live.thinking = snap.thinking;
		if (snap.tg && isLocalModel(snap.model)) live.tg = snap.tg;
		if (background) {
			live.background = true;
			live.jobId = snap.id;
			live.status = snap.status;
		} else if (snap.status === "queued") {
			live.status = snap.status;
		}
		liveTargets.set(toolCallId, live);
		return live;
	};

	pi.on("session_start", (_event, ctx) => {
		shuttingDown = false;
		bindUi(ctx);
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
		gate.shutdown();
		await scheduler.shutdown();
		ui?.setWidget("delegate", undefined);
		ui = undefined;
		hasUI = false;
		sessionCtx = undefined;
		liveTargets.clear();
	});

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description:
			"Child agent. recon/implement/review/oracle. Model from config. background returns jobId. jobId waits/peeks/wraps/cancels. timeoutMs is wait budget, never kills. Interactive mode may inject a completion notice. Local models share maxLocalConcurrent. No nesting.",
		promptSnippet: "Route isolated work to a named delegate agent. Model comes from config or the model argument.",
		promptGuidelines: [
			"Use delegate for isolated child work. One child per call. No nesting.",
			"Use kind recon for lookups and file maps. Not for edits.",
			"Use kind implement for bounded edits and tests.",
			"Use kind review only if implement already failed or judgment is required.",
			"Use kind oracle last resort. Never parallel oracle.",
			"Optional model override: any Pi model id (provider/id). Kind keeps tools and prompt.",
			"background: true returns jobId immediately; child keeps running.",
			"timeoutMs is a wait budget. It does not kill the child. Foreground expiry auto-backgrounds and returns a short check-in.",
			"jobId waits. Omit timeoutMs to wait until done or 60s quiet. timeoutMs 0 peeks.",
			"On a nonterminal check-in: if progress is useful, call jobId again. If no value, wrap:true. If still stuck, cancel:true.",
			"wrap steers the child to finish; current tool may complete first. cancel kills.",
			"Interactive mode may inject a short completion notice; collect with jobId for the full result. Print/JSON stays pull-only.",
			"Many local/GPU children queue (maxLocalConcurrent). Hosted still parallel. A running child keeps its slot.",
			"Background implement can race parent file writes.",
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
			try {
				assertNotNested(process.env, "delegate");
				bindUi(ctx);
				const parsed = parseDelegateCall(params, config);

				const publish = (snap: JobSnapshot, background: boolean, pending: boolean): void => {
					liveFromSnap(toolCallId, snap, background);
					onUpdate?.({
						content: [{ type: "text" as const, text: delegateTargetLine(snap.kind, snap.model) }],
						details: {
							...detailsFromSnap(snap, { pending, background }),
						},
					});
				};

				if (parsed.mode === "collect") {
					const current = scheduler.get(parsed.jobId);
					publish(current, true, current.status === "queued" || current.status === "running");
					if (parsed.cancel) scheduler.cancel(parsed.jobId);
					else if (parsed.wrap) scheduler.wrap(parsed.jobId);
					const peek = parsed.peek === true;
					const snap = await scheduler.wait(parsed.jobId, {
						timeoutMs: peek ? 0 : parsed.waitMs,
						quietMs: peek || parsed.cancel ? undefined : config.checkIntervalMs,
						signal: peek ? undefined : signal,
						onSnapshot: (next) => publish(next, true, next.status === "queued" || next.status === "running"),
					});
					const pending = snap.status === "queued" || snap.status === "running";
					const failed = !pending && snap.failed;
					const text = receiptText(snap);
					liveFromSnap(toolCallId, snap, true);
					if (shouldConsume(snap)) gate.consume(snap.id);
					return formatOutput({
						text,
						failed,
						stopReason: snap.stopReason,
						exitCode: snap.exitCode ?? (failed ? 1 : 0),
						maxBytes: config.maxOutputBytes,
						kind: snap.kind,
						model: snap.model,
						details: detailsFromSnap(snap, {
							background: true,
							pending,
							answer: snap.status === "done" || snap.status === "failed" ? text : snap.answer,
						}),
					});
				}

				const kind = parsed.kind;
				const cwd = resolveChildCwd(parsed.cwd, ctx.cwd, "delegate");
				const resolved = resolveAgent(kind, parsed.modelOverride, config);
				const local = isLocalModel(resolved.model);
				liveTargets.set(toolCallId, { kind, model: resolved.model, background: parsed.background });
				onUpdate?.({
					content: [{ type: "text" as const, text: delegateTargetLine(kind, resolved.model) }],
					details: { kind, model: resolved.model, pending: true, background: parsed.background },
				});

				const snap = scheduler.enqueue({
					kind,
					model: resolved.model,
					local,
					task: parsed.task,
					timeoutMs: parsed.timeoutMs,
					background: parsed.background,
					cancelOnAbort: parsed.background ? undefined : signal,
					run: (_handle, childSignal, onEvent, onControl) =>
						runChild({
							task: parsed.task,
							cwd,
							model: resolved.model,
							thinking: resolved.agent.thinking,
							tools: resolved.agent.tools,
							offline: resolved.agent.offline,
							hardTimeoutMs: config.hardTimeoutMs,
							maxOutputBytes: config.maxOutputBytes,
							promptSourcePath: promptSourceFromDir(EXTENSION_DIR, `${kind}.md`),
							signal: childSignal,
							env: process.env,
							onEvent,
							onControl,
						}),
				});
				publish(snap, parsed.background, snap.status === "queued" || snap.status === "running");

				if (parsed.background) {
					return formatOutput({
						text: receiptText(snap),
						failed: false,
						exitCode: 0,
						maxBytes: config.maxOutputBytes,
						kind,
						model: resolved.model,
						details: detailsFromSnap(snap, { background: true, pending: true }),
					});
				}

				let done = await scheduler.wait(snap.id, {
					timeoutMs: parsed.timeoutMs,
					signal,
					onSnapshot: (next) => publish(next, false, next.status === "queued" || next.status === "running"),
				});
				if (done.status === "queued" || done.status === "running") {
					done = scheduler.promoteBackground(snap.id);
				}
				if (done.status === "queued" || done.status === "running") {
					const text = receiptText(done);
					liveFromSnap(toolCallId, done, true);
					return formatOutput({
						text,
						failed: false,
						exitCode: 0,
						maxBytes: config.maxOutputBytes,
						kind,
						model: done.model || resolved.model,
						details: detailsFromSnap(done, { background: true, pending: true }),
					});
				}
				const model = done.model || resolved.model;
				const text = truncateOutput(done.answer || done.stderrTail || "(no output)", config.maxOutputBytes);
				const failed = done.failed;
				liveFromSnap(toolCallId, { ...done, model }, false);
				liveTargets.set(toolCallId, { kind, model, tg: done.tg });
				return formatOutput({
					text,
					failed,
					stopReason: done.stopReason,
					exitCode: done.exitCode ?? (failed ? 1 : 0),
					maxBytes: config.maxOutputBytes,
					kind,
					model,
					details: detailsFromSnap(done, {
						exitCode: done.exitCode ?? (failed ? 1 : 0),
						answer: text,
					}),
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResult(message);
			}
		},
		renderCall(args, theme, context) {
			const live = liveTargets.get(context.toolCallId);
			const kind = live?.kind ?? knownKind(args?.kind) ?? knownKind(context.state.kind);
			const model =
				live?.model ??
				(typeof context.state.model === "string" ? context.state.model : undefined) ??
				(kind ? config.agents[kind].model : undefined);
			const tg = live?.tg ?? (typeof context.state.tg === "string" ? context.state.tg : undefined);
			const jobId = live?.jobId ?? (typeof context.state.jobId === "string" ? context.state.jobId : undefined);
			const status = live?.status ?? (typeof context.state.status === "string" ? context.state.status : undefined);
			const background = Boolean(
				live?.background || args?.background === true || context.state.background === true,
			);
			if (kind) context.state.kind = kind;
			if (model) context.state.model = model;
			if (tg && isLocalModel(model)) context.state.tg = tg;
			else if (!isLocalModel(model)) delete context.state.tg;
			if (jobId) context.state.jobId = jobId;
			if (status) context.state.status = status;
			if (background) context.state.background = true;
			return renderChildCall({
				theme,
				title: "delegate",
				kind,
				model,
				thinking: live?.thinking,
				tg: isLocalModel(model) ? tg : undefined,
				background,
				jobId,
				status,
				lastComponent: context.lastComponent,
			});
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const details = (result.details ?? {}) as Record<string, unknown>;
			if (typeof details.kind === "string") context.state.kind = details.kind;
			if (typeof details.model === "string") context.state.model = details.model;
			if (typeof details.tg === "string" && isLocalModel(details.model)) context.state.tg = details.tg;
			if (typeof details.jobId === "string") context.state.jobId = details.jobId;
			if (typeof details.status === "string") context.state.status = details.status;
			if (details.background === true) context.state.background = true;
			return renderChildResult({
				theme,
				details,
				content: result.content,
				isError: context.isError,
				expanded,
				isPartial,
				lastComponent: context.lastComponent,
			});
		},
	});
}
