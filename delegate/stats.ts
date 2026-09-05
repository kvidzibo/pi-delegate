import { addTokens, emptyUsage, totalTokens, type UsageSummary } from "./usage.ts";
import { runPaths, type RunRecord } from "./archive.ts";

export type StatsScope = "session" | "today" | "all";
export const displayText = (text: string): string => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}
export function inScope(run: Pick<RunRecord, "parentSessionId" | "createdAt">, scope: StatsScope, sessionId: string, now = new Date()): boolean {
	if (scope === "session") return run.parentSessionId === sessionId;
	if (scope === "all") return true;
	const start = new Date(now); start.setHours(0, 0, 0, 0);
	const end = new Date(start); end.setDate(end.getDate() + 1);
	const time = Date.parse(run.createdAt);
	return time >= start.getTime() && time < end.getTime();
}
export function latestRuns(runs: RunRecord[]): RunRecord[] {
	const latest = new Map<string, RunRecord>();
	for (const run of runs) if (run.revision >= (latest.get(run.runId)?.revision ?? -1)) latest.set(run.runId, run);
	return [...latest.values()];
}
export function summarize(runs: RunRecord[]): UsageSummary {
	const summary = emptyUsage();
	for (const run of latestRuns(runs)) {
		addTokens(summary.local, run.usage.local); addTokens(summary.hosted, run.usage.hosted);
		summary.reported += run.usage.reported; summary.missing += run.usage.missing;
		summary.incomplete ||= run.usage.incomplete || Boolean(run.recordingError) || run.status === "running" || run.status === "queued";
	}
	return summary;
}
export function infobar(runs: RunRecord[], warning = false, archiveWarning = false): string {
	const usage = summarize(runs);
	return `delegated ${formatTokens(totalTokens(usage))} · local ${formatTokens(usage.local.total)} · saved —${usage.incomplete || warning ? " · !partial" : ""}${archiveWarning ? " · !archive" : ""}`;
}
export function statsReport(runs: RunRecord[], root: string, scope: string, warnings: string[] = []): string {
	const usage = summarize(runs);
	const counts = (bucket: UsageSummary["local"]) => `${bucket.total.toLocaleString("en-US")} (input ${bucket.input}, output ${bucket.output}, cache read ${bucket.cacheRead}, cache write ${bucket.cacheWrite})`;
	const pending = runs.filter((run) => run.status === "queued" || run.status === "running").length;
	const incomplete = runs.filter((run) => run.usage.incomplete || run.recordingError || run.status === "running" || run.status === "queued").length;
	const lines = [
		`Delegate usage — ${scope}`,
		`Delegated: ${totalTokens(usage).toLocaleString("en-US")} tokens`,
		`Local: ${counts(usage.local)}`, `Hosted: ${counts(usage.hosted)}`,
		`Runs: ${runs.length}; done ${runs.filter((r) => r.status === "done").length}; failed ${runs.filter((r) => r.status === "failed").length}; queued/running ${pending}; incomplete ${incomplete}`,
		`Reported usage records: ${usage.reported}; missing usage records: ${usage.missing}; completed runtime: ${(runs.reduce((n, r) => n + r.durationMs, 0) / 1000).toFixed(1)}s`,
		"Saved: unavailable — requires a comparable cloud-only baseline. Local tokens are offloaded work, not net savings.",
		"Input/output/cache buckets are summed once; reasoning is included in output. Unfinished/incomplete figures are known lower bounds.",
		"Today groups runs by launch date in local time. Recorded runs only; pre-install usage cannot be recovered.",
		`Archive: ${root} (retained indefinitely; no automatic deletion)`,
	];
	if (warnings.length) lines.push(`Recording warnings (${warnings.length}):`, ...warnings.slice(0, 10));
	const recent = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 10);
	if (recent.length) lines.push("Latest runs (full history remains in the archive):");
	for (const run of recent) {
		lines.push(`${run.jobId ?? "queued"} ${run.kind} ${run.actualModel ?? run.requestedModel} ${run.status} ${totalTokens(run.usage)} tokens${run.usage.incomplete ? " (partial)" : ""}`);
		lines.push(`  ${runPaths(root, run.runId).session}`);
		if (run.recordingError) lines.push(`  ${run.recordingError}`);
	}
	return lines.map(displayText).join("\n");
}
