import type { RunRecord } from "./archive.ts";
import { formatDuration, type ThemeFg } from "./display.ts";
import { displayText, formatTokens, latestRuns } from "./stats.ts";
import { totalTokens } from "./usage.ts";

/** Custom session entry: shown in the transcript, never sent to the model. */
export const SUMMARY_ENTRY_TYPE = "delegate-summary";
const STATUSES = ["done", "failed", "running", "queued"] as const;
type Status = typeof STATUSES[number];
/** `partial`: started run whose recorded tokens are a lower bound; `tokens` is omitted when none were reported. */
export type SummaryRow = { jobId?: string; kind: string; model: string; reasoning: string; status: Status; durationMs?: number; tokens?: number; live?: boolean; partial?: boolean };
/** `warnings`: unreadable archive records that may belong to this session. */
export type SessionSummary = { sessionId: string; rows: SummaryRow[]; warnings?: number };

// Scheduler IDs are fixed-width hex per extension lifetime; they break launch-time ties in acceptance order.
const sequence = (jobId: string | undefined): number => jobId && /^d[0-9a-f]+$/.test(jobId) ? parseInt(jobId.slice(1), 16) : Infinity;

/**
 * Snapshot one parent session's runs in launch order, the order the live panel lists jobs.
 * `jobIds` supplies scheduler IDs for queued runs, whose archives record a job ID only when started.
 */
export function summarizeSession(runs: RunRecord[], sessionId: string, options: { active: ReadonlySet<string>; jobIds?: ReadonlyMap<string, string>; now?: number; warnings?: number }): SessionSummary {
	const now = options.now ?? Date.now();
	// Archive validation does not type these optional fields; never let one record break the table.
	const text = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;
	const rows = latestRuns(runs).filter(run => run.parentSessionId === sessionId)
		.map(run => ({ run, jobId: text(run.jobId) ?? options.jobIds?.get(run.runId) }))
		.sort((a, b) => Date.parse(a.run.createdAt) - Date.parse(b.run.createdAt) || sequence(a.jobId) - sequence(b.jobId))
		.map(({ run, jobId }): SummaryRow => {
			// Only this process's running jobs are measurably live; stale on-disk "running" rows show no duration.
			const live = options.active.has(run.runId) && run.status === "running";
			const started = run.startedAt ? Date.parse(run.startedAt) : NaN;
			const durationMs = run.finishedAt ? run.durationMs : live && Number.isFinite(started) ? Math.max(0, now - started) : undefined;
			const partial = Boolean(run.startedAt) && !live && (run.usage.incomplete || run.usage.missing > 0);
			const unknown = !run.startedAt || (partial && totalTokens(run.usage) === 0);
			return {
				...(jobId ? { jobId } : {}), kind: run.kind, model: text(run.actualModel) ?? run.requestedModel,
				reasoning: run.thinking, status: run.status, ...(durationMs === undefined ? {} : { durationMs }),
				...(unknown ? {} : { tokens: totalTokens(run.usage) }), ...(live ? { live } : {}), ...(partial ? { partial } : {}),
			};
		});
	return { sessionId, rows, ...(options.warnings ? { warnings: options.warnings } : {}) };
}

const count = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Session entries are persisted data: accept only the shape this module writes. */
export function copySummary(value: unknown): SessionSummary | undefined {
	const data = value as Partial<SessionSummary> | undefined;
	if (!data || typeof data.sessionId !== "string" || !Array.isArray(data.rows) || (data.warnings !== undefined && !count(data.warnings))) return undefined;
	const rows: SummaryRow[] = [];
	for (const row of data.rows as Array<Partial<SummaryRow>>) {
		if (!row || typeof row.kind !== "string" || typeof row.model !== "string" || typeof row.reasoning !== "string"
			|| !STATUSES.includes(row.status as Status) || (row.jobId !== undefined && typeof row.jobId !== "string")
			|| (row.durationMs !== undefined && !count(row.durationMs)) || (row.tokens !== undefined && !count(row.tokens))) return undefined;
		rows.push({ ...(row.jobId ? { jobId: row.jobId } : {}), kind: row.kind, model: row.model, reasoning: row.reasoning, status: row.status as Status,
			...(row.durationMs === undefined ? {} : { durationMs: row.durationMs }), ...(row.tokens === undefined ? {} : { tokens: row.tokens }),
			...(row.live === true ? { live: true } : {}), ...(row.partial === true ? { partial: true } : {}) });
	}
	return { sessionId: data.sessionId, rows, ...(data.warnings ? { warnings: data.warnings } : {}) };
}

export const summaryWarning = (warnings: number): string =>
	`${warnings} unreadable archive record${warnings === 1 ? "" : "s"}; totals may be incomplete (see /pi-delegate stats)`;

const STATUS_COLOR: Record<Status, string> = { done: "success", failed: "error", running: "warning", queued: "muted" };
const HEADER = ["#", "Job", "Role", "Model", "Reasoning", "Status", "Duration", "Tokens"];
const RIGHT = new Set([0, 6, 7]);
// Unit tests run without Pi peer packages; the TUI renderer passes Pi's terminal-cell measure.
const codePoints = (text: string): number => [...text].length;

export function summaryLines(summary: SessionSummary, theme: ThemeFg, measure: (text: string) => number = codePoints): string[] {
	const title = `${theme.fg("customMessageLabel", theme.bold("[delegate summary]"))} ${theme.fg("muted", `· session ${displayText(summary.sessionId.slice(0, 8))} · not sent to model`)}`;
	const warning = summary.warnings ? [theme.fg("warning", summaryWarning(summary.warnings))] : [];
	if (!summary.rows.length) return [title, "", "No delegate runs in this session yet.", ...warning];
	const mark = (row: SummaryRow) => row.live ? "…" : row.partial ? "+" : "";
	const cells = summary.rows.map((row, index) => [String(index + 1), row.jobId ?? "—", row.kind, row.model, row.reasoning, row.status,
		row.durationMs === undefined ? "—" : `${formatDuration(row.durationMs)}${row.live ? "…" : ""}`,
		row.tokens === undefined ? "—" : `${formatTokens(row.tokens)}${mark(row)}`].map(displayText));
	const anyLive = summary.rows.some(row => row.live);
	const lowerBound = summary.rows.some(row => row.partial);
	// A stale "running" archive (e.g. after a crash) has unknown runtime.
	const timeLowerBound = summary.rows.some(row => row.status === "running" && row.durationMs === undefined);
	const timed = summary.rows.filter(row => row.durationMs !== undefined), counted = summary.rows.filter(row => row.tokens !== undefined);
	const totalTime = timed.length ? `${formatDuration(timed.reduce((sum, row) => sum + row.durationMs!, 0))}${anyLive ? "…" : timeLowerBound ? "+" : ""}` : "—";
	const totalTokens = counted.length ? `${formatTokens(counted.reduce((sum, row) => sum + row.tokens!, 0))}${anyLive ? "…" : lowerBound ? "+" : ""}` : "—";
	const widths = HEADER.map((name, column) => Math.max(measure(name), ...cells.map(row => measure(row[column])),
		column === 6 ? measure(totalTime) : column === 7 ? measure(totalTokens) : 0));
	const pad = (text: string, column: number) => {
		const space = " ".repeat(Math.max(0, widths[column] - measure(text)));
		return RIGHT.has(column) ? space + text : text + space;
	};
	const join = (values: string[]) => values.join("  ");
	const tableWidth = widths.reduce((sum, width) => sum + width, 0) + 2 * (widths.length - 1);
	const rule = theme.fg("dim", "─".repeat(tableWidth));
	const statusCounts = STATUSES.map(status => [status, summary.rows.filter(row => row.status === status).length] as const)
		.filter(([, n]) => n > 0).map(([status, n]) => `${n} ${status}`);
	const runs = " ".repeat(widths[0] + 2) + `${summary.rows.length} run${summary.rows.length === 1 ? "" : "s"} · ${statusCounts.join(" · ")}`;
	// Counts share the totals row when they fit left of Duration; otherwise they get their own line.
	const durationStart = tableWidth - widths[7] - 2 - widths[6];
	const fits = measure(runs) + 2 <= durationStart;
	const totals = `${fits ? theme.fg("muted", runs) : ""}${" ".repeat(durationStart - (fits ? measure(runs) : 0))}${theme.bold(`${pad(totalTime, 6)}  ${pad(totalTokens, 7)}`)}`;
	const notes = ["Launch order, as in the live panel"];
	if (anyLive) notes.push("… still running");
	if (lowerBound || timeLowerBound) notes.push("+ lower bound (incomplete records)");
	const ids = summary.rows.flatMap(row => row.jobId ? [row.jobId] : []);
	if (new Set(ids).size < ids.length) notes.push("job IDs restart after reload or resume");
	return [
		title, "",
		theme.fg("muted", theme.bold(join(HEADER.map(pad)))), rule,
		...cells.map((row, index) => join(row.map((cell, column) => {
			const text = pad(cell, column);
			if (column === 5) return theme.fg(STATUS_COLOR[summary.rows[index].status], text);
			return column < 2 ? theme.fg("muted", text) : text;
		}))),
		rule, totals, ...(fits ? [] : [theme.fg("muted", runs)]), "", theme.fg("dim", notes.join(" · ")), ...warning,
	];
}
