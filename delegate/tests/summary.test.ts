import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunRecord } from "../archive.ts";
import { plainBoardTheme } from "../board.ts";
import { copySummary, summarizeSession, summaryLines } from "../summary.ts";
import { emptyUsage } from "../usage.ts";

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
const run = (id: string, fields: Partial<RunRecord>): RunRecord => {
	const usage = emptyUsage();
	return { version: 1, revision: 0, runId: id, parentSessionId: "session-1", toolCallId: id, kind: "review", cwd: "/", requestedModel: "p/requested",
		thinking: "high", tools: [], createdAt: at(0), status: "done", durationMs: 0, usage, ...fields };
};
const tokens = (n: number) => { const usage = emptyUsage(); usage.hosted.total = n; return usage; };

test("session summary lists launch order with live, stale, queued and restarted job rows", () => {
	const runs = [
		run("c", { createdAt: at(30), jobId: "d0001", kind: "oracle", actualModel: "p/actual", thinking: "xhigh", status: "running", startedAt: at(31), usage: tokens(96_300) }),
		run("a", { createdAt: at(1), jobId: "d0001", kind: "implement", status: "done", startedAt: at(1), finishedAt: at(352), durationMs: 351_000, usage: tokens(1_167_531) }),
		{ ...run("a", { revision: -1, status: "running" }) },
		run("b", { createdAt: at(5), jobId: "d0002", status: "failed", startedAt: at(5), finishedAt: at(10), durationMs: 5_000, usage: tokens(2_000) }),
		run("d", { createdAt: at(40), status: "queued" }),
		run("e", { createdAt: at(50), jobId: "d0003", status: "running", startedAt: at(50) }),
		run("x", { parentSessionId: "other", createdAt: at(2) }),
	];
	const summary = summarizeSession(runs, "session-1", { active: new Set(["c", "d"]), jobIds: new Map([["d", "d0002"]]), now: Date.parse(at(131)) });
	assert.deepEqual(summary.rows.map(row => [row.jobId, row.status, row.model, row.durationMs, row.tokens, row.live]), [
		["d0001", "done", "p/requested", 351_000, 1_167_531, undefined],
		["d0002", "failed", "p/requested", 5_000, 2_000, undefined],
		["d0001", "running", "p/actual", 100_000, 96_300, true],
		["d0002", "queued", "p/requested", undefined, undefined, undefined],
		["d0003", "running", "p/requested", undefined, 0, undefined],
	]);
	const lines = summaryLines(summary, plainBoardTheme);
	assert.match(lines[0], /\[delegate summary\] · session session- · not sent to model/);
	assert.match(lines[2], /^#  Job +Role +Model +Reasoning +Status +Duration +Tokens$/);
	assert.match(lines[6], /^3  d0001  oracle +p\/actual +xhigh +running +1m 40s… +96\.3k…$/);
	assert.match(lines[7], /^4  d0002  review .* queued +— +—$/);
	assert.match(lines[10], /5 runs · 1 done · 1 failed · 2 running · 1 queued +7m 36s… +1\.3m…$/);
	assert.equal(lines.at(-1), "Launch order, as in the live panel · … still running · job IDs restart after reload or resume");
	const widths = [lines[2], ...lines.slice(4, 9), lines[10]].map(line => [...line].length);
	assert.equal(new Set(widths).size, 1, "table rows and totals must align");

	assert.deepEqual(copySummary(JSON.parse(JSON.stringify(summary))), summary);
	for (const invalid of [undefined, {}, { ...summary, rows: [{ ...summary.rows[0], status: "lost" }] }, { ...summary, rows: [{ ...summary.rows[0], tokens: -1 }] }]) {
		assert.equal(copySummary(invalid), undefined);
	}
});
