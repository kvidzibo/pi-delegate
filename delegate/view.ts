import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { Markdown, Text, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { activityLabel, aliasForModel, asActivityItem, asActivityList, durationContent, formatDuration, paintHeader, type ActivityItem, type ThemeFg } from "./display.ts";
import { paintNotify, type NotifyDetails } from "./notify.ts";
import { displayText } from "./stats.ts";
import { isLocalModel } from "./tg.ts";
import type { CardDetails } from "./cards.ts";
import type { JobBoardState } from "./panel.ts";
import { capabilityContent } from "./capabilities.ts";
import { outcomeContent } from "./outcomes.ts";

export type RowState = {
	details: CardDetails;
	content?: ReadonlyArray<{ type: string; text?: string }>;
	isError?: boolean;
	expanded: boolean;
	isPartial: boolean;
	collect: boolean;
	live: boolean;
	pinned?: boolean;
};
type CardBackground = "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";
type CardTheme = ThemeFg & { bg?: (key: CardBackground, text: string) => string };
type RowInput = { theme: CardTheme; read: () => RowState; expandHint?: string };
const str = (details: CardDetails, key: string): string => typeof details[key] === "string" ? details[key] as string : "";
const cleanBlock = (text: string): string => text.split("\n").map(displayText).join("\n");
const effortLabel = (d: CardDetails): string => str(d, "reasoning") ? ` · effort ${displayText(str(d, "reasoning"))}` : "";

function receipt(state: RowState): string {
	const d = state.details;
	if (state.isError || d.ok === false || d.status === "failed") {
		const reason = str(d, "stopReason");
		return reason === "aborted" ? "cancelled" : `failure collected${reason ? ` · ${displayText(reason).replace(/_/g, " ")}` : ""}`;
	}
	if (d.status === "done") return "result collected";
	if (d.cancellationRequested) return "cancellation requested · cleanup pending";
	const action = str(d, "operation");
	if (state.isPartial) return action === "cancel" ? "cancelling" : action === "wrap" ? "wrapping up" : "waiting";
	if (action === "cancel") return "cancellation requested";
	if (action === "wrap") return "wrap requested";
	const status = d.status === "queued" ? "checked · queued at check" : d.status === "running" ? "checked · running at check" : "checked";
	const elapsed = formatDuration(d.elapsedMs);
	const previous = formatDuration(d.sincePreviousCheckMs);
	return status + (elapsed ? ` · ${d.status === "queued" ? "queued for" : "elapsed"} ${elapsed}` : "")
		+ (previous ? ` · since previous check ${previous}` : "");
}

function statusLine(state: RowState): { color: string; text: string } {
	const d = state.details;
	if (state.isError || d.ok === false || d.status === "failed") {
		const reason = str(d, "stopReason");
		return reason === "aborted" ? { color: "muted", text: "○ Cancelled" }
			: { color: "error", text: `✗ Failed${reason ? ` — ${reason}` : ""}` };
	}
	if (d.status === "done" || (!state.isPartial && !d.status)) return { color: "muted", text: "○ Worker finished — task unverified" };
	if (d.historical) return { color: "muted", text: "○ Historical job — live status unavailable" };
	if (state.live && !state.pinned) return { color: "muted", text: "○ Accepted — card pinned above editor" };
	if (d.status === "queued") {
		const group = d.resource && typeof d.resource === "object" ? str(d.resource as CardDetails, "key") : "";
		const waiting = d.reason === "resource" ? `waiting for shared resource${group ? ` ${group}` : ""}` : `waiting for ${d.reason === "gpu" ? "GPU" : "slot"}`;
		return { color: "muted", text: `○ Queued — ${waiting}${d.wrapped ? " · wrap requested" : ""}` };
	}
	if (d.status === "running") {
		if (d.cancellationRequested) return { color: "muted", text: "● Cancelling — waiting for child cleanup" };
		const current = asActivityItem(d.current);
		const phase = current?.mark === "→" ? activityLabel(current) : d.phase === "thinking" ? "thinking" : activityLabel(current);
		const tg = isLocalModel(str(d, "model")) && d.tg ? ` · ${str(d, "tg")}` : "";
		return { color: "accent", text: `● Running — ${phase}${tg}${d.wrapped ? " · wrap requested" : ""}` };
	}
	return { color: "muted", text: "○ Preparing" };
}

function compactHeader(theme: ThemeFg, d: CardDetails, state: RowState): string {
	const status = statusLine(state);
	const label = status.text.includes("Worker finished") ? "○ Finished · unverified" : status.text.split(" — ")[0];
	return [theme.fg("toolTitle", theme.bold(displayText(str(d, "jobId")) || "delegate")),
		theme.fg("accent", displayText(str(d, "kind")) || "…"), theme.fg(status.color, label),
		theme.fg("dim", displayText(aliasForModel(str(d, "model"))))].join(" · ");
}

function cardBackground(state: RowState): CardBackground {
	const { color } = statusLine(state);
	return color === "error" ? "toolErrorBg" : color === "success" ? "toolSuccessBg" : "toolPendingBg";
}

function paintCard(theme: CardTheme, lines: string[], width: number, color: CardBackground): string[] {
	const bg = theme.bg?.bind(theme);
	if (!bg) return lines; // RPC previews use a plain, foreground-only theme.
	return lines.map((line) => truncateToWidth(line, width, "…", true)
		// Wrapping, truncation and Markdown can reset styles inside a line.
		// Paint each span separately so the fill survives resets, including padding.
		.split(/(\x1b\[(?:0|49)?m)/)
		.map((part, index) => index % 2 ? part : bg(color, part)).join(""));
}

function paintActivity(theme: ThemeFg, item: ActivityItem): string {
	const color = item.mark === "✗" ? "error" : item.mark === "✓" ? "success" : "muted";
	return `${theme.fg(color, item.mark)} ${theme.fg("accent", displayText(item.name))}${item.args ? `  ${theme.fg("dim", displayText(item.args))}` : ""}`;
}

// Shared content formatting; transcript and dock keep their own visibility and row budgets.
function cardText(theme: ThemeFg, d: CardDetails, expanded: boolean, width: number) {
	const current = asActivityItem(d.current);
	const task = theme.fg("muted", `Task: ${expanded ? cleanBlock(str(d, "task")) : displayText(str(d, "task")).replace(/\s+/g, " ").trim()}`);
	return {
		task: expanded ? wrapTextWithAnsi(task, width) : [truncateToWidth(task, width, "…")],
		warnings: ["recordingError", "displayWarning", "resourceError"].filter(key => d[key]).map(key => theme.fg("warning", displayText(str(d, key)))),
		activity: asActivityList(d.activity).filter(item => item.name !== "thinking").map(item => paintActivity(theme, item)),
		current: current && current.name !== "thinking" ? paintActivity(theme, current) : undefined,
		active: current?.mark === "→" ? paintActivity(theme, current) : undefined,
		session: d.sessionFile ? theme.fg("dim", `Session: ${displayText(str(d, "sessionFile"))}`) : undefined,
	};
}

// Both slots read at render time, after renderResult has populated shared row state.
// This also lets an already-returned background spawn show its latest job snapshot.
export class ChildView {
	constructor(private readonly draw: (width: number) => string[]) {}
	invalidate(): void {}
	render(width: number): string[] {
		if (width < 1) return [];
		return this.draw(width).map((line) => truncateToWidth(line, width, "…"));
	}
}

export function renderChildCall(input: RowInput): ChildView {
	return new ChildView((width) => {
		const state = input.read(); const d = state.details;
		if (state.live && !state.collect && !state.pinned) return wrapTextWithAnsi(
			`${input.theme.fg("toolTitle", input.theme.bold("delegate"))} · ${displayText(str(d, "jobId"))} · ${input.theme.fg("muted", "accepted — card pinned above editor")}`, width);
		let header = state.expanded
			? paintHeader(input.theme, "delegate", displayText(str(d, "kind")), displayText(str(d, "model")), displayText(str(d, "jobId"))) + input.theme.fg("dim", effortLabel(d))
			: compactHeader(input.theme, d, state);
		if (state.collect) header += ` · ${input.theme.fg(statusLine(state).color === "error" ? "error" : "muted", receipt(state))}`;
		const lines = wrapTextWithAnsi(header, width);
		return state.collect ? lines : paintCard(input.theme, lines, width, cardBackground(state));
	});
}

export function renderChildResult(input: RowInput): ChildView {
	return new ChildView((width) => {
		const state = input.read(); const d = state.details; const theme = input.theme;
		const text = cardText(theme, d, state.expanded, width);
		if (state.live && !state.collect && !state.pinned) return state.expanded && text.session ? wrapTextWithAnsi(text.session, width) : [];
		const lines: string[] = [];
		let hiddenResultLines = 0;
		const add = (text: string, color?: string) => lines.push(...wrapTextWithAnsi(color ? theme.fg(color, text) : text, width));
		const failed = state.isError || d.ok === false || d.status === "failed";
		const pending = d.status === "running" || d.status === "queued" || state.isPartial;
		const cancelled = failed && d.stopReason === "aborted";
		if ((!state.collect || failed || state.expanded) && str(d, "task")) lines.push(...text.task);
		if (!state.collect) {
			const status = statusLine(state); add(displayText(status.text), status.color);
		}
		const duration = !pending ? formatDuration(d.durationMs) : undefined;
		if (duration !== undefined) add(`Duration: ${duration}`, "dim");
		for (const warning of text.warnings) add(warning);
		const dataBlocks = [...capabilityContent(d.capabilities), ...outcomeContent(d.outcome)];
		const textParts = (state.content ?? []).flatMap((part) => part.type === "text" && typeof part.text === "string" ? [part.text] : []);
		// At most one exact trailing separate block per kind; never infer a suffix in report prose.
		const footers = new Set([...durationContent(d.durationMs), ...dataBlocks].map(block => block.text));
		while (textParts.length > 1 && footers.delete(textParts.at(-1)!)) textParts.pop();
		const contentText = textParts.join("\n");
		const answer = failed
			? ((d.status === "failed" ? str(d, "answer") : "") || contentText || str(d, "answer") || "delegate failed (no error details)")
			: (str(d, "answer") || contentText);
		// Cancelled runs may contain only internal response placeholders. Keep all raw
		// evidence available when expanded; the compact view shows identity/task/activity.
		if ((failed || !pending) && answer && (!state.collect || state.expanded || failed) && (!cancelled || state.expanded)) {
			const rendered = new Markdown(cleanBlock(answer), 0, 0, getMarkdownTheme()).render(width);
			while (rendered.length && !rendered[0].trim()) rendered.shift();
			while (rendered.length && !rendered.at(-1)!.trim()) rendered.pop();
			hiddenResultLines = state.expanded ? 0 : Math.max(0, rendered.length - 3);
			lines.push(...(state.expanded ? rendered : rendered.slice(0, 3)));
		}
		if (state.expanded) {
			if (state.collect || !state.live || state.pinned) {
				if (text.activity.length) { add("Recent tools (up to 3):", "muted"); for (const item of text.activity) add(item); }
				if (!d.historical && pending && text.current) add(text.current);
			}
			for (const block of dataBlocks) add(cleanBlock(block.text), "dim");
			if (text.session) add(text.session);
		} else {
			const latest = failed ? text.activity.at(-1) : undefined;
			if (latest) lines.push(truncateToWidth(`Last recorded tool: ${latest}`, width, "…"));
			if (!state.collect || failed) add(`${hiddenResultLines ? `+${hiddenResultLines} more lines · ` : ""}${input.expandHint || keyHint("app.tools.expand", "full result and tool details")}`, "dim");
		}
		return state.collect ? lines : paintCard(theme, lines, width, cardBackground(state));
	});
}

export function renderJobBoardLine(line: string, width: number): string[] {
	return width < 1 ? [] : [truncateToWidth(` ${line}`, width, "…")];
}

function clippedLines(lines: string[], limit: number, width: number): string[] {
	if (limit < 1) return [];
	const clipped = lines.slice(0, limit);
	if (lines.length > limit) clipped[limit - 1] = truncateToWidth(clipped[limit - 1], Math.max(0, width - 1), "") + "…";
	return clipped;
}

/** Full live cards, bounded to the input dock's budget, not a counts-only strip. */
export function renderJobBoard(state: JobBoardState, width: number, maxRows: number, theme: CardTheme, expanded: boolean, expandHint = keyHint("app.tools.expand", "details")): string[] {
	if (width < 1 || maxRows < 1 || !state.cards.length) return [];
	const footerRows = maxRows >= 4 ? 1 : 0;
	const shown = Math.min(state.cards.length, Math.max(1, Math.floor((maxRows - footerRows) / 3)));
	const cardRows = Math.min(expanded ? 8 : 4, Math.floor((maxRows - footerRows) / shown));
	const lines: string[] = [];
	const fit = (text: string) => truncateToWidth(text, width, "…");
	for (const d of state.cards.slice(0, shown)) {
		const status = statusLine({ details: d, collect: false, live: true, pinned: true, isPartial: true, expanded });
		const row = { details: d, collect: false, live: true, pinned: true, isPartial: true, expanded };
		const header = expanded
			? paintHeader(theme, "delegate", displayText(str(d, "kind")), displayText(str(d, "model")), displayText(str(d, "jobId"))) + theme.fg("dim", effortLabel(d))
			: compactHeader(theme, d, row);
		const card = [fit(header)];
		const statusText = theme.fg(status.color, displayText(status.text));
		if (cardRows === 2) card.push(fit(statusText));
		if (cardRows >= 3) {
			const text = cardText(theme, d, expanded, width);
			const extras = [...text.warnings, ...(expanded
				? [...text.activity, text.current, text.session]
				: [text.active ?? text.activity.at(-1)]).filter((line): line is string => line !== undefined)];
			const taskRows = expanded ? Math.max(1, cardRows - 2 - Math.min(extras.length, 3)) : 1;
			card.push(...clippedLines(text.task, taskRows, width), fit(statusText));
			card.push(...clippedLines(extras.map(fit), cardRows - card.length, width));
		}
		while (card.length < cardRows) card.push(""); // Stable geometry as tools start/finish.
		lines.push(...paintCard(theme, card, width, "toolPendingBg"));
	}
	if (footerRows) {
		const hidden = state.cards.length - shown;
		const more = hidden ? `+${hidden} more · ` : "";
		const ids = hidden && expanded ? ` · ${state.cards.slice(shown).map(d => displayText(str(d, "jobId"))).join(", ")}` : "";
		lines.push(fit(theme.fg("dim", `${more}/pi-delegate jobs · ${state.summary}${expandHint ? ` · ${expandHint}` : ""}${ids}`)));
	}
	// Width truncation emits SGR resets even with a plain theme; keep RPC text ANSI-free.
	return theme.bg ? lines : lines.map(stripTerminalSequences);
}

export function renderNotifyMessage(input: { theme: ThemeFg; details: NotifyDetails; expanded: boolean }): Text {
	return new Text(paintNotify(input.theme, input.details, input.expanded), 0, 0);
}
