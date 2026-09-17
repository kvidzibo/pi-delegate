import assert from "node:assert/strict";
import { getAgentDir, SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { ArchivedRun, archiveRoot } from "../../delegate/archive.ts";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import delegate from "../../delegate/index.ts";
import { cardProbe } from "./cards.ts";
import { resultProbe } from "./results.ts";
import { panelProbe } from "./panel.ts";
import { backgroundProbe } from "./background.ts";
import { savingsProbe, guardStartupProbe } from "./savings.ts";
import { finalizationProbe } from "./finalization.ts";
import { headroomProbe } from "./headroom.ts";
import { localProbe } from "./local.ts";
import { capabilitiesProbe } from "./capabilities.ts";
import { LocalControl } from "../../delegate/local-control.ts";

export default function probe(pi: ExtensionAPI) {
	pi.registerCommand("delegate-reload-probe", {
		description: "Exercise the /reload lifecycle without model requests",
		handler: async (_args, ctx) => {
			new LocalControl(join(getAgentDir(), "delegate-local")).setEnabled(false);
			await ctx.reload();
		},
	});
	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "reload") return;
		const tools = pi.getAllTools().filter(tool => tool.sourceInfo.source !== "builtin").map(tool => tool.name);
		const localOffPersists = !new LocalControl(join(getAgentDir(), "delegate-local")).enabled()
			&& pi.getCommands().some(c => c.name === "delegate-local");
		ctx.ui.notify(JSON.stringify({ type: "delegate_test_probe", command: "delegate-reload-probe", result: { tools, reloaded: true, localOffPersists } }), "info");
	});
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
	register("delegate-capabilities-probe", ctx => capabilitiesProbe(pi, ctx));
	register("delegate-allowlist-probe", () => ({ tools: pi.getActiveTools() }));
	register("delegate-local-probe", ctx => localProbe(pi, ctx));
	register("delegate-guard-startup-probe", guardStartupProbe);
	register("delegate-finalization-probe", ctx => finalizationProbe(pi, ctx));
	register("delegate-headroom-probe", headroomProbe);
	register("delegate-savings-probe", ctx => savingsProbe(pi, ctx));
	register("delegate-card-probe", (ctx) => cardProbe(pi, ctx));
	register("delegate-result-probe", (ctx) => resultProbe(pi, ctx));
	register("delegate-panel-probe", (ctx) => panelProbe(pi, ctx));
	register("delegate-background-probe", backgroundProbe);
	register("delegate-load-probe", () => {
		const tools = pi.getAllTools().filter((tool) => tool.sourceInfo.source !== "builtin");
		assert.deepEqual(tools.map((tool) => tool.name), ["delegate"]);
		return { tools: tools.map((tool) => tool.name) };
	});
	register("delegate-models-probe", async (ctx) => {
		assert.ok(pi.getCommands().some(command => command.name === "delegate"));
		const initial = JSON.parse(readFileSync(new URL("../../delegate/config.json", import.meta.url), "utf8"));
		const oldModel = initial.agents.recon.model;
		const slash = oldModel.indexOf("/");
		const selected = "picker-cloud/team/new";
		writeFileSync(join(getAgentDir(), "models.json"), JSON.stringify({ providers: {
			[oldModel.slice(0, slash)]: { baseUrl: "http://localhost:1/v1", api: "openai-completions", apiKey: "unused",
				models: [{ id: oldModel.slice(slash + 1) }] },
			"picker-cloud": { baseUrl: "https://unused.invalid/v1", api: "openai-completions", apiKey: "unused",
				models: [{ id: "team/new", name: "Fresh Model" }] },
			"picker-no-auth": { baseUrl: "https://unused.invalid/v1", api: "openai-completions", models: [{ id: "hidden" }] },
		} }));
		const userPath = join(getAgentDir(), "delegate.json");
		const overlay = { maxOutputBytes: 12345, note: "preserve", agents: { recon: { thinking: "medium", tools: ["read", "bash"] } } };
		writeFileSync(userPath, JSON.stringify(overlay));
		const original = readFileSync(userPath, "utf8");
		const skip = process.env.PI_DELEGATE_SKIP_USER_CONFIG;
		delete process.env.PI_DELEGATE_SKIP_USER_CONFIG;
		const handlers = new Map<string, Function>(), commands = new Map<string, any>();
		let tool: any, finish: (() => void) | undefined;
		const launches: any[] = [], notices: string[] = [];
		const factory = () => delegate({ ...pi,
			registerTool: (definition: unknown) => { tool = definition; },
			registerCommand: (name: string, command: unknown) => commands.set(name, command),
			registerMessageRenderer: () => {}, on: (event: string, handler: Function) => { handlers.set(event, handler); },
			setModel: () => { throw new Error("Must not change the parent model"); },
		} as unknown as ExtensionAPI, async input => {
			launches.push(input);
			if (input.task === "hold") await new Promise<void>(resolve => {
				finish = resolve; input.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			return { text: "mock complete", exitCode: 0, stderrTail: "" };
		});
		let rolePicks = 0, modelPicks = 0, confirms = 0, sequence = 0;
		const testCtx: any = { ...ctx, mode: "tui", isIdle: () => false,
			scopedModels: [{ model: { provider: oldModel.slice(0, slash), id: oldModel.slice(slash + 1) } }],
			ui: { ...ctx.ui, setWidget: () => {}, setStatus: () => {}, notify: (text: string) => notices.push(text),
				select: async (title: string, options: string[]) => {
					assert.match(title, /Delegate models/);
					assert.equal(options.length, 4);
					for (const kind of ["recon", "implement", "review", "oracle"]) assert.ok(options.some(option => option.startsWith(`${kind} · `)));
					if (++rolePicks <= 2) {
						assert.equal(readFileSync(userPath, "utf8"), original, "cancel does not write");
						return options[0];
					}
					assert.match(options[0], /picker-cloud\/team\/new/);
					return undefined;
				},
				custom: async (create: Function) => {
					let result: string | undefined;
					const tui = { terminal: { rows: 30 }, requestRender: () => {} };
					const component = await create(tui, ctx.ui.theme, getKeybindings(), (value: string | undefined) => { result = value; });
					try {
						component.focused = true;
						assert.ok(component.render(100).join("\n").includes("✓ current"));
						assert.ok(component.render(100).join("\n").includes(selected));
						assert.ok(!component.render(100).join("\n").includes("picker-no-auth"));
						if (++modelPicks === 1) { component.handleInput("\x1b"); return result; }
						for (const char of "Fresh Model") component.handleInput(char);
						assert.match(component.render(100).join("\n"), /1\/2 available/);
						for (const width of [12, 40, 100]) assert.ok(component.render(width).every((line: string) => visibleWidth(line) <= width));
						tui.terminal.rows = 15;
						assert.ok(component.render(40).length <= 15);
						component.handleInput("\r");
						assert.equal(result, selected);
						return result;
					} finally { component.dispose(); }
				},
				confirm: async (_title: string, text: string) => {
					confirms++; assert.match(text, /offline: true → false/); assert.ok(text.includes(userPath)); return true;
				},
			},
		};
		const call = (params: unknown) => tool.execute(`models-${++sequence}`, params, undefined, undefined, testCtx);
		try {
			factory();
			await handlers.get("session_start")?.({}, testCtx);
			const running = await call({ kind: "recon", task: "hold", background: true });
			const queued = await call({ kind: "recon", task: "queued", background: true });
			assert.equal(queued.details.status, "queued");
			await commands.get("delegate").handler("", testCtx);
			assert.equal(confirms, 1, notices.join("\n"));
			assert.equal(rolePicks, 3, notices.join("\n"));
			assert.deepEqual(JSON.parse(readFileSync(userPath, "utf8")), { ...overlay, agents: {
				recon: { ...overlay.agents.recon, model: selected, offline: false },
			} });
			const fresh = await call({ kind: "recon", task: "fresh" });
			assert.equal(fresh.details.model, selected);
			assert.equal(fresh.details.ok, true);
			finish!();
			await call({ jobId: running.details.jobId }); await call({ jobId: queued.details.jobId });
			assert.deepEqual(launches.map(input => [input.model, input.offline]), [[oldModel, true], [selected, false], [oldModel, true]]);
			assert.ok(launches.every(input => input.thinking === "medium" && input.tools.join(",") === "read,bash"));
			await handlers.get("session_shutdown")?.();
			factory(); // Reload from the saved overlay, not in-memory selections.
			assert.equal((await call({ kind: "recon", task: "restored" })).details.model, selected);
			return { roleModels: true, availableOnly: true, searchable: true, cancellation: true, persisted: true, live: true, queuedUnchanged: true, noModelCalls: true };
		} finally {
			finish?.(); await handlers.get("session_shutdown")?.();
			if (skip === undefined) delete process.env.PI_DELEGATE_SKIP_USER_CONFIG; else process.env.PI_DELEGATE_SKIP_USER_CONFIG = skip;
		}
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
