import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import delegate from "../../delegate/index.ts";
import { LocalControl } from "../../delegate/local-control.ts";

/** Real factory, archive and native RPC picker; mock workers only. */
export async function localProbe(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
	assert.ok(pi.getCommands().some(c => c.name === "delegate-local"));
	const handlers = new Map<string, Function>(), commands = new Map<string, any>();
	let tool: any, finish!: () => void;
	const calls: string[] = [], notices: string[] = [];
	delegate({ ...pi,
		registerTool: (definition: unknown) => { tool = definition; },
		registerCommand: (name: string, command: unknown) => commands.set(name, command),
		registerMessageRenderer: () => {},
		on: (event: string, handler: Function) => { handlers.set(event, handler); },
	} as ExtensionAPI, async input => {
		calls.push(input.model);
		if (input.task === "hold") await new Promise<void>(r => { finish = r; input.signal?.addEventListener("abort", () => r(), { once: true }); });
		return { text: "mock complete", exitCode: 0, stderrTail: "" };
	});
	const localCtx = { ...ctx, isIdle: () => false, ui: { ...ctx.ui, notify: (text: string) => notices.push(text) } };
	const gate = new LocalControl(join(getAgentDir(), "delegate-local"));
	let seq = 0;
	const call = (params: unknown) => tool.execute(`local-probe-${++seq}`, params, undefined, undefined, localCtx);
	try {
		await handlers.get("session_start")?.({}, localCtx);
		const first = await call({ kind: "recon", task: "hold", background: true });
		const queued = await call({ kind: "recon", task: "queued", background: true });
		assert.equal(queued.details.status, "queued");
		assert.equal(gate.status().active, 1);
		await commands.get("delegate-local").handler("", localCtx); // native select -> Off
		assert.equal(gate.enabled(), false);
		assert.match(notices.at(-1)!, /OFF · draining 1 job/);
		const paused = await call({ jobId: queued.details.jobId, timeoutMs: 0 });
		assert.equal(paused.details.reason, "local-off");
		assert.match(paused.content[0].text, /Local delegation is OFF/);
		const runs = join(getAgentDir(), "delegate", "runs");
		const before = readdirSync(runs).length;
		const refused = await call({ kind: "review", task: "override", model: "ollama/test", background: true });
		assert.equal(refused.details.ok, false);
		assert.match(refused.content[0].text, /local delegation is OFF/);
		assert.equal(readdirSync(runs).length, before, "OFF refuses before recording/spawning");
		const hosted = await call({ kind: "recon", task: "hosted", model: "hosted/test" });
		assert.equal(hosted.details.ok, true);
		assert.equal(calls.length, 2, "no implicit hosted fallback");
		finish();
		await call({ jobId: first.details.jobId });
		await commands.get("delegate-local").handler("status", localCtx);
		assert.match(notices.at(-1)!, /OFF · idle/);
		await commands.get("delegate-local").handler("", localCtx); // native cancel
		assert.equal(gate.enabled(), false);
		await commands.get("delegate-local").handler("", localCtx); // native select -> On
		assert.equal(gate.enabled(), true);
		assert.equal((await call({ jobId: queued.details.jobId })).details.status, "done");
		assert.equal(gate.status().active, 0);
		return { picker: true, shared: true, draining: true, overridesBlocked: true, hostedUnchanged: true, noModelCalls: true };
	} finally {
		finish?.();
		await handlers.get("session_shutdown")?.();
		gate.setEnabled(true);
	}
}
