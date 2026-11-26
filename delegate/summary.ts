import type { RunRecord } from "./archive.ts";
import { formatDuration, type ThemeFg } from "./display.ts";
import { displayText, formatTokens, latestRuns } from "./stats.ts";
import { totalTokens } from "./usage.ts";

/** Custom session entry: shown in the transcript, never sent to the model. */
export const SUMMARY_ENTRY_TYPE = "delegate-summary";
const STATUSES = ["done", "failed", "running", "queued"] as const;
type Status = typeof STATUSES[number];
export type SummaryRow = { jobId?: string; kind: string; model: string; reasoning: string; status: Status; durationMs?: number; tokens?: number; live?: boolean };
export type SessionSummary = { sessionId: string; rows: SummaryRow[] };

/**
 * Snapshot one parent session's runs in launch order, the order the live panel lists jobs.
 * `jobIds` supplies scheduler IDs for queued runs, whose archives record a job ID only when started.
 */
export function summarizeSession(runs: RunRecord[], sessionId: string, options: { active: ReadonlySet<string>; jobIds?: ReadonlyMap<string, string>; now?: number }): SessionSummary {
	const now = options.now ?? Date.now();
	const rows = latestRuns(runs).filter(run => run.parentSessionId === sessionId)
		.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
		.map((run): SummaryRow => {
			// Only this process's running jobs are measurably live; stale on-disk "running" rows show no duration.
			const live = options.active.has(run.runId) && run.status === "running";
			const jobId = run.jobId ?? options.jobIds?.get(run.runId);
			const started = run.startedAt ? Date.parse(run.startedAt) : NaN;
			const durationMs = run.finishedAt ? run.durationMs : live && Number.isFinite(started) ? Math.max(0, now - started) : undefined;
			return {
				...(jobId ? { jobId } : {}), kind: run.kind, model: run.actualModel ?? run.requestedModel,
				reasoning: run.thinking, status: run.status, ...(durationMs === undefined ? {} : { durationMs }),
				...(run.startedAt ? { tokens: totalTokens(run.usage) } : {}), ...(live ? { live } : {}),
			};
		});
	return { sessionId, rows };
}

// Unit tests run without Pi peer packages; table cells are single-width text.
const visibleWidth = (text: string): number => [...text].length;
const count = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Session entries are persisted data: accept only the shape this module writes. */
export function copySummary(value: unknown): SessionSummary | undefined {
	const data = value as Partial<SessionSummary> | undefined;
	if (!data || typeof data.sessionId !== "string" || !Array.isArray(data.rows)) return undefined;
	const rows: SummaryRow[] = [];
	for (const row of data.rows as Array<Partial<SummaryRow>>) {
		if (!row || typeof row.kind !== "string" || typeof row.model !== "string" || typeof row.reasoning !== "string"
			|| !STATUSES.includes(row.status as Status) || (row.jobId !== undefined && typeof row.jobId !== "string")
			|| (row.durationMs !== undefined && !count(row.durationMs)) || (row.tokens !== undefined && !count(row.tokens))) return undefined;
		rows.push({ ...(row.jobId ? { jobId: row.jobId } : {}), kind: row.kind, model: row.model, reasoning: row.reasoning, status: row.status as Status,
			...(row.durationMs === undefined ? {} : { durationMs: row.durationMs }), ...(row.tokens === undefined ? {} : { tokens: row.tokens }),
			...(row.live === true ? { live: true } : {}) });
	}
	return { sessionId: data.sessionId, rows };
}

const STATUS_COLOR: Record<Status, string> = { done: "success", failed: "error", running: "warning", queued: "muted" };
const HEADER = ["#", "Job", "Role", "Model", "Reasoning", "Status", "Duration", "Tokens"];
const RIGHT = new Set([0, 6, 7]);

export function summaryLines(summary: SessionSummary, theme: ThemeFg): string[] {
	const title = `${theme.fg("customMessageLabel", theme.bold("[delegate summary]"))} ${theme.fg("muted", `· session ${displayText(summary.sessionId.slice(0, 8))} · not sent to model`)}`;
	if (!summary.rows.length) return [title, "", "No delegate runs in this session yet."];
	const live = (row: SummaryRow) => row.live ? "…" : "";
	const cells = summary.rows.map((row, index) => [String(index + 1), row.jobId ?? "—", row.kind, row.model, row.reasoning, row.status,
		row.durationMs === undefined ? "—" : `${formatDuration(row.durationMs)}${live(row)}`,
		row.tokens === undefined ? "—" : `${formatTokens(row.tokens)}${live(row)}`].map(displayText));
	const anyLive = summary.rows.some(row => row.live) ? "…" : "";
	const timed = summary.rows.filter(row => row.durationMs !== undefined), counted = summary.rows.filter(row => row.tokens !== undefined);
	const totalTime = timed.length ? `${formatDuration(timed.reduce((sum, row) => sum + row.durationMs!, 0))}${anyLive}` : "—";
	const totalTokens = counted.length ? `${formatTokens(counted.reduce((sum, row) => sum + row.tokens!, 0))}${anyLive}` : "—";
	const widths = HEADER.map((name, column) => Math.max(visibleWidth(name), ...cells.map(row => visibleWidth(row[column])),
		column === 6 ? visibleWidth(totalTime) : column === 7 ? visibleWidth(totalTokens) : 0));
	const pad = (text: string, column: number) => {
		const space = " ".repeat(Math.max(0, widths[column] - visibleWidth(text)));
		return RIGHT.has(column) ? space + text : text + space;
	};
	const join = (values: string[]) => values.join("  ");
	const tableWidth = widths.reduce((sum, width) => sum + width, 0) + 2 * (widths.length - 1);
	const rule = theme.fg("dim", "─".repeat(tableWidth));
	const statusCounts = STATUSES.map(status => [status, summary.rows.filter(row => row.status === status).length] as const)
		.filter(([, n]) => n > 0).map(([status, n]) => `${n} ${status}`);
	const runs = `${summary.rows.length} run${summary.rows.length === 1 ? "" : "s"} · ${statusCounts.join(" · ")}`;
	// Counts span the descriptive columns; totals stay right-aligned under Duration and Tokens.
	const lead = " ".repeat(widths[0] + 2) + runs;
	const durationStart = tableWidth - widths[7] - 2 - widths[6];
	const totals = `${theme.fg("muted", lead)}${" ".repeat(Math.max(2, durationStart - visibleWidth(lead)))}${theme.bold(`${pad(totalTime, 6)}  ${pad(totalTokens, 7)}`)}`;
	const notes = ["Launch order, as in the live panel"];
	if (anyLive) notes.push("… still running");
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
		rule, totals, "", theme.fg("dim", notes.join(" · ")),
	];
}
