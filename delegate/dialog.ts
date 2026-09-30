import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ThemeFg } from "./display.ts";

type DialogTheme = ThemeFg & { bg: (key: "toolPendingBg", text: string) => string };

/** Fixed-height, opaque panels stay distinct from the transcript streaming behind them. */
export const dialogHeight = (rows: number): number => Math.max(1, rows - 4);
export const dialogPageSize = (rows: number): number => Math.max(1, dialogHeight(rows) - 5);
export const dialogContentWidth = (width: number): number => Math.max(1, width - 4);

export function frameDialog(theme: DialogTheme, width: number, height: number, title: string, body: string[], footer: string[]): string[] {
	if (width < 1 || height < 1) return [];
	const paint = (line: string) => truncateToWidth(line, width, "…", true)
		.split(/(\x1b\[(?:0|49)?m)/)
		.map((part, index) => index % 2 ? part : theme.bg("toolPendingBg", part)).join("");
	if (width < 5 || height < 6) return [title, ...body, ...footer].slice(0, height).map(paint);
	const inside = width - 2;
	const label = truncateToWidth(`─ ${title} `, inside, "…");
	const border = (line: string) => theme.fg("accent", line);
	const row = (line: string) => `${border("│")} ${truncateToWidth(line, width - 4, "…", true)} ${border("│")}`;
	const capacity = height - 5;
	const content = body.slice(0, capacity);
	while (content.length < capacity) content.push("");
	return [border(`╭${label}${"─".repeat(Math.max(0, inside - visibleWidth(label)))}╮`),
		...content.map(row), row(""),
		row(theme.fg("muted", footer[0] ?? "")), row(theme.fg("muted", footer[1] ?? "")),
		border(`╰${"─".repeat(inside)}╯`),
	].map(paint);
}
