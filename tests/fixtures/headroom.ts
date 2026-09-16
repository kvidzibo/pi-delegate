import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runPiChild, type ChildResult } from "../../child-runtime/spawn.ts";
import { FileCapacityBroker } from "../../delegate/capacity.ts";
import { JobScheduler } from "../../delegate/jobs.ts";
import { jsonBytes } from "../../child-runtime/headroom.ts";
import { buildChildArgs, buildChildEnv } from "../../delegate/spawn.ts";

export async function headroomProbe(ctx: ExtensionCommandContext) {
	const policy = { maxInputBytes: 65536, maxToolResultBytes: 512, maxToolBatchBytes: 768, reserveTokens: 4096 };
	const fixture = fileURLToPath(new URL("./headroom-child.ts", import.meta.url));
	const model = "headroom-fixture/offline";
	for (const mode of ["clip", "refuse", "compact"]) {
		const log = join(ctx.cwd, `headroom-${mode}-http.jsonl`), sessionFile = join(ctx.cwd, `headroom-${mode}-session.jsonl`);
		const prompt = join(ctx.cwd, `headroom-${mode}-prompt.md`), file = join(ctx.cwd, `headroom-${mode}-evidence.txt`);
		const evidence = "Native evidence must remain unchanged.\n".repeat(500);
		writeFileSync(file, evidence); writeFileSync(prompt, "Isolated offline fixture. No real model requests."); writeFileSync(log, "");
		const capacity = new FileCapacityBroker(join(ctx.cwd, "headroom-capacity")), resourceGroup = { key: "offline-fixture", capacity: 1 };
		const scheduler = new JobScheduler({ maxConcurrent: 1, maxLocalConcurrent: 1, maxQueued: 1, capacity });
		let result: ChildResult | undefined;
		try {
			const job = scheduler.enqueue({ kind: "recon", model, local: true, resourceGroup, task: "Offline fixture", timeoutMs: 1000,
				run: async (handle, signal, onEvent, onControl) => {
					assert.ok(handle.resourceLease, "scheduler must forward its borrowed lease");
					result = await runPiChild({ cwd: ctx.cwd, model, task: "Offline fixture", hardTimeoutMs: 15000, maxOutputBytes: 65536,
						resourceLease: handle.resourceLease, signal, onEvent, onControl,
						promptSourcePath: prompt, env: buildChildEnv({ ...process.env, PI_HEADROOM_TEST_MODE: mode, PI_HEADROOM_TEST_LOG: log, PI_HEADROOM_TEST_FILE: file }),
						buildArgs: promptPath => [...buildChildArgs({ model, thinking: "off", tools: ["read"], promptPath, sessionFile, offline: true }), "--extension", fixture],
						execution: { tools: ["read"], finalizeAfterMs: 0, finalizationGraceMs: 12000, startupTimeoutMs: 12000, headroom: policy },
						// Test cleanup signals only this owned live process; no delayed PID/group signals.
						killTree: proc => { if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGTERM"); },
					});
					const competing = capacity.tryAcquire(resourceGroup);
					try { assert.equal(competing, undefined, "context refusal must not close the scheduler's borrowed descriptor"); }
					finally { competing?.release(); }
					return result;
				},
			});
			const terminal = await scheduler.wait(job.id, { timeoutMs: 18000 });
			assert.equal(terminal.status, "failed", JSON.stringify(terminal));
			assert.equal(terminal.stopReason, "context_budget"); assert.equal(terminal.resource?.state, "released");
			const next = capacity.tryAcquire(resourceGroup); assert.ok(next, "runner closure releases shared capacity"); next.release();
		} finally { await scheduler.shutdown(); }
		assert.ok(result);
		const requests = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
		assert.equal(result.stopReason, "context_budget", JSON.stringify({ result, requests: requests.length }));
		const native = readFileSync(sessionFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
		const tool = native.find(entry => entry.message?.role === "toolResult");
		assert.ok(tool, "native tool evidence must be recorded before shaping/refusal");
		assert.ok(tool.message.content.some((part: any) => part.type === "text" && part.text.includes(evidence.trim())), "full native text preserved");
		if (mode !== "clip") {
			assert.match(result.text, /Initial findings/);
			assert.equal(requests.length, 1, "neither unsafe task input nor implicit compaction may reach mocked HTTP");
			assert.equal(result.finalization?.headroom?.phase, "refused");
			if (mode === "compact") {
				assert.ok(existsSync(`${log}.compaction`), "real Pi must enter the compaction hook");
				assert.equal(native.some(entry => entry.type === "compaction"), false, "cancelled compaction must not rewrite native context");
			}
		} else {
			assert.ok(requests.length >= 2 && requests.length <= 4);
			assert.match(result.text, /Task response.*\nFinal evidence report/s);
			assert.match(result.text, /Wrap-up 1.*\nFinal evidence report/s);
			assert.equal(result.finalization?.phase, "answering");
			for (const request of requests.slice(1)) {
				const output = request.messages.find((row: any) => row.role === "tool");
				assert.ok(output); assert.ok(jsonBytes(output.content) <= policy.maxToolResultBytes);
				assert.match(output.content, /shortened for context/);
			}
		}
	}
	return { nativeTransportBoundary: true, unsafeDispatchBlocked: true, compactionBlocked: true, sharedCapacity: true,
		priorReportPreserved: true, nativeEvidencePreserved: true, noModelCalls: true };
}
