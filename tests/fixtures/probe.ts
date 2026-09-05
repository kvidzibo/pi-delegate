import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import delegate from "../../delegate/index.ts";

export default function probe(pi: ExtensionAPI) {
	const register = (name: string, run: () => unknown | Promise<unknown>) => {
		pi.registerCommand(name, {
			description: "Offline package test; no model requests",
			handler: async (_args, ctx) => {
				try {
					const result = await run();
					ctx.ui.notify(JSON.stringify({ type: "delegate_test_probe", command: name, result }), "info");
				} catch (error) {
					ctx.ui.notify(JSON.stringify({ type: "delegate_test_probe", command: name, error: String(error) }), "error");
				}
			},
		});
	};
	register("delegate-load-probe", () => {
		const tools = pi.getAllTools().filter((tool) => tool.sourceInfo.source !== "builtin");
		assert.deepEqual(tools.map((tool) => tool.name), ["delegate"]);
		return { tools: tools.map((tool) => tool.name) };
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
		assert.equal(panel.render(100).join("\n").includes("answer"), false, "success stays compact");
		const expanded = tool.renderResult(success, { expanded: true, isPartial: false }, theme, { state: {}, lastComponent: panel, isError: false });
		assert.ok(expanded.render(100).join("\n").includes("answer"));
		const toolResult = handlers.get("tool_result");
		assert.deepEqual(toolResult?.({ toolName: "delegate", details: { ok: false } }), { isError: true });
		assert.equal(toolResult?.({ toolName: "delegate", details: { ok: true } }), undefined);
		assert.equal(toolResult?.({ toolName: "other", details: { ok: false } }), undefined);
		assert.equal(toolResult?.({ toolName: "delegate" }), undefined);
		await handlers.get("session_shutdown")?.();
		return { errorsVisible: true, hostErrorsMarked: true };
	});
}
