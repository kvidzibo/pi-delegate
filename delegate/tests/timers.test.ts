import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { MAX_TIMER_MS, normalizeTimeoutMs } from "../../child-runtime/policy.ts";
import { runPiChild } from "../../child-runtime/spawn.ts";
import { parseDelegateConfig } from "../config.ts";
import { JobScheduler, parseDelegateCall } from "../jobs.ts";

test("timer bounds reject overflow before config, waits or unguarded spawning can arm a 1ms timer", async () => {
	const config = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8"));
	const max = { ...config, maxTimeoutMs: MAX_TIMER_MS };
	for (const field of ["defaultTimeoutMs", "maxTimeoutMs", "checkIntervalMs", "hardTimeoutMs"]) {
		assert.doesNotThrow(() => parseDelegateConfig({ ...max, [field]: MAX_TIMER_MS }, "test"));
		assert.throws(() => parseDelegateConfig({ ...max, [field]: MAX_TIMER_MS + 1 }, "test"), new RegExp(field));
	}
	assert.equal(normalizeTimeoutMs(MAX_TIMER_MS, max), MAX_TIMER_MS);
	assert.equal(normalizeTimeoutMs(2_000_000, config), config.maxTimeoutMs, "preserve supported spawn clamping");
	assert.doesNotThrow(() => parseDelegateCall({ jobId: "d0001", timeoutMs: MAX_TIMER_MS }, config));
	const scheduler = new JobScheduler({ maxConcurrent: 1, maxLocalConcurrent: 1, maxQueued: 1 });
	for (const value of [MAX_TIMER_MS + 1, Number.MAX_SAFE_INTEGER + 1, Infinity, 1.5]) {
		assert.throws(() => parseDelegateCall({ kind: "recon", task: "probe", timeoutMs: value }, config), /timeoutMs/);
		assert.throws(() => parseDelegateCall({ jobId: "d0001", timeoutMs: value }, config), /timeoutMs/);
		for (const field of ["timeoutMs", "quietMs"]) {
			await assert.rejects(scheduler.wait("d0001", { [field]: value }), /wait timers/);
		}
		await assert.rejects(runPiChild({ cwd: process.cwd(), model: "test/model", task: "probe", hardTimeoutMs: value,
			maxOutputBytes: 100, promptSourcePath: fileURLToPath(new URL("../prompts/recon.md", import.meta.url)), env: {},
			buildArgs: () => [], spawnFn: () => { throw new Error("must not spawn"); },
		}), /Invalid hardTimeoutMs/);
	}
	await scheduler.shutdown();
});
