import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { Markdown, Text, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { activityLabel, asActivityItem, asActivityList, paintHeader, type ActivityItem, type ThemeFg } from "./display.ts";
import { paintNotify, type NotifyDetails } from "./notify.ts";
import { displayText } from "./stats.ts";
import { isLocalModel } from "./tg.ts";
import type { CardDetails } from "./cards.ts";
import type { JobBoardState } from "./panel.ts";

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

function receipt(state: RowState): string {
	const d = state.details;
	if (state.isError || d.ok === false || d.status === "failed") return "failure collected";
	if (d.status === "done") return "result collected";
	const action = str(d, "operation");
	if (state.isPartial) return action === "cancel" ? "cancelling" : action === "wrap" ? "wrapping up" : "waiting";
	if (action === "cancel") return "cancellation requested";
	if (action === "wrap") return "wrap requested";
	return d.status === "queued" ? "checked · queued at check" : d.status === "running" ? "checked · running at check" : "checked";
}

function statusLine(state: RowState): { color: string; text: string } {
	const d = state.details;
	if (state.isError || d.ok === false || d.status === "failed") {
		const reason = str(d, "stopReason");
		return { color: "error", text: reason === "aborted" ? "✗ Cancelled" : `✗ Failed${reason ? ` — ${reason}` : ""}` };
	}
	if (d.status === "done" || (!state.isPartial && !d.status)) return { color: "success", text: "✓ Finished" };
	if (d.historical) return { color: "muted", text: "○ Historical job — live status unavailable" };
	if (state.live && !state.pinned) return { color: "muted", text: "○ Accepted — card pinned above editor" };
	if (d.status === "queued") {
		const group = d.resource && typeof d.resource === "object" ? str(d.resource as CardDetails, "key") : "";
		const waiting = d.reason === "gpu" ? "GPU" : d.reason === "resource" ? `shared resource${group ? ` ${group}` : ""}` : "slot";
		return { color: "muted", text: `○ Queued — waiting for ${waiting}${d.wrapped ? " · wrap requested" : ""}` };
	}
	if (d.status === "running") {
		const current = asActivityItem(d.current);
		const phase = current?.mark === "→" ? activityLabel(current) : d.phase === "thinking" ? "thinking" : activityLabel(current);
		const tg = isLocalModel(str(d, "model")) && d.tg ? ` · ${str(d, "tg")}` : "";
		return { color: "accent", text: `● Running — ${phase}${tg}${d.wrapped ? " · wrap requested" : ""}` };
	}
	return { color: "muted", text: "○ Preparing" };
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
		const header = state.collect
			? `${input.theme.fg("toolTitle", input.theme.bold("delegate"))} · ${displayText(str(d, "jobId"))} · ${input.theme.fg(state.isError || d.ok === false || d.status === "failed" ? "error" : "muted", receipt(state))}`
			: paintHeader(input.theme, "delegate", displayText(str(d, "kind")), displayText(str(d, "model")), displayText(str(d, "jobId")));
		const lines = wrapTextWithAnsi(header, width);
		return state.collect ? lines : paintCard(input.theme, lines, width, cardBackground(state));
	});
}

export function renderChildResult(input: RowInput): ChildView {
	return new ChildView((width) => {
		const state = input.read(); const d = state.details; const theme = input.theme;
		if (state.live && !state.collect && !state.pinned) return state.expanded && d.sessionFile
			? wrapTextWithAnsi(input.theme.fg("dim", `Session: ${displayText(str(d, "sessionFile"))}`), width) : [];
		const lines: string[] = [];
		const add = (text: string, color?: string) => lines.push(...wrapTextWithAnsi(color ? theme.fg(color, text) : text, width));
		if (!state.collect) {
			const task = str(d, "task");
			if (task) {
				if (state.expanded) add(`Task: ${cleanBlock(task)}`, "muted");
				else lines.push(truncateToWidth(theme.fg("muted", `Task: ${displayText(task).replace(/\s+/g, " ").trim()}`), width, "…"));
			}
			const status = statusLine(state); add(displayText(status.text), status.color);
		}
		for (const key of ["recordingError", "displayWarning", "resourceError"]) if (d[key]) add(displayText(str(d, key)), "warning");
		const failed = state.isError || d.ok === false || d.status === "failed";
		const pending = d.status === "running" || d.status === "queued" || state.isPartial;
		const contentText = (state.content ?? []).flatMap((part) => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
		const answer = failed
			? ((d.status === "failed" ? str(d, "answer") : "") || contentText || str(d, "answer") || "delegate failed (no error details)")
			: (str(d, "answer") || contentText);
		if ((failed || !pending) && answer && (!state.collect || state.expanded || failed)) {
			const rendered = new Markdown(cleanBlock(answer), 0, 0, getMarkdownTheme()).render(width);
			while (rendered.length && !rendered[0].trim()) rendered.shift();
			while (rendered.length && !rendered.at(-1)!.trim()) rendered.pop();
			lines.push(...(state.expanded ? rendered : rendered.slice(0, 3)));
		}
		if (state.expanded) {
			if (!state.collect && !state.live) {
				const activity = asActivityList(d.activity).filter((item) => item.name !== "thinking");
				const current = asActivityItem(d.current);
				if (activity.length) { add("Recent tools (up to 3):", "muted"); for (const item of activity) add(paintActivity(theme, item)); }
				if (!d.historical && pending && current && current.name !== "thinking") add(paintActivity(theme, current));
			}
			if (d.sessionFile) add(`Session: ${displayText(str(d, "sessionFile"))}`, "dim");
		} else if (!state.collect || failed) {
			add(input.expandHint || "Expand for full result and tool details", "dim");
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
		const header = [theme.fg("toolTitle", theme.bold("delegate")), theme.fg("accent", displayText(str(d, "jobId"))),
			theme.fg("accent", displayText(str(d, "kind"))), theme.fg("dim", displayText(str(d, "model")))].join(" · ");
		const card = [fit(header)];
		const statusText = theme.fg(status.color, displayText(status.text));
		if (cardRows === 2) card.push(fit(statusText));
		if (cardRows >= 3) {
			const activity = asActivityList(d.activity).filter((item) => item.name !== "thinking");
			const current = asActivityItem(d.current);
			const extras: string[] = [];
			for (const key of ["recordingError", "displayWarning", "resourceError"]) if (d[key]) extras.push(theme.fg("warning", displayText(str(d, key))));
			if (expanded) {
				for (const item of activity) extras.push(paintActivity(theme, item));
				if (current && current.name !== "thinking") extras.push(paintActivity(theme, current));
				if (d.sessionFile) extras.push(theme.fg("dim", `Session: ${displayText(str(d, "sessionFile"))}`));
			} else {
				const latest = current?.mark === "→" ? current : activity.at(-1);
				if (latest) extras.push(paintActivity(theme, latest));
			}
			const task = `Task: ${expanded ? cleanBlock(str(d, "task")) : displayText(str(d, "task")).replace(/\s+/g, " ").trim()}`;
			const taskRows = expanded ? Math.max(1, cardRows - 2 - Math.min(extras.length, 3)) : 1;
			const taskLines = expanded ? clippedLines(wrapTextWithAnsi(theme.fg("muted", task), width), taskRows, width) : [fit(theme.fg("muted", task))];
			card.push(...taskLines, fit(statusText));
			card.push(...clippedLines(extras.map(fit), cardRows - card.length, width));
		}
		while (card.length < cardRows) card.push(""); // Stable geometry as tools start/finish.
		lines.push(...paintCard(theme, card, width, "toolPendingBg"));
	}
	if (footerRows) {
		const hidden = state.cards.length - shown;
		const more = hidden ? `+${hidden} more (${state.cards.slice(shown).map((d) => displayText(str(d, "jobId"))).join(", ")}) · ` : "";
		lines.push(fit(theme.fg("dim", `${more}${state.summary}${expandHint ? ` · ${expandHint}` : ""}`)));
	}
	// Width truncation emits SGR resets even with a plain theme; keep RPC text ANSI-free.
	return theme.bg ? lines : lines.map(stripTerminalSequences);
}

export function renderNotifyMessage(input: { theme: ThemeFg; details: NotifyDetails; expanded: boolean }): Text {
	return new Text(paintNotify(input.theme, input.details, input.expanded), 0, 0);
}
