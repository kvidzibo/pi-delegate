import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { JobBoard } from "../../delegate/board.ts";
import { renderJobBoardLine } from "../../delegate/view.ts";
import delegate from "../../delegate/index.ts";
import { CARD_STATE_TYPE } from "../../delegate/cards.ts";
import type { RunChildInput } from "../../delegate/spawn.ts";
import type { ChildResult } from "../../child-runtime/spawn.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (s: string) => s, italic: (s: string) => s };
function widgetHost(onRender: () => void = () => {}) {
	const widgets = new Map<string, any>(); const container = new Container();
	container.addChild(new Spacer(1));
	const calls: any[] = []; let repaints = 0;
	const ui: any = { setWidget(key: string, content: any, options: any) {
		calls.push({ key, content, options });
		// Match Pi's remove/reinsert and above-editor container layout.
		widgets.get(key)?.dispose?.(); widgets.delete(key);
		if (content !== undefined) widgets.set(key, typeof content === "function"
			? content({ requestRender: () => { repaints++; onRender(); } }, theme)
			: new Text(content.join("\n"), 1, 0));
		container.clear(); container.addChild(new Spacer(1));
		for (const component of widgets.values()) container.addChild(component);
		onRender();
	} };
	return { ui, widgets, calls, container, repaints: () => repaints, render: (width = 200) => container.render(width) };
}

function checkBoardGeometry() {
	const board = new JobBoard(renderJobBoardLine); const host = widgetHost();
	board.paint(host.ui, "tui", `delegate reading ${"界 🧪 ".repeat(40)}`);
	const component = host.widgets.get("delegate");
	for (const width of [1, 2, 8, 16, 80]) {
		const lines = component.render(width);
		assert.equal(lines.length, 1); assert.ok(visibleWidth(lines[0]) <= width);
	}
	assert.deepEqual(component.render(0), []);
	board.paint(host.ui, "tui", undefined); assert.deepEqual(component.render(100), []);
	board.close(host.ui);
}

export async function panelProbe(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
	checkBoardGeometry();
	const writes: string[] = [];
	const terminal: any = { columns: 100, rows: 12, write: (s: string) => writes.push(s), hideCursor() {}, showCursor() {}, stop() {} };
	const tui: any = new TuiMainScreen(terminal, false);
	let frames = 0;
	const render = tui.doRender.bind(tui);
	tui.doRender = () => { frames++; render(); };
	const afterFrame = async (before: number) => {
		for (let i = 0; i < 100 && frames <= before; i++) await new Promise((r) => setTimeout(r, 5));
		assert.ok(frames > before, "widget requestRender must schedule a real renderer frame");
	};
	const host = widgetHost(() => tui.requestRender()); const entries: any[] = [];
	const handlers = new Map<string, Function>(); let tool: any;
	const runs: Array<{ input: RunChildInput; resolve: (result: ChildResult) => void }> = [];
	delegate({ ...pi, registerTool: (t: any) => { tool = t; }, registerCommand() {}, registerMessageRenderer() {},
		on: (name: string, fn: Function) => handlers.set(name, fn),
		appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
		sendMessage() { throw new Error("busy parent must not notify"); },
	} as unknown as ExtensionAPI, (input) => new Promise((resolve) => {
		runs.push({ input, resolve });
		input.signal?.addEventListener("abort", () => resolve({ text: "Cancelled", exitCode: 1, stopReason: "aborted", stderrTail: "" }), { once: true });
	}));
	const testCtx: any = { ...ctx, mode: "tui", hasUI: true, isIdle: () => false,
		ui: { ...ctx.ui, ...host.ui, setStatus() {}, notify() {} },
		sessionManager: { getSessionId: () => "panel-probe", getSessionFile: () => undefined, getBranch: () => entries },
	};
	await handlers.get("session_start")?.({}, testCtx);
	const rows: any[] = [];
	const transcript = new Container();
	transcript.addChild({ render: (width: number) => rows.flatMap((row) => row.render(width)), invalidate() {} });
	transcript.addChild(new Text(Array.from({ length: 40 }, (_, i) => `parent output ${i}`).join("\n"), 0, 0));
	// Real sibling nodes: scrollback transcript, above-editor widget, editor, footer.
	tui.addChild(transcript); tui.addChild(host.container);
	tui.addChild(new Text("> editor", 0, 0)); tui.addChild(new Text("footer", 0, 0));
	const launch = async (id: string, options: object = {}) => {
		const args = { kind: "recon", model: "local-qwen38/qwen38-q4km", task: "Read a file", background: true, ...options };
		let result: any; let invalidations = 0;
		const context: any = { toolCallId: id, args, state: {}, expanded: false, isPartial: true, isError: false,
			invalidate: () => { invalidations++; tui.requestRender(); } };
		const row = { context, invalidations: () => invalidations, render(width: number) {
			const header = tool.renderCall(args, theme, context);
			const body = result ? tool.renderResult(result, { expanded: context.expanded, isPartial: context.isPartial }, theme, context) : undefined;
			return [...header.render(width), ...(body?.render(width) ?? [])];
		} };
		rows.push(row);
		result = await tool.execute(id, args, undefined, (next: any) => { result = next; row.render(100); }, testCtx);
		context.isPartial = false; row.render(100);
		return { ...row, result };
	};
	try {
		const first = await launch("first"); const queued = await launch("queued");
		assert.match(host.render(300).join("\n"), /d0002 queued \(GPU\)/);
		const frame = () => { writes.length = 0; tui.renderNow(); };
		const noReset = () => assert.ok(!writes.join("").includes("\x1b[3J"), "live activity must not clear scrollback");
		frame();
		const firstRun = runs[0];
		for (const expanded of [false, true]) {
			first.context.expanded = expanded; frame(); // User expansion may reflow history.
			const before = first.render(100); const invalidations = first.invalidations();
			for (const event of [
				{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "PRIVATE THOUGHT" } },
				{ type: "tool_execution_start", toolName: "read", toolCallId: "read-1", args: { path: "one.ts" } },
				{ type: "tool_execution_end", toolName: "read", toolCallId: "read-1" },
				{ type: "tool_execution_start", toolName: "bash", toolCallId: "bash-1", args: { command: "ls" } },
			]) {
				const textBefore = host.render().join("\n"), framesBefore = frames, paintsBefore = host.repaints(); writes.length = 0;
				firstRun.input.onEvent?.(event);
				assert.deepEqual(first.render(100), before); assert.equal(first.invalidations(), invalidations);
				assert.doesNotMatch(host.render(300).join("\n"), /PRIVATE THOUGHT/);
				if (host.render().join("\n") !== textBefore) {
					assert.ok(host.repaints() > paintsBefore); await afterFrame(framesBefore);
				} else {
					assert.equal(host.repaints(), paintsBefore); frame(); // An unrelated repaint is safe too.
				}
				noReset();
			}
		}
		assert.match(host.render(300).join("\n"), /d0001 executing command/);
		const queuedBefore = queued.render(100); const queuedInvalidations = queued.invalidations();
		firstRun.resolve({ text: "Done reading", exitCode: 0, stderrTail: "" });
		for (let i = 0; i < 100 && !entries.some((e) => e.customType === CARD_STATE_TYPE && e.data.originToolCallId === "first"); i++) await new Promise((r) => setTimeout(r, 5));
		assert.match(first.render(100).join("\n"), /✓ Finished/);
		assert.equal(runs.length, 2, "the queued child starts without collecting its predecessor");
		assert.deepEqual(queued.render(100), queuedBefore); assert.equal(queued.invalidations(), queuedInvalidations);
		assert.doesNotMatch(host.render(300).join("\n"), /queued \(GPU\)/);
		frame(); // One terminal finalization may redraw history; subsequent progress must not.
		writes.length = 0; let beforeFrame = frames;
		runs[1].input.onEvent?.({ type: "tool_execution_start", toolName: "read", toolCallId: "next-read", args: { path: "two.ts" } });
		await afterFrame(beforeFrame); noReset();
		beforeFrame = frames;
		await tool.execute("cancel", { jobId: queued.result.details.jobId, cancel: true }, undefined, undefined, testCtx);
		await afterFrame(beforeFrame);
		assert.ok(!tui.captureRenderState().previousLines.some((s: string) => s.includes("delegate  ")), "idle widget height/content must be removed on screen");
		const promoted = await launch("promoted", { background: false, timeoutMs: 1 });
		assert.equal(promoted.result.details.background, true);
		const promotedBefore = promoted.render(100); frame(); writes.length = 0; beforeFrame = frames;
		runs.at(-1)!.input.onEvent?.({ type: "tool_execution_start", toolName: "bash", toolCallId: "promoted-bash", args: { command: "ls" } });
		assert.deepEqual(promoted.render(100), promotedBefore); await afterFrame(beforeFrame); noReset();
		assert.equal(host.calls.filter((c) => typeof c.content === "function").length, 1, "all activity and idle/reuse keep one mount");
	} finally {
		try { await handlers.get("session_shutdown")?.(); }
		finally { tui.stop({ preserveScreen: true }); }
	}
	assert.equal(host.widgets.has("delegate"), false);
	return { stableScrollback: true, terminalWithoutCollect: true, queuedAndPromoted: true, singleMount: true, noModelCalls: true };
}
