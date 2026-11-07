import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import delegate from "../../delegate/index.ts";
import { loadDelegateConfig } from "../../delegate/config.ts";
import { ModelCommand } from "../../delegate/model-command.ts";
import { CHECKPOINT_MESSAGE } from "../../delegate/checkpoints.ts";

/** Installed-loader probe: real scheduler, saved response, accounting and native settings; synthetic workers only. */
export async function checkpointsProbe(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
	const userPath = join(getAgentDir(), "delegate.json");
	const role = { model: "test/advisor", prompt: "Give bounded advice.", thinking: "off", tools: [], extensions: false, saveToFile: true };
	const overlay = { defaultTimeoutMs: 1000, checkpoints: { enabled: true, interval: 10 }, agents: { goldfish: role } };
	writeFileSync(userPath, JSON.stringify(overlay));
	const oldSkip = process.env.PI_DELEGATE_SKIP_USER_CONFIG;
	delete process.env.PI_DELEGATE_SKIP_USER_CONFIG;
	const handlers = new Map<string, Function>();
	const manager = SessionManager.inMemory(ctx.cwd);
	const signal = new AbortController();
	let calls = 0, mode = "success", observedTask = "", childSignal: AbortSignal | undefined;
	try {
		delegate({ ...pi, registerCommand() {}, registerTool() {}, registerMessageRenderer() {},
			on: (name: string, handler: Function) => handlers.set(name, handler),
			appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data),
			sendMessage: () => assert.fail("A synchronous checkpoint must not send follow-up notices"),
		} as any, async input => {
			calls++; observedTask = input.task; childSignal = input.signal;
			assert.deepEqual(input.tools, []); assert.equal(input.extensions, false);
			if (mode === "timeout") return new Promise(resolve => input.signal?.addEventListener("abort", () => resolve({ text: "cancelled", exitCode: 1, stopReason: "aborted", stderrTail: "" }), { once: true }));
			if (mode === "abort") {
				signal.abort();
				return { text: "cancelled", exitCode: 1, stopReason: "aborted", stderrTail: "" };
			}
			return { text: mode === "failure" ? "Provider unavailable" : "Reuse the existing helper; avoid introducing another abstraction.", exitCode: mode === "failure" ? 1 : 0, stderrTail: "" };
		});
	} finally {
		if (oldSkip === undefined) delete process.env.PI_DELEGATE_SKIP_USER_CONFIG; else process.env.PI_DELEGATE_SKIP_USER_CONFIG = oldSkip;
	}
	const testCtx: any = { ...ctx, signal: signal.signal, sessionManager: manager, isIdle: () => false,
		ui: { ...ctx.ui, setWidget() {}, setStatus() {} },
	};
	let round = 0;
	const turn = async () => {
		const id = `call-${++round}`;
		const message: any = { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command: "npm test" } }], stopReason: "toolUse", timestamp: Date.now() };
		const messageEntryId = manager.appendMessage(message);
		const result: any = { role: "toolResult", toolName: "bash", toolCallId: id, content: [{ type: "text", text: "Tests passed" }], isError: false, timestamp: Date.now() };
		const toolResultEntryIds = [manager.appendMessage(result)];
		const projection = manager.buildSessionProjection();
		const feedback = await handlers.get("turn_end")!({ message, messageEntryId, toolResults: [result], toolResultEntryIds,
			outcome: "completed", entries: [], context: { contextEntries: projection.entries, contextMessages: projection.messages, canContinue: true, pendingMessages: [] },
		}, testCtx);
		if (feedback) {
			assert.equal(feedback.continue, undefined);
			for (const entry of feedback.entries) {
				if (entry.type === "custom") manager.appendCustomEntry(entry.customType, entry.data);
				else manager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
			}
		}
		return feedback;
	};
	await handlers.get("session_start")!({}, testCtx);
	try {
		manager.appendMessage({ role: "user", content: "Fix the parser without changing public APIs.", timestamp: Date.now() });
		handlers.get("agent_start")!({}, testCtx);
		for (let i = 0; i < 9; i++) assert.equal(await turn(), undefined);
		assert.equal(calls, 0);
		const feedback = await turn();
		assert.equal(calls, 1);
		assert.equal(feedback.entries[0].customType, CHECKPOINT_MESSAGE);
		assert.match(feedback.entries[0].content, /Reuse the existing helper/);
		assert.doesNotMatch(feedback.entries[0].content, /Response saved to:/);
		assert.match(observedTask, /Fix the parser without changing public APIs/);
		assert.match(observedTask, /Tests passed/);
		assert.ok(observedTask.length <= 20000);
		assert.ok(feedback.entries[0].details.durationMs >= 0);
		// Failure is visible and leaves the parent's workflow free to continue.
		mode = "failure";
		for (let i = 0; i < 9; i++) await turn();
		assert.match((await turn()).entries[0].content, /checkpoint unavailable: Provider unavailable/);
		mode = "timeout";
		for (let i = 0; i < 9; i++) await turn();
		assert.match((await turn()).entries[0].content, /wait ended before completion; cancellation requested/);
		assert.equal(childSignal?.aborted, true);
		mode = "abort";
		for (let i = 0; i < 9; i++) await turn();
		assert.equal(await turn(), undefined);
		assert.equal(childSignal?.aborted, true);
	} finally {
		await handlers.get("session_shutdown")!({}, testCtx);
	}

	const paths = { shippedPath: join(import.meta.dirname, "../../delegate/config.json"), userPath };
	const config = loadDelegateConfig(paths);
	const command = new ModelCommand(config, paths);
	const notices: string[] = [];
	const model = { provider: "test", id: "advisor", name: "Test advisor", reasoning: false };
	let moves = [0, 2, 3]; // Disable, cycle interval to20, Save.
	const menuCtx: any = { ...ctx, mode: "tui", hasUI: true, scopedModels: [],
		modelRegistry: { refresh: async () => {}, getError: () => undefined, getAvailable: () => [model], getAll: () => [model] },
		ui: { ...ctx.ui, notify: (message: string) => notices.push(message),
			custom: async (create: Function) => {
				let answer: string | undefined;
				const terminal = { rows: 30, columns: 100 };
				const component = create({ terminal, requestRender() {} }, ctx.ui.theme, getKeybindings(), (value: string | undefined) => { answer = value; });
				try {
					for (const [rows, columns] of [[30, 100], [22, 40], [30, 100]]) {
						terminal.rows = rows; terminal.columns = columns;
						const lines = component.render(columns);
						assert.ok(lines.every((line: string) => visibleWidth(line) <= columns));
						assert.ok(lines.length <= rows - 6);
					}
					let position = 0;
					for (const target of moves) {
						if (target < 0) { component.handleInput("\x1b"); break; }
						while (position < target) { component.handleInput("\x1b[B"); position++; }
						while (position > target) { component.handleInput("\x1b[A"); position--; }
						component.handleInput("\r"); component.render(100);
					}
					return answer;
				} finally { component.dispose?.(); }
			},
		},
	};
	try {
		await command.checkpoints("", menuCtx);
		assert.deepEqual(config.checkpoints, { enabled: false, role: "goldfish", interval: 20 });
		assert.deepEqual(loadDelegateConfig(paths).checkpoints, config.checkpoints);
		const saved = readFileSync(userPath, "utf8");
		moves = [0, -1];
		await command.checkpoints("", menuCtx);
		assert.equal(readFileSync(userPath, "utf8"), saved, "Esc discards changes");
		moves = [0, 3];
		await command.checkpoints("", menuCtx);
		assert.equal(config.checkpoints.enabled, true);
		assert.equal(notices.filter(text => text.includes("saved globally")).length, 2);
	} finally { command.stop(); }
	return { automatic: true, savedFeedback: true, failure: true, cancellation: true, menu: true, noModelCalls: true };
}
