import assert from "node:assert/strict";
import { getAgentDir, SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { runPiChild } from "../../child-runtime/spawn.ts";
import { buildChildArgs, buildChildEnv } from "../../delegate/spawn.ts";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import delegate from "../../delegate/index.ts";
import benchmark from "../../bench/index.ts";
import { fingerprint } from "../../delegate/calibration.ts";
import { savings, pricing } from "../../delegate/tests/calibration-fixtures.ts";

export async function guardStartupProbe(ctx: ExtensionCommandContext) {
	const file = join(ctx.cwd, "guard-budget.json"), model = "openai-codex/gpt-5.6-luna";
	writeFileSync(file, JSON.stringify({ model, thinking: "low", tools: ["read"], local: false, budgetUsd: 0,
		maxRequests: 1, contextWindow: 1000, maxTokens: 100, pricing }));
	const prompt = join(ctx.cwd, "guard-prompt.md"); writeFileSync(prompt, "No prompt may be dispatched by this offline test.");
	let acknowledged = false;
	const result = await runPiChild({ cwd: ctx.cwd, model, task: "MUST NOT BE SENT", hardTimeoutMs: 10000, maxOutputBytes: 65536,
		promptSourcePath: prompt, env: buildChildEnv({ ...process.env, PI_DELEGATE_BENCH_BUDGET: file }),
		buildArgs: p => [...buildChildArgs({ model, thinking: "low", tools: ["read"], promptPath: p,
			sessionFile: join(ctx.cwd, "guard-session.jsonl"), offline: true }), "-e", fileURLToPath(new URL("../../bench/guard.ts", import.meta.url))],
		beforePrompt: async signal => {
			for (let i = 0; i < 200; i++) {
				signal.throwIfAborted();
				try { const state = JSON.parse(readFileSync(file + ".state", "utf8")); acknowledged = state.requests === 0 && !state.pending; } catch {}
				if (acknowledged) throw new Error("offline test stopped after guard acknowledgement");
				await delay(25, undefined, { signal });
			}
			throw new Error("guard not loaded");
		},
	});
	assert.equal(acknowledged, true, result.text);
	assert.match(result.text, /offline test stopped after guard acknowledgement/);
	assert.equal(JSON.parse(readFileSync(file + ".state", "utf8")).requests, 0);
	return { guardLoaded: true, promptWithheld: true, noModelCalls: true };
}

export async function savingsProbe(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
	const handlers = new Map<string, Function>(), commands = new Map<string, any>(); let tool: any;
	const s = savings();
	s.profile.key.tools = ["read", "grep", "find", "ls", "bash"];
	s.profile.key.promptHash = fingerprint(readFileSync(fileURLToPath(new URL("../../delegate/prompts/recon.md", import.meta.url)), "utf8"));
	const { keyId } = await import("../../delegate/calibration.ts"); s.profile.id = keyId(s.profile.key);
	const file = join(ctx.cwd, "profile.json"); writeFileSync(file, JSON.stringify(s.profile));
	const configPath = join(getAgentDir(), "delegate.json"); writeFileSync(configPath, JSON.stringify({ calibrationProfiles: [file] }));
	const previous = process.env.PI_DELEGATE_SKIP_USER_CONFIG;
	const api = { ...pi, registerTool: (t: any) => { tool = t; }, registerCommand: (name: string, command: any) => commands.set(name, command),
		registerMessageRenderer: () => {}, on: (event: string, handler: Function) => handlers.set(event, handler) } as unknown as ExtensionAPI;
	try {
		process.env.PI_DELEGATE_SKIP_USER_CONFIG = "0";
		delegate(api, async input => {
			const child = SessionManager.open(input.sessionFile);
			const m: any = { role: "assistant", api: "openai-completions", provider: "local-qwen38", model: "qwen38-q4km", content: [{ type: "text", text: "answer" }],
				timestamp: 1, stopReason: "stop", usage: { input: 100, output: 20, cacheRead: 100, cacheWrite: 0, totalTokens: 220, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			child.appendMessage(m); input.onEvent?.({ type: "message_end", message: m }); input.onEvent?.({ type: "agent_settled" });
			return { text: "answer", exitCode: 0, stderrTail: "", stopReason: "stop" };
		});
		const statuses: string[] = [], notices: string[] = []; let lookups = 0;
		const testCtx = { ...ctx, hasUI: true, modelRegistry: { find: (provider: string, id: string) => {
			lookups++; assert.equal(`${provider}/${id}`, s.profile.key.alternativeModel); return { cost: pricing };
		} }, ui: { ...ctx.ui, setStatus: (_k: string, text: string) => statuses.push(text), notify: (text: string) => notices.push(text) } };
		await handlers.get("session_start")!({}, testCtx);
		const result = await tool.execute("pricing-probe", { task: "Mock recon", kind: "recon" }, undefined, undefined, testCtx);
		assert.equal(result.details.ok, true); assert.equal(lookups, 1);
		assert.match(statuses.at(-1)!, /saved ~<\$0.001/);
		const entriesBefore = ctx.sessionManager.getEntries().length;
		await commands.get("delegate-stats").handler("rebuild", testCtx);
		assert.ok(notices.at(-1)?.includes("Prompt/output ratios 0.500/0.500"));
		assert.equal(ctx.sessionManager.getEntries().length, entriesBefore);
		await handlers.get("session_start")!({}, testCtx); assert.match(statuses.at(-1)!, /saved ~<\$0.001/);
		await handlers.get("session_shutdown")!();
		const benchCommands: string[] = [];
		benchmark({ ...api, registerCommand: (name: string) => benchCommands.push(name), on: () => {} } as ExtensionAPI);
		assert.deepEqual(benchCommands, ["delegate-calibrate-cancel", "delegate-calibrate"]);
		return { calibrated: true, snapshot: true, rebuild: true, noModelCalls: true, benchLoads: true };
	} finally {
		if (previous === undefined) delete process.env.PI_DELEGATE_SKIP_USER_CONFIG; else process.env.PI_DELEGATE_SKIP_USER_CONFIG = previous;
		rmSync(configPath, { force: true });
	}
}
