import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import delegate from "../../delegate/index.ts";
import { FileCapacityBroker } from "../../delegate/capacity.ts";
import { runPiChild } from "../../child-runtime/spawn.ts";
import { buildChildArgs, buildChildEnv, type RunChildInput } from "../../delegate/spawn.ts";
import { LEASE_NOTICE } from "../../child-runtime/lease-startup.ts";

/** Production factory wiring plus a real offline lease-only child; no model requests. */
export async function sharedCapacityProbe(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
	const starts: RunChildInput[] = [], cleanups: Function[] = [];
	let release!: () => void;
	const testCtx = { ...ctx, hasUI: false, isIdle: () => false };
	const factory = () => {
		let tool: any;
		const handlers = new Map<string, Function>();
		delegate({ ...pi, registerTool: (value: unknown) => { tool = value; }, registerCommand: () => {}, registerMessageRenderer: () => {},
			on: (event: string, handler: Function) => { handlers.set(event, handler); },
		} as ExtensionAPI, async input => {
			starts.push(input);
			if (input.task === "hold") await new Promise<void>(resolve => { release = resolve; input.signal?.addEventListener("abort", () => resolve(), { once: true }); });
			return { text: "mock evidence", exitCode: 0, stopReason: "stop", stderrTail: "" };
		});
		cleanups.push(() => handlers.get("session_shutdown")?.());
		return (params: unknown) => tool.execute(`capacity-${Math.random()}`, params, undefined, undefined, testCtx);
	};
	const a = factory(), b = factory();
	try {
		const first = await a({ kind: "recon", task: "hold", background: true });
		assert.ok(starts[0].resourceLease); assert.equal(starts[0].leaseStartupMs, 15000);
		assert.equal(starts[0].execution, undefined, "shared capacity must not enable finalization deadlines");
		const second = await b({ kind: "recon", model: "ollama/other", task: "wait", background: true });
		assert.equal(second.details.status, "queued"); assert.equal(second.details.reason, "resource");
		assert.match(second.content[0].text, /shared resource/);
		const hosted = await b({ kind: "recon", model: "hosted/test", task: "hosted" });
		assert.equal(hosted.details.ok, true); assert.equal(starts.length, 2);
		assert.equal(starts[1].resourceLease, undefined); assert.equal(starts[1].leaseStartupMs, undefined);
		release(); await a({ jobId: first.details.jobId });
		assert.equal((await b({ jobId: second.details.jobId })).details.status, "done");
		assert.ok(starts[2].resourceLease);
	} finally { release?.(); await Promise.all(cleanups.map(fn => fn())); }

	const broker = new FileCapacityBroker(join(ctx.cwd, "lease-only-state")), group = { key: "offline", capacity: 1 };
	const lease = broker.tryAcquire(group)!;
	const prompt = join(ctx.cwd, "lease-only-prompt.md"); writeFileSync(prompt, "Offline startup fixture.");
	let acknowledged = false;
	try {
		const model = "openai-codex/gpt-5.6-luna";
		const result = await runPiChild({ cwd: ctx.cwd, model, task: "MUST NOT BE SENT", promptSourcePath: prompt,
			hardTimeoutMs: 10000, maxOutputBytes: 4096, env: buildChildEnv({ ...process.env, PI_OFFLINE: "1" }), resourceLease: lease.inherited, leaseStartupMs: 8000,
			buildArgs: promptPath => buildChildArgs({ model, thinking: "off", tools: ["read", "bash"], promptPath,
				sessionFile: join(ctx.cwd, "lease-only-session.jsonl") }),
			onEvent: (event: any) => { if (event.type === "extension_ui_request" && event.method === "notify") {
				try { acknowledged ||= JSON.parse(event.message).type === LEASE_NOTICE; } catch { /* unrelated notice */ }
			} },
			beforePrompt: async () => {
				assert.ok(acknowledged);
				lease.release();
				const available = broker.tryAcquire(group); available?.release();
				assert.equal(available, undefined, "real child retains occupancy after parent descriptor closes");
				throw new Error("offline lease check complete");
			},
		});
		assert.match(result.text, /offline lease check complete/);
		assert.equal(result.evidence?.taskSent, false); assert.equal(result.finalization, undefined);
		assert.equal(result.diag?.sawAssistant, false);
	} finally { lease.release(); }
	const available = broker.tryAcquire(group); assert.ok(available); available.release();
	return { sharedFactories: true, hostedBypass: true, leaseOnlyStartup: true, inheritedOccupancy: true, noModelCalls: true };
}
