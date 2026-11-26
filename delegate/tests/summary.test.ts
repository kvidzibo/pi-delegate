import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunRecord } from "../archive.ts";
import { plainBoardTheme } from "../board.ts";
import { copySummary, summarizeSession, summaryLines } from "../summary.ts";
import { emptyUsage } from "../usage.ts";

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
const run = (id: string, fields: Partial<RunRecord>): RunRecord => ({ version: 1, revision: 0, runId: id, parentSessionId: "session-1", toolCallId: id,
	kind: "review", cwd: "/", requestedModel: "p/requested-model-name", thinking: "high", tools: [], createdAt: at(0), status: "done", durationMs: 0, usage: emptyUsage(), ...fields });
const tokens = (n: number, extra: Partial<RunRecord["usage"]> = {}) => { const usage = { ...emptyUsage(), reported: 1, ...extra }; usage.hosted.total = n; return usage; };

test("session summary lists launch order with live, stale, queued, partial and restarted job rows", () => {
	const runs = [
		run("c", { createdAt: at(30), jobId: "d0001", kind: "oracle", actualModel: "p/actual", thinking: "xhigh", status: "running", startedAt: at(31), usage: tokens(96_300, { incomplete: true }) }),
		run("a", { createdAt: at(1), jobId: "d0001", kind: "implement", status: "done", startedAt: at(1), finishedAt: at(352), durationMs: 351_000, usage: tokens(1_167_531) }),
		{ ...run("a", { revision: -1, status: "running" }) },
		// Same launch millisecond, listed out of acceptance order: the scheduler sequence breaks the tie.
		run("f", { createdAt: at(5), jobId: "d0003", status: "failed", startedAt: at(5), finishedAt: at(6), durationMs: 1_000, usage: emptyUsage() }),
		run("b", { createdAt: at(5), jobId: "d0002", status: "failed", startedAt: at(5), finishedAt: at(10), durationMs: 5_000, usage: tokens(2_000, { incomplete: true }) }),
		run("d", { createdAt: at(40), status: "queued" }),
		run("e", { createdAt: at(50), jobId: "d0004", status: "running", startedAt: at(50), usage: { ...emptyUsage(), incomplete: true } }),
		// Cancelled mid-stream: no completed report, but the observed lower bound is kept.
		run("g", { createdAt: at(60), jobId: "d0005", status: "failed", startedAt: at(60), finishedAt: at(61), durationMs: 1_000, usage: tokens(120, { reported: 0, incomplete: true }) }),
		run("x", { parentSessionId: "other", createdAt: at(2) }),
	];
	runs[3].usage.missing = 1; runs[3].usage.incomplete = true;
	(runs[1] as any).actualModel = 42; // malformed optional archive field falls back to the requested model
	const summary = summarizeSession(runs, "session-1", { active: new Set(["c", "d"]), jobIds: new Map([["d", "d0002"]]), now: Date.parse(at(131)), warnings: 1 });
	assert.deepEqual(summary.rows.map(row => [row.jobId, row.status, row.model, row.durationMs, row.tokens, row.live, row.partial]), [
		["d0001", "done", "p/requested-model-name", 351_000, 1_167_531, undefined, undefined],
		["d0002", "failed", "p/requested-model-name", 5_000, 2_000, undefined, true],
		["d0003", "failed", "p/requested-model-name", 1_000, undefined, undefined, true],
		["d0001", "running", "p/actual", 100_000, 96_300, true, undefined],
		["d0002", "queued", "p/requested-model-name", undefined, undefined, undefined, undefined],
		["d0004", "running", "p/requested-model-name", undefined, undefined, undefined, true],
		["d0005", "failed", "p/requested-model-name", 1_000, 120, undefined, true],
	]);
	const lines = summaryLines(summary, plainBoardTheme);
	assert.match(lines[0], /\[delegate summary\] · session session- · not sent to model/);
	assert.match(lines[2], /^#  Job +Role +Model +Reasoning +Status +Duration +Tokens$/);
	assert.match(lines[5], /^2  d0002 .* failed +5s +2\.0k\+$/);
	assert.match(lines[6], /^3  d0003 .* failed +1s +—$/);
	assert.match(lines[7], /^4  d0001  oracle +p\/actual +xhigh +running +1m 40s… +96\.3k…$/);
	assert.match(lines[8], /^5  d0002  review .* queued +— +—$/);
	assert.match(lines[10], /^7  d0005 .* failed +1s +120\+$/);
	assert.match(lines[12], /7 runs · 1 done · 3 failed · 2 running · 1 queued +7m 38s… +1\.3m…$/);
	assert.equal(lines.at(-2), "Launch order, as in the live panel · … still running · + lower bound (incomplete records) · job IDs restart after reload or resume");
	assert.match(lines.at(-1)!, /^1 unreadable archive record; totals may be incomplete/);
	const width = (line: string) => [...line].length;
	assert.equal(new Set([lines[2], ...lines.slice(4, 11), lines[12]].map(width)).size, 1, "table rows and totals must align");

	// Counts that do not fit left of Duration move below the totals instead of pushing them out of their columns.
	const short = { kind: "r", requestedModel: "m", thinking: "off" };
	const narrow = summaryLines(summarizeSession([
		run("n1", { ...short, startedAt: at(0), finishedAt: at(1), durationMs: 1_000, usage: tokens(5) }),
		run("n2", { ...short, status: "failed", startedAt: at(0), finishedAt: at(1), durationMs: 1_000, usage: tokens(5) }),
		run("n3", { ...short, status: "running", startedAt: at(0), usage: tokens(5) }),
		run("n4", { ...short, status: "queued" }),
	], "session-1", { active: new Set() }), plainBoardTheme);
	assert.equal(width(narrow[9]), width(narrow[2]));
	assert.match(narrow[9], /^ +2s\+ +15$/, "a stale running run makes the time total a lower bound");
	assert.match(narrow[10], /4 runs · 1 done · 1 failed · 1 running · 1 queued/);

	assert.deepEqual(copySummary(JSON.parse(JSON.stringify(summary))), summary);
	for (const invalid of [undefined, {}, { ...summary, rows: [{ ...summary.rows[0], status: "lost" }] }, { ...summary, rows: [{ ...summary.rows[0], tokens: -1 }] }]) {
		assert.equal(copySummary(invalid), undefined);
	}
});
