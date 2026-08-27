import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	assertNotNested,
	isFailedChildResult,
	normalizeTask,
	normalizeTimeoutMs,
	resolveChildCwd,
	truncateOutput,
} from "../child-runtime/policy.ts";
import { promptSourceFromDir } from "../child-runtime/spawn.ts";
import { assertKind, loadDelegateConfig, resolveAgent, type Kind } from "./config.ts";
import {
	applyProgress,
	clipThinkingTail,
	createProgress,
	delegateTargetLine,
	knownKind,
	parseChildProgress,
	plannedModel,
	type DelegateModels,
} from "./display.ts";
import { runChild, withSlot, type ChildResult } from "./spawn.ts";
import {
	applyTgEvent,
	createTgMeter,
	isLocalModel,
	resetTgMeter,
	visibleChildTg,
	TG_UI_EVERY_MS,
} from "./tg.ts";
import { renderChildCall, renderChildResult } from "./view.ts";

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

export default function delegate(pi: ExtensionAPI) {
	if (process.env.PI_DELEGATE_CHILD === "1") return;

	const config = loadDelegateConfig({
		shippedPath: join(EXTENSION_DIR, "config.json"),
		userPath:
			process.env.PI_DELEGATE_SKIP_USER_CONFIG === "1"
				? undefined
				: join(agentDir(), "delegate.json"),
	});
	const models: DelegateModels = {
		recon: config.agents.recon.model,
		implement: config.agents.implement.model,
		review: config.agents.review.model,
		oracle: config.agents.oracle.model,
	};
	const liveTargets = new Map<string, { kind: Kind; model: string; thinking?: string; tg?: string }>();

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description: "One-shot child. recon/implement/review/oracle. Model from config (any Pi model). No nesting.",
		promptSnippet: "Route isolated work to a named delegate agent. Model comes from config or the model argument.",
		promptGuidelines: [
			"Use delegate for isolated child work. One child per call. No nesting.",
			"Use kind recon for lookups and file maps. Not for edits.",
			"Use kind implement for bounded edits and tests.",
			"Use kind review only if implement already failed or judgment is required.",
			"Use kind oracle last resort. Never parallel oracle.",
			"Optional model override: any Pi model id (provider/id). Kind keeps tools and prompt.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "Task for the child. Non-empty, max 20000 chars." }),
			kind: Type.String({ description: "recon, implement, review, or oracle." }),
			cwd: Type.Optional(
				Type.String({ description: "Child working directory. Relative paths resolve against parent cwd." }),
			),
			timeoutMs: Type.Optional(Type.Integer({ description: "Child timeout in ms." })),
			model: Type.Optional(
				Type.String({
					description: "Override child model. Any Pi model id (provider/id).",
				}),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const progress = createProgress();
			const meter = createTgMeter();
			let lastTg: string | undefined;
			let lastTgUiAt = 0;
			try {
				assertNotNested(process.env, "delegate");
				const kind = assertKind(params.kind);
				const task = normalizeTask(params.task, config.maxTaskChars, "delegate");
				const cwd = resolveChildCwd(params.cwd, ctx.cwd, "delegate");
				const resolved = resolveAgent(kind, typeof params.model === "string" ? params.model : undefined, config);
				const timeoutMs = normalizeTimeoutMs(params.timeoutMs, config, "delegate");
				const showProgress = (model: string, event?: unknown, force = false) => {
					let activityChanged = !event;
					if (event) {
						const item = parseChildProgress(event);
						activityChanged = item ? applyProgress(progress, item) : false;
						if (isLocalModel(model)) applyTgEvent(meter, event);
					}
					const now = Date.now();
					const ended =
						Boolean(event) && typeof event === "object" && (event as { type?: unknown }).type === "message_end";
					const nextTg = visibleChildTg(model, meter, lastTg, now);
					const tgDue =
						nextTg !== lastTg &&
						(force || ended || lastTg === undefined || activityChanged || now - lastTgUiAt >= TG_UI_EVERY_MS);
					if (event && !activityChanged && !tgDue && !force && !ended) return;
					if (nextTg !== lastTg) {
						lastTg = nextTg;
						lastTgUiAt = now;
					}
					const thinking = clipThinkingTail(progress.thinking ?? "") || undefined;
					const tg = isLocalModel(model) ? lastTg : undefined;
					liveTargets.set(toolCallId, { kind, model, thinking, tg });
					onUpdate?.({
						content: [{ type: "text" as const, text: delegateTargetLine(kind, model) }],
						details: {
							kind,
							model,
							pending: true,
							activity: [...progress.done],
							current: progress.current,
							thinking,
							tg,
						},
					});
				};
				liveTargets.set(toolCallId, { kind, model: resolved.model });
				showProgress(resolved.model, undefined, true);

				const result: ChildResult = await withSlot(config.maxConcurrent, () =>
					runChild({
						task,
						cwd,
						model: resolved.model,
						thinking: resolved.agent.thinking,
						tools: resolved.agent.tools,
						offline: resolved.agent.offline,
						timeoutMs,
						maxOutputBytes: config.maxOutputBytes,
						promptSourcePath: promptSourceFromDir(EXTENSION_DIR, `${kind}.md`),
						signal,
						env: process.env,
						onEvent: (event) => {
							showProgress(resolved.model, event);
						},
					}),
				);

				const model = result.model || resolved.model;
				progress.thinking = undefined;
				const tg = visibleChildTg(model, meter, lastTg);
				liveTargets.set(toolCallId, { kind, model, tg });
				const text = truncateOutput(result.text || result.stderrTail || "(no output)", config.maxOutputBytes);
				return formatOutput({
					text,
					failed: isFailedChildResult(result),
					stopReason: result.stopReason,
					exitCode: result.exitCode,
					maxBytes: config.maxOutputBytes,
					kind,
					model,
					details: {
						kind,
						exitCode: result.exitCode,
						model,
						stopReason: result.stopReason,
						stderrTail: result.stderrTail,
						activity: [...progress.done],
						answer: text,
						tg,
					},
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
				(kind ? plannedModel(kind, models) : undefined);
			const tg = live?.tg ?? (typeof context.state.tg === "string" ? context.state.tg : undefined);
			if (kind) context.state.kind = kind;
			if (model) context.state.model = model;
			if (tg && isLocalModel(model)) context.state.tg = tg;
			else if (!isLocalModel(model)) delete context.state.tg;
			return renderChildCall({
				theme,
				title: "delegate",
				kind,
				model,
				thinking: live?.thinking,
				tg: isLocalModel(model) ? tg : undefined,
				lastComponent: context.lastComponent,
			});
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const details = (result.details ?? {}) as Record<string, unknown>;
			if (typeof details.kind === "string") context.state.kind = details.kind;
			if (typeof details.model === "string") context.state.model = details.model;
			if (typeof details.tg === "string" && isLocalModel(details.model)) context.state.tg = details.tg;
			return renderChildResult({
				theme,
				details,
				expanded,
				isPartial,
				lastComponent: context.lastComponent,
			});
		},
	});
}
