import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { activityLabel, asActivityItem, asActivityList, paintHeader, type ActivityItem, type ThemeFg } from "./display.ts";
import { paintNotify, type NotifyDetails } from "./notify.ts";
import { displayText } from "./stats.ts";
import { isLocalModel } from "./tg.ts";
import type { CardDetails } from "./cards.ts";

export type RowState = {
	details: CardDetails;
	content?: ReadonlyArray<{ type: string; text?: string }>;
	isError?: boolean;
	expanded: boolean;
	isPartial: boolean;
	collect: boolean;
};
type RowInput = { theme: ThemeFg; read: () => RowState; expandHint?: string };
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
	if (d.status === "queued") return { color: "muted", text: `○ Queued — waiting for ${d.reason === "gpu" ? "GPU" : "slot"}` };
	if (d.status === "running") {
		const current = asActivityItem(d.current);
		const phase = current?.mark === "→" ? activityLabel(current) : d.phase === "thinking" ? "thinking" : activityLabel(current);
		const tg = isLocalModel(str(d, "model")) && d.tg ? ` · ${str(d, "tg")}` : "";
		return { color: "accent", text: `● Running — ${phase}${tg}${d.wrapped ? " · wrap requested" : ""}` };
	}
	return { color: "muted", text: "○ Preparing" };
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
		const header = state.collect
			? `${input.theme.fg("toolTitle", input.theme.bold("delegate"))} · ${displayText(str(d, "jobId"))} · ${input.theme.fg(state.isError || d.ok === false || d.status === "failed" ? "error" : "muted", receipt(state))}`
			: paintHeader(input.theme, "delegate", displayText(str(d, "kind")), displayText(str(d, "model")), displayText(str(d, "jobId")));
		return wrapTextWithAnsi(header, width);
	});
}

export function renderChildResult(input: RowInput): ChildView {
	return new ChildView((width) => {
		const state = input.read(); const d = state.details; const theme = input.theme;
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
		for (const key of ["recordingError", "displayWarning"]) if (d[key]) add(displayText(str(d, key)), "warning");
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
			if (!state.collect) {
				const activity = asActivityList(d.activity).filter((item) => item.name !== "thinking");
				const current = asActivityItem(d.current);
				if (activity.length) { add("Recent tools (up to 3):", "muted"); for (const item of activity) add(paintActivity(theme, item)); }
				if (!d.historical && pending && current && current.name !== "thinking") add(paintActivity(theme, current));
			}
			if (d.sessionFile) add(`Session: ${displayText(str(d, "sessionFile"))}`, "dim");
		} else if (!state.collect || failed) {
			add(input.expandHint || "Expand for full result and tool details", "dim");
		}
		return lines;
	});
}

export function renderNotifyMessage(input: { theme: ThemeFg; details: NotifyDetails; expanded: boolean }): Text {
	return new Text(paintNotify(input.theme, input.details, input.expanded), 0, 0);
}
