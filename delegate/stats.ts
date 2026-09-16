import { addTokens, emptyUsage, totalTokens, type UsageSummary } from "./usage.ts";
import { runPaths, type RunRecord } from "./archive.ts";
import { validSnapshot, validEstimate } from "./calibration.ts";
import { isLocalModel } from "./tg.ts";
import { copyOutcome } from "./outcomes.ts";

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
export function savingsTotals(runs: RunRecord[]): { usd: number; priced: number; eligible: number } {
	let usd = 0, priced = 0, eligible = 0;
	for (const run of latestRuns(runs)) {
		if (run.status !== "done" || !(run.usage.local.total > 0 || isLocalModel(run.requestedModel))) continue;
		eligible++;
		const estimate = run.usage.estimate;
		if (run.finalization !== undefined || run.status !== "done" || run.usage.incomplete || run.recordingError || !validSnapshot(run.savings)
			|| !validEstimate(estimate) || estimate.requests < 1 || estimate.unpriced) continue;
		usd += estimate.usd; priced++;
	}
	return { usd, priced, eligible };
}
export const formatUsd = (usd: number): string => usd > 0 && usd < 0.001 ? "<$0.001" : `$${usd.toFixed(usd < 1 ? 3 : 2)}`;
export function infobar(runs: RunRecord[], warning = false, archiveWarning = false): string {
	const usage = summarize(runs), savings = savingsTotals(runs);
	const saved = savings.priced ? `~${formatUsd(savings.usd)}${savings.priced < savings.eligible ? " · !estimate" : ""}` : "—";
	return `delegated ${formatTokens(totalTokens(usage))} · local ${formatTokens(usage.local.total)} · saved ${saved}${usage.incomplete || warning ? " · !partial" : ""}${archiveWarning ? " · !archive" : ""}`;
}
export function statsReport(runs: RunRecord[], root: string, scope: string, warnings: string[] = []): string {
	runs = latestRuns(runs);
	const usage = summarize(runs), savings = savingsTotals(runs);
	const counts = (bucket: UsageSummary["local"]) => `${bucket.total.toLocaleString("en-US")} (input ${bucket.input}, output ${bucket.output}, cache read ${bucket.cacheRead}, cache write ${bucket.cacheWrite})`;
	const pending = runs.filter((run) => run.status === "queued" || run.status === "running").length;
	const incomplete = runs.filter((run) => run.usage.incomplete || run.recordingError || run.status === "running" || run.status === "queued").length;
	const outcomes = runs.flatMap(run => { const outcome = copyOutcome(run.outcome); return outcome ? [outcome] : []; });
	const lines = [
		`Delegate usage — ${scope}`,
		`Delegated: ${totalTokens(usage).toLocaleString("en-US")} tokens`,
		`Local: ${counts(usage.local)}`, `Hosted: ${counts(usage.hosted)}`,
		`Runs: ${runs.length}; done ${runs.filter((r) => r.status === "done").length}; failed ${runs.filter((r) => r.status === "failed").length}; queued/running ${pending}; incomplete ${incomplete}`,
		`Runtime outcomes: ${outcomes.length} recorded; ${runs.length - outcomes.length} missing/legacy; limited ${outcomes.filter(outcome => outcome.execution === "limited").length}; unsettled responses ${outcomes.filter(outcome => outcome.responses === "unsettled").length}.`,
		"Task correctness is not assessed by delegate. Done means worker completion, not verified task success.",
		`Reported usage records: ${usage.reported}; missing usage records: ${usage.missing}; completed runtime: ${(runs.reduce((n, r) => n + r.durationMs, 0) / 1000).toFixed(1)}s`,
		savings.priced ? `Saved: ~${formatUsd(savings.usd)} API-equivalent estimate; ${savings.priced}/${savings.eligible} eligible local runs priced.`
			: "Saved: unavailable — requires matching calibration and known alternative API prices.",
		"Savings price a calibrated cloud-child alternative, not parent-only execution or a subscription refund. Only complete local runs with successful worker status count; task quality is not verified. Failures remain in usage/outcomes. !estimate means partial estimate coverage, not a confidence bound.",
		"Calibration is a successful-pair heuristic; model behavior, cache use and request-size tiers may differ in production. No electricity/hardware costs are subtracted.",
		"Input/output/cache buckets are summed once; reasoning is included in output. Unfinished/incomplete figures are known lower bounds.",
		"Today groups runs by launch date in local time. Recorded runs only; pre-install usage cannot be recovered.",
		`Archive: ${root} (retained indefinitely; no automatic deletion)`,
	];
	if (warnings.length) lines.push(`Recording warnings (${warnings.length}):`, ...warnings.slice(0, 10));
	const recent = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 10);
	if (recent.length) lines.push("Latest runs (full history remains in the archive):");
	for (const run of recent) {
		lines.push(`${run.jobId ?? "queued"} ${run.kind} ${run.actualModel ?? run.requestedModel} ${run.status} ${totalTokens(run.usage)} tokens${run.usage.incomplete ? " (partial)" : ""}`);
		const outcome = copyOutcome(run.outcome);
		if (outcome) lines.push(`  Worker: ${outcome.execution}; response lifecycle: ${outcome.responses}${outcome.limitations.length ? `; limitations: ${outcome.limitations.join(", ")}` : ""}`);
		lines.push(`  ${runPaths(root, run.runId).session}`);
		if (run.recordingError) lines.push(`  ${run.recordingError}`);
		if (run.savingsUnavailable) lines.push(`  Savings unavailable: ${run.savingsUnavailable}`);
		if (validSnapshot(run.savings)) {
			const p = run.savings.profile;
			lines.push(`  Reference: ${p.key.alternativeModel} (${p.key.alternativeThinking}); calibration ${p.createdAt}, ${p.acceptedPairs}/${p.pairs} pairs, failures local/alternative ${p.localFailures}/${p.alternativeFailures}, incomplete ${p.incompletePairs}`);
			lines.push(`  Prompt/output ratios ${p.promptRatio.toFixed(3)}/${p.outputRatio.toFixed(3)}; observed total-ratio range ${p.totalRatioRange.map(n => n.toFixed(3)).join("–")}; API cache-read/write shares ${p.cacheReadShare.toFixed(3)}/${p.cacheWriteShare.toFixed(3)}; rates captured ${run.savings.pricedAt}`);
		}
	}
	return lines.map(displayText).join("\n");
}
