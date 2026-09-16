import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ArchivedRun, loadRuns } from "../archive.ts";
import { describeCapabilities } from "../capabilities.ts";
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
