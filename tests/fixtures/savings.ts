import assert from "node:assert/strict";
import { getAgentDir, SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import delegate from "../../delegate/index.ts";
import { fingerprint } from "../../delegate/calibration.ts";
import { savings, pricing } from "../../delegate/tests/calibration-fixtures.ts";

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
		} }, ui: { ...ctx.ui, setStatus: (_k: string, text: string) => statuses.push(text), notify: (text: string) => notices.push(text), select: async (report: string) => { notices.push(report); return undefined; } } };
		await handlers.get("session_start")!({}, testCtx);
		const result = await tool.execute("pricing-probe", { task: "Mock recon", kind: "recon" }, undefined, undefined, testCtx);
		assert.equal(result.details.ok, true); assert.equal(lookups, 1);
		assert.match(statuses.at(-1)!, /^⑂ 220\|100%\|~<\$0.001$/);
		const entriesBefore = ctx.sessionManager.getEntries().length;
		await commands.get("pi-delegate").handler("stats rebuild", testCtx);
		assert.ok(notices.at(-1)?.includes("Prompt/output ratios 0.500/0.500"));
		assert.equal(ctx.sessionManager.getEntries().length, entriesBefore);
		await handlers.get("session_start")!({}, testCtx); assert.match(statuses.at(-1)!, /^⑂ 220\|100%\|~<\$0.001$/);
		await handlers.get("session_shutdown")!();
		return { calibrated: true, snapshot: true, rebuild: true, noModelCalls: true };
	} finally {
		if (previous === undefined) delete process.env.PI_DELEGATE_SKIP_USER_CONFIG; else process.env.PI_DELEGATE_SKIP_USER_CONFIG = previous;
		rmSync(configPath, { force: true });
	}
}
