import { Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	ACTIVITY_NAME_PAD,
	asActivityItem,
	asActivityList,
	paintHeader,
	type ActivityItem,
	type ActivityMark,
	type ThemeFg,
} from "./display.ts";
import { paintNotify, type NotifyDetails } from "./notify.ts";

function markColor(mark: ActivityMark): string {
	if (mark === "✓") return "success";
	if (mark === "✗") return "error";
	if (mark === "…") return "dim";
	return "muted";
}

export function paintActivity(theme: ThemeFg, item: ActivityItem): string {
	const name = item.args ? item.name.padEnd(ACTIVITY_NAME_PAD) : item.name;
	let line = `  ${theme.fg(markColor(item.mark), item.mark)}  ${theme.fg("accent", name)}`;
	if (item.args) line += `  ${theme.fg("dim", item.args)}`;
	return line;
}

export class ChildActions {
	lines: string[] = [];
	extra: string[] = [];

	invalidate(): void {}

	render(width: number): string[] {
		const out = this.lines.map((line) => truncateToWidth(line, width, "…"));
		for (const block of this.extra) {
			if (block === "") {
				out.push("");
				continue;
			}
			out.push(...wrapTextWithAnsi(block, Math.max(1, width)));
		}
		return out;
	}
}

export function renderChildCall(input: {
	theme: ThemeFg;
	title: string;
	kind?: string;
	model?: string;
	thinking?: string;
	tg?: string;
	background?: boolean;
	jobId?: string;
	status?: string;
	lastComponent?: unknown;
}): Text {
	const text = (input.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	text.setText(
		paintHeader(input.theme, input.title, input.kind, input.model, input.thinking, input.tg, {
			background: input.background,
			jobId: input.jobId,
			status: input.status,
		}),
	);
	return text;
}

export function renderChildResult(input: {
	theme: ThemeFg;
	details: Record<string, unknown> | undefined;
	content?: ReadonlyArray<{ type: string; text?: string }>;
	isError?: boolean;
	expanded: boolean;
	isPartial: boolean;
	lastComponent?: unknown;
}): ChildActions {
	const details = input.details ?? {};
	const done = asActivityList(details.activity).filter((item) => item.name !== "thinking");
	const current = input.isPartial ? asActivityItem(details.current) : undefined;
	const panel = (input.lastComponent as ChildActions | undefined) ?? new ChildActions();
	panel.lines = done.map((item) => paintActivity(input.theme, item));
	if (current && current.name !== "thinking") panel.lines.push(paintActivity(input.theme, current));
	panel.extra = [];
	const contentText = (input.content ?? []).flatMap((part) => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
	const answer = typeof details.answer === "string" ? details.answer : contentText;
	if (!input.isPartial && (input.isError || details.ok === false || details.status === "failed")) {
		const error = contentText || answer || "delegate failed (no error details)";
		const lines = error.split("\n");
		const visible = input.expanded ? lines : lines.filter((line) => line.trim()).slice(0, 3);
		panel.extra.push(...visible.map((line) => input.theme.fg("error", line)));
		if (!input.expanded && lines.filter((line) => line.trim()).length > 3) {
			panel.extra.push(input.theme.fg("dim", "… expand for full error"));
		}
		return panel;
	}
	if (!input.isPartial && input.expanded) {
		const task = typeof details.task === "string" ? details.task : "";
		const status = typeof details.status === "string" ? details.status : "";
		if (answer) {
			panel.extra.push("");
			panel.extra.push(...answer.split("\n"));
		} else if (task && (status === "queued" || status === "running")) {
			panel.extra.push("");
			panel.extra.push(task);
		}
	}
	return panel;
}

export function renderNotifyMessage(input: {
	theme: ThemeFg;
	details: NotifyDetails;
	expanded: boolean;
}): Text {
	const text = new Text("", 0, 0);
	text.setText(paintNotify(input.theme, input.details, input.expanded));
	return text;
}
