import assert from "node:assert/strict";
import { getAgentDir, SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { ArchivedRun, archiveRoot } from "../../delegate/archive.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import delegate from "../../delegate/index.ts";
import { cardProbe } from "./cards.ts";

export default function probe(pi: ExtensionAPI) {
	const register = (name: string, run: (ctx: ExtensionCommandContext) => unknown | Promise<unknown>) => {
		pi.registerCommand(name, {
			description: "Offline package test; no model requests",
			handler: async (_args, ctx) => {
				try {
					const result = await run(ctx);
					ctx.ui.notify(JSON.stringify({ type: "delegate_test_probe", command: name, result }), "info");
				} catch (error) {
					ctx.ui.notify(JSON.stringify({ type: "delegate_test_probe", command: name, error: String(error) }), "error");
				}
			},
		});
	};
	register("delegate-card-probe", (ctx) => cardProbe(pi, ctx));
	register("delegate-load-probe", () => {
		const tools = pi.getAllTools().filter((tool) => tool.sourceInfo.source !== "builtin");
		assert.deepEqual(tools.map((tool) => tool.name), ["delegate"]);
		return { tools: tools.map((tool) => tool.name) };
	});
	register("delegate-accounting-probe", async (ctx) => {
		assert.ok(pi.getCommands().some((c) => c.name === "delegate-stats"));
		const prompt = join(ctx.cwd, "probe-prompt.md"); writeFileSync(prompt, "Probe custom prompt");
		const archive = new ArchivedRun(archiveRoot(getAgentDir()), {
			parentSessionId: ctx.sessionManager.getSessionId(), parentSessionFile: ctx.sessionManager.getSessionFile(),
			toolCallId: "probe", kind: "recon", cwd: ctx.cwd, requestedModel: "local-qwen38/qwen38-q4km", thinking: "off", tools: ["read"],
		}, "probe task", prompt);
		archive.start("d0001");
		// Real native Pi session writer, no provider/model call. This verifies the header and CLI --session format.
		const child = SessionManager.open(archive.paths.session);
		assert.equal(child.getSessionId(), archive.data.runId);
		const message: any = { role: "assistant", api: "openai-completions", provider: "local-qwen38", model: "qwen38-q4km", content: [{ type: "text", text: "answer" }], timestamp: 1, stopReason: "stop", usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 5, totalTokens: 155, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		child.appendMessage(message); archive.observe({ type: "message_end", message }); archive.observe({ type: "agent_settled" });
		await archive.finish({ status: "done", stopReason: "stop", exitCode: 0 });
		const handlers = new Map<string, Function>(); const commands = new Map<string, any>();
		delegate({ ...pi, registerTool: () => {}, registerMessageRenderer: () => {}, registerCommand: (name: string, command: any) => commands.set(name, command), on: (event: string, fn: Function) => handlers.set(event, fn) } as unknown as ExtensionAPI);
		const statuses: Array<string | undefined> = []; const notices: string[] = [];
		const testCtx: any = { ...ctx, hasUI: true, ui: { ...ctx.ui,
			setStatus: (key: string, text: string | undefined) => { statuses.push(text); ctx.ui.setStatus(key, text); },
			notify: (text: string) => notices.push(text),
		} };
		const entriesBefore = ctx.sessionManager.getEntries().length;
		await handlers.get("session_start")?.({}, testCtx);
		assert.equal(statuses.at(-1), "delegated 155 · local 155 · saved —");
		await commands.get("delegate-stats").handler("", testCtx);
		assert.ok(notices.at(-1)?.includes("Delegated: 155 tokens"));
		assert.ok(notices.at(-1)?.includes("Saved: unavailable"));
		assert.equal(ctx.sessionManager.getEntries().length, entriesBefore, "stats must not inject model context");
		await handlers.get("session_start")?.({}, { ...testCtx, sessionManager: { getSessionId: () => "another-session" } });
		assert.equal(statuses.at(-1), "delegated 0 · local 0 · saved —");
		await handlers.get("session_start")?.({}, testCtx);
		assert.equal(statuses.at(-1), "delegated 155 · local 155 · saved —");
		await handlers.get("session_shutdown")?.(); assert.equal(statuses.at(-1), undefined);
		return { nativeSession: true, infobar: true, noModelCalls: true, resume: true };
	});
	register("delegate-view-probe", async () => {
		// Capture the real factory's tool and event handlers. Never spawn a delegate.
		let tool: any;
		const handlers = new Map<string, Function>();
		delegate({
			...pi,
			registerTool: (definition: unknown) => { tool = definition; },
			on: (event: string, handler: Function) => { handlers.set(event, handler); },
			registerMessageRenderer: () => {},
			registerCommand: () => {},
		} as ExtensionAPI);
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text, italic: (text: string) => text };
		const result = await tool.execute("invalid", { jobId: "missing" }, undefined, undefined, { cwd: process.cwd(), hasUI: false });
		assert.equal(result.details.ok, false);
		const message = "delegate refused: unknown jobId missing.";
		const outputs = [
			result,
			{ content: [{ type: "text", text: message }] }, // schema/host error without details
			{ content: [{ type: "text", text: message }], details: {} },
		];
		for (const output of outputs) {
			for (const expanded of [false, true]) {
				const panel = tool.renderResult(output, { expanded, isPartial: false }, theme, { state: {}, isError: true });
				assert.ok(panel.render(100).join("\n").includes(message), "error must be visible");
				assert.ok(panel.render(16).every((line: string) => visibleWidth(line) <= 16), "narrow rendering must fit");
			}
		}
		const success = { content: [{ type: "text", text: "answer" }], details: { ok: true, answer: "answer" } };
		const panel = tool.renderResult(success, { expanded: false, isPartial: false }, theme, { state: {}, isError: false });
		assert.equal(panel.render(100).join("\n").includes("answer"), true, "collapsed success must show an answer preview");
		const expanded = tool.renderResult(success, { expanded: true, isPartial: false }, theme, { state: {}, lastComponent: panel, isError: false });
		assert.ok(expanded.render(100).join("\n").includes("answer"));
		const archived = tool.renderResult({ details: { ok: true, sessionFile: "/private/session.jsonl", recordingError: "Recording incomplete" } }, { expanded: true, isPartial: false }, theme, { state: {}, isError: false });
		assert.ok(archived.render(100).join("\n").includes("Session: /private/session.jsonl"));
		assert.ok(archived.render(100).join("\n").includes("Recording incomplete"));
		assert.ok(archived.render(16).every((line: string) => visibleWidth(line) <= 16));
		const toolResult = handlers.get("tool_result");
		assert.deepEqual(toolResult?.({ toolName: "delegate", details: { ok: false } }), { isError: true });
		assert.equal(toolResult?.({ toolName: "delegate", details: { ok: true } }), undefined);
		assert.equal(toolResult?.({ toolName: "other", details: { ok: false } }), undefined);
		assert.equal(toolResult?.({ toolName: "delegate" }), undefined);
		await handlers.get("session_shutdown")?.();
		return { errorsVisible: true, hostErrorsMarked: true };
	});
}
