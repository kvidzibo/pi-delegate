import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ArchivedRun, loadRuns } from "../archive.ts";
import { describeCapabilities } from "../capabilities.ts";
import { JobCards, CARD_STATE_TYPE } from "../cards.ts";
import { JobScheduler } from "../jobs.ts";
import { FileCapacityBroker } from "../capacity.ts";
import type { FinalizationProgress } from "../../child-runtime/guard-protocol.ts";

test("capability snapshots coexist with headroom history and guarded-calibration invalidation on rebuild", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "delegate-combined-metadata-")); t.after(() => rmSync(root, { recursive: true, force: true }));
	const prompt = join(root, "source.md"); writeFileSync(prompt, "Owned offline fixture");
	const capabilities = describeCapabilities(["read", "bash"]);
	const finalization: FinalizationProgress = { phase: "answering", reason: "context_budget", activeTools: 0,
		headroom: { policyId: "a".repeat(64), phase: "limited", limited: true, clippedToolResults: 1 } };
	const run = new ArchivedRun(root, { parentSessionId: "parent", toolCallId: "call", kind: "recon", cwd: root,
		requestedModel: "mock/model", thinking: "off", tools: ["read", "bash"], capabilities }, "Task", prompt);
	run.start("d0001"); await run.finish({ status: "failed", stopReason: "context_budget", exitCode: 0, finalization });
	const metadata = { ...JSON.parse(readFileSync(run.paths.metadata, "utf8")), savingsUnavailable: "legacy reason" };
	writeFileSync(run.paths.metadata, JSON.stringify(metadata));
	const before = readFileSync(run.paths.metadata, "utf8"), loaded = await loadRuns(root, { rebuild: true });
	assert.equal(loaded.warnings.length, 0); assert.deepEqual(loaded.runs[0].capabilities, capabilities);
	assert.deepEqual(loaded.runs[0].finalization, finalization);
	assert.match(loaded.runs[0].savingsUnavailable!, /Legacy calibration does not cover guarded execution/);
	assert.equal(readFileSync(run.paths.metadata, "utf8"), before, "rebuild must not overwrite another owner's metadata");
	const exported = JSON.parse(readFileSync(join(root, "usage.jsonl"), "utf8").trim().split("\n").at(-1)!);
	assert.deepEqual(exported.capabilities, capabilities); assert.deepEqual(exported.finalization, finalization);
});

test("combined scheduler/card snapshots detach capabilities, resource state and nested headroom", { skip: process.platform !== "linux" }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "delegate-combined-cards-"));
	const scheduler = new JobScheduler({ maxConcurrent: 1, maxLocalConcurrent: 1, maxQueued: 1, capacity: new FileCapacityBroker(join(root, "capacity")) });
	let finish!: () => void; const pending = new Promise<void>(resolve => { finish = resolve; });
	t.after(async () => { finish(); await scheduler.shutdown(); rmSync(root, { recursive: true, force: true }); });
	const finalization: FinalizationProgress = { phase: "answering", reason: "context_budget", activeTools: 0,
		headroom: { policyId: "a".repeat(64), phase: "limited", limited: true } };
	const capabilities = describeCapabilities(["read", "bash"]);
	const job = scheduler.enqueue({ kind: "recon", model: "mock/model", local: true, task: "Owned offline metadata fixture", timeoutMs: 1000,
		capabilities, resourceGroup: { key: "offline-fixture", capacity: 1 }, run: async (_handle, _signal, onEvent) => {
			onEvent({ type: "delegate_finalization", state: finalization }); await pending;
			return { text: "Evidence", exitCode: 0, stderrTail: "", stopReason: "context_budget", finalization };
		} });
	const snapshot = scheduler.get(job.id), cards = new JobCards();
	assert.equal(snapshot.resource?.state, "held");
	const saved = { ...snapshot, originToolCallId: "restored" };
	cards.restore([{ type: "custom", customType: CARD_STATE_TYPE, data: saved }]);
	saved.finalization!.headroom!.limited = false; saved.resource!.state = "released"; saved.capabilities!.tools.length = 0;
	const row = cards.get("restored")!;
	assert.deepEqual(row.capabilities, capabilities); assert.deepEqual(row.finalization, finalization);
	assert.equal((row.resource as { state: string }).state, "held");
	(row.finalization as FinalizationProgress).headroom!.limited = false;
	(row.resource as { state: string }).state = "released";
	assert.deepEqual(cards.get("restored")!.finalization, finalization);
	assert.equal((cards.get("restored")!.resource as { state: string }).state, "held");
	assert.deepEqual(scheduler.get(job.id).finalization, finalization); assert.equal(scheduler.get(job.id).resource?.state, "held");
	finish(); const terminal = await scheduler.wait(job.id); assert.equal(terminal.resource?.state, "released");
});
