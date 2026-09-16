import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, CURSOR_MARKER, Spacer, Text, TuiMainScreen, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { JobBoard } from "../../delegate/board.ts";
import { renderChildResult, renderJobBoard, renderJobBoardLine } from "../../delegate/view.ts";
import { projectJobBoard } from "../../delegate/panel.ts";
import type { JobSnapshot } from "../../delegate/jobs.ts";
import delegate from "../../delegate/index.ts";
import { CARD_STATE_TYPE } from "../../delegate/cards.ts";
import type { RunChildInput } from "../../delegate/spawn.ts";
import type { ChildResult } from "../../child-runtime/spawn.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (s: string) => s, italic: (s: string) => s };
function widgetHost(onRender: () => void = () => {}, tui?: TUI) {
	const widgets = new Map<string, any>(); const container = new Container();
	container.addChild(new Spacer(1));
	const calls: any[] = []; let repaints = 0; let expanded = false;
	const requestRender = () => { repaints++; onRender(); };
	const factoryTui = tui ? new Proxy(tui, { get(target, key) {
		if (key === "requestRender") return requestRender;
		const value = Reflect.get(target, key, target);
		return typeof value === "function" ? value.bind(target) : value;
	} }) : { requestRender };
	const ui: any = { getToolsExpanded: () => expanded, setWidget(key: string, content: any, options: any) {
		calls.push({ key, content, options });
		// Match Pi's remove/reinsert and above-editor container layout.
		widgets.get(key)?.dispose?.(); widgets.delete(key);
		if (content !== undefined) widgets.set(key, typeof content === "function"
			? content(factoryTui, theme)
			: new Text(content.join("\n"), 1, 0));
		container.clear(); container.addChild(new Spacer(1));
		for (const component of widgets.values()) container.addChild(component);
		onRender();
	} };
	return { ui, widgets, calls, container, setExpanded: (value: boolean) => { expanded = value; onRender(); }, repaints: () => repaints, render: (width = 200) => container.render(width) };
}

function checkResourcePresentation() {
	const job: JobSnapshot = { id: "d0001", kind: "recon", model: "local/model", task: "resource fixture", status: "queued",
		local: true, failed: false, background: true, activity: [], reason: "resource", resource: { key: "same-server", capacity: 1, state: "waiting" } };
	const board = projectJobBoard([job], { maxLocalConcurrent: 1 })!;
	assert.match(renderJobBoard(board, 100, 12, theme, false, "").join("\n"), /Queued — waiting for shared resource same-server/);
	const warning = renderChildResult({ theme, read: () => ({ details: { status: "done", resourceError: "Lease release not confirmed" },
		collect: false, live: false, isPartial: false, expanded: false }) });
	assert.match(warning.render(100).join("\n"), /Lease release not confirmed/);
	for (const width of [1, 2, 8, 16, 80]) {
		assert.ok(renderJobBoard(board, width, 8, theme, true, "").every(line => visibleWidth(line) <= width));
		assert.ok(warning.render(width).every(line => visibleWidth(line) <= width));
	}
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

function checkBottomAnchoring() {
	const writes: string[] = [];
	const terminal: any = { columns: 100, rows: 16, write: (s: string) => writes.push(s), hideCursor() {}, showCursor() {}, stop() {} };
	const tui = new TuiMainScreen(terminal, false);
	const host = widgetHost(() => tui.requestRender(), tui);
	const board = new JobBoard(renderJobBoardLine, () => new Container());
	const transcript = new Text("parent 0", 0, 0);
	let editorLines = ["editor top", `${CURSOR_MARKER}> input`, "editor end"];
	const editor = { render: () => editorLines, invalidate() {} };
	const footer = new Text("footer one\nfooter two", 0, 0);
	const original = [transcript, host.container, editor, footer];
	for (const component of original) tui.addChild(component);
	tui.setFocus(editor);
	const frame = (checkReset = true) => {
		writes.length = 0; tui.renderNow();
		const state = tui.captureRenderState();
		const screen = state.previousLines.slice(state.previousViewportTop, state.previousViewportTop + terminal.rows);
		const panelRow = terminal.rows - editorLines.length - 3;
		assert.equal(screen.findIndex((s) => s.includes("delegate")), panelRow, "panel must be bottom-anchored before and after the transcript fills the screen");
		assert.equal(state.hardwareCursorRow - state.previousViewportTop, panelRow + 2, "keep the hardware cursor on the existing editor's input line");
		assert.ok(screen.at(-1)?.includes("footer two"), "keep the existing footer at the bottom");
		assert.equal(state.previousLines.filter((s) => s.includes("delegate")).length, 1, "one panel, no scrollback copies");
		assert.equal(tui.getFocusedComponent(), editor, "do not replace or steal editor focus");
		if (checkReset) assert.ok(!writes.join("").includes("\x1b[3J"), "streaming output must not clear scrollback");
	};
	try {
		board.paint(host.ui, "tui", "delegate reading");
		frame();
		for (let count = 2; count <= 40; count++) {
			transcript.setText(Array.from({ length: count }, (_, i) => `parent ${i}`).join("\n"));
			frame();
		}
		board.paint(host.ui, "tui", "delegate working"); frame();
		// Small output/dock shrink must not leave the panel floating above the bottom.
		transcript.setText(Array.from({ length: 39 }, (_, i) => `parent ${i}`).join("\n")); frame();
		editorLines = ["editor top", `${CURSOR_MARKER}> input`, "extra line", "editor end"]; frame();
		editorLines = ["editor top", `${CURSOR_MARKER}> input`, "editor end"]; frame();
		for (const [columns, rows] of [[12, 16], [100, 24], [100, 8]]) {
			terminal.columns = columns; terminal.rows = rows; frame(false); // Native resize can redraw history.
		}
		board.paint(host.ui, "tui", undefined); tui.renderNow();
		assert.ok(!tui.captureRenderState().previousLines.some((s) => s.includes("delegate")));
		board.paint(host.ui, "tui", "delegate reading"); frame(false);
	} finally {
		board.close(host.ui); tui.stop({ preserveScreen: true });
	}
	assert.deepEqual(tui.children, original, "restore the original component tree on close");
}

function checkFullCardAnchoring() {
	const job: JobSnapshot = { id: "d0001", kind: "review", model: "hosted/reviewer", task: "Review card layout",
		status: "running", local: false, failed: false, background: true, activity: [] };
	const state = () => projectJobBoard([job], { maxLocalConcurrent: 1 })!;
	const writes: string[] = [];
	const terminal: any = { columns: 100, rows: 24, write: (s: string) => writes.push(s), hideCursor() {}, showCursor() {}, stop() {} };
	const tui = new TuiMainScreen(terminal, false), host = widgetHost(() => tui.requestRender(), tui);
	const board = new JobBoard(renderJobBoard, () => new Container());
	const transcript = new Text("parent 0", 0, 0);
	let inputLines = ["editor top", `${CURSOR_MARKER}> input`, "editor end"], otherRows = 0;
	const editor = { render: () => inputLines, invalidate() {} };
	const footer = new Text("footer one\nfooter two", 0, 0);
	const originals = [transcript, host.container, editor, footer];
	for (const child of originals) tui.addChild(child);
	tui.setFocus(editor);
	const frame = (checkReset = true) => {
		writes.length = 0; tui.renderNow();
		const rendered = tui.captureRenderState();
		const screen = rendered.previousLines.slice(rendered.previousViewportTop, rendered.previousViewportTop + terminal.rows);
		const cardLines = host.widgets.get("delegate").render(terminal.columns);
		const start = terminal.rows - inputLines.length - 2 - otherRows - cardLines.length;
		assert.equal(screen.findIndex((line) => line.startsWith(cardLines[0])), start, `the whole card header must stay in the bottom dock (${terminal.columns}×${terminal.rows})`);
		if (cardLines.length >= 3) {
			assert.ok(cardLines.some((line: string) => line.includes("Task:")));
			assert.ok(cardLines.some((line: string) => line.includes("Running")));
		}
		assert.equal(rendered.hardwareCursorRow - rendered.previousViewportTop, terminal.rows - inputLines.length - 1);
		assert.ok(screen.at(-1)?.includes("footer two"));
		assert.ok(cardLines.length <= Math.min(12, Math.floor(terminal.rows / 2)), "panel must be height-bounded");
		assert.ok(cardLines.every((line: string) => visibleWidth(line) <= terminal.columns));
		if (checkReset) assert.ok(!writes.join("").includes("\x1b[3J"), "live full-card updates must not clear scrollback");
		return { start, cardLines };
	};
	try {
		board.paint(host.ui, "tui", state());
		const initial = frame(); assert.equal(initial.cardLines.length, 5);
		assert.match(initial.cardLines.join("\n"), /review · hosted\/reviewer/);
		assert.match(initial.cardLines.join("\n"), /Task: Review card layout/);
		for (let count = 2; count <= 60; count++) {
			transcript.setText(Array.from({ length: count }, (_, i) => `parent ${i}`).join("\n"));
			assert.equal(frame().start, initial.start);
		}
		job.current = { name: "read", mark: "→", args: "board.ts" };
		board.paint(host.ui, "tui", state());
		assert.match(frame().cardLines.join("\n"), /read.*board.ts/);
		host.setExpanded(true); frame(false);
		job.activity = [{ name: "bash", mark: "✗", args: "a failed command" }];
		board.paint(host.ui, "tui", state());
		assert.match(frame().cardLines.join("\n"), /✗ bash/);
		// A tall input and other extensions must reduce card height, not lose the editor/footer.
		inputLines = ["editor top", `${CURSOR_MARKER}> input`, ...Array(10).fill("input line")]; frame();
		inputLines = ["editor top", `${CURSOR_MARKER}> input`, "editor end"]; frame();
		otherRows = 12; host.ui.setWidget("other", Array(12).fill("other widget")); frame(false);
		host.ui.setWidget("other", undefined); otherRows = 0; frame(false);
		for (const [columns, rows] of [[16, 24], [100, 12], [100, 8], [100, 24]]) {
			terminal.columns = columns; terminal.rows = rows; frame(false);
		}
		board.paint(host.ui, "tui", undefined); tui.renderNow();
		assert.deepEqual(host.widgets.get("delegate").render(100), []);
		terminal.rows = 16; tui.renderNow(); // Resize while idle, then reuse the same mounted widget.
		host.setExpanded(false); board.paint(host.ui, "tui", state()); frame(false);
		assert.equal(host.calls.filter((call) => typeof call.content === "function").length, 1);
	} finally { board.close(host.ui); tui.stop({ preserveScreen: true }); }
	assert.deepEqual(tui.children, originals);

	// Narrow widths and multiple active jobs degrade explicitly within the same height budget.
	const many = projectJobBoard(Array.from({ length: 8 }, (_, i) => ({ ...job, id: `d000${i + 1}` })), { maxLocalConcurrent: 1 })!;
	for (const expanded of [false, true]) for (const width of [1, 2, 8, 16, 80]) for (const rows of [0, 1, 2, 3, 4, 8, 12]) {
		const lines = renderJobBoard(many, width, rows, theme, expanded, "");
		assert.ok(lines.length <= rows); assert.ok(lines.every((line) => visibleWidth(line) <= width));
	}
	assert.match(renderJobBoard(many, 100, 12, theme, false, "").join("\n"), /\+5 more/);
	const unsafe = projectJobBoard([{ ...job, task: "界 🧪 ".repeat(100) + "\u001b[2J", thinking: true, current: { name: "thinking", mark: "…", args: "SECRET" } }], { maxLocalConcurrent: 1 })!;
	const lines = renderJobBoard(unsafe, 30, 8, theme, true, "");
	assert.doesNotMatch(lines.join("\n").replace(/\x1b\[[0-9;]*m/g, ""), /PRIVATE|SECRET|\u001b/);

	// The retired strip's status coverage belongs to the production full-card renderer.
	const mixed = projectJobBoard([
		{ ...job, local: true, model: "local-qwen38/qwen38-q4km", thinking: true, tg: "tg 40/s", current: { mark: "→", name: "read" } },
		{ ...job, id: "d0002", status: "queued", reason: "gpu", current: undefined },
		{ ...job, id: "d0003", thinking: true, wrapped: true, current: undefined },
	], { maxLocalConcurrent: 1 })!;
	const rendered = renderJobBoard(mixed, 100, 12, theme, false, "").join("\n");
	assert.match(rendered, /d0001[\s\S]*d0002[\s\S]*d0003/, "cards keep acceptance order");
	assert.match(rendered, /Running — reading file · tg 40\/s/, "in-flight tools take precedence over thinking");
	assert.match(rendered, /Queued — waiting for GPU/);
	assert.match(rendered, /Running — thinking · wrap requested/);
	assert.equal(mixed.summary, "delegate  2 run  1 wait  local 1/1");
	const unsafeTool = projectJobBoard([{ ...job, current: { mark: "→", name: "bad\u001b[2J\nname" } }], { maxLocalConcurrent: 1 })!;
	assert.doesNotMatch(renderJobBoard(unsafeTool, 100, 8, theme, true, "").join("\n"), /[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
}

export async function panelProbe(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
	checkResourcePresentation();
	checkBoardGeometry();
	checkBottomAnchoring();
	checkFullCardAnchoring();
	const writes: string[] = [];
	const terminal: any = { columns: 100, rows: 24, write: (s: string) => writes.push(s), hideCursor() {}, showCursor() {}, stop() {} };
	const tui: any = new TuiMainScreen(terminal, false);
	let frames = 0;
	const render = tui.doRender.bind(tui);
	tui.doRender = () => { frames++; render(); };
	const afterFrame = async (before: number) => {
		for (let i = 0; i < 100 && frames <= before; i++) await new Promise((r) => setTimeout(r, 5));
		assert.ok(frames > before, "widget requestRender must schedule a real renderer frame");
	};
	const host = widgetHost(() => tui.requestRender(), tui); const entries: any[] = [];
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
		assert.match(host.render(300).join("\n"), /Task: Read a file/, "the full active card, not only a status strip, must live in the pinned widget");
		assert.doesNotMatch(first.render(100).join("\n"), /Task:|local-qwen38/, "the active transcript must not duplicate the pinned card");
		assert.match(host.render(300).join("\n"), /delegate · d0002 · recon · local-qwen38/);
		assert.match(host.render(300).join("\n"), /Queued — waiting for GPU/);
		assert.equal((host.render(300).join("\n").match(/qwen38-q4km/g) ?? []).length, 2, "model once per pinned card");
		const frame = () => { writes.length = 0; tui.renderNow(); };
		const noReset = () => assert.ok(!writes.join("").includes("\x1b[3J"), "live activity must not clear scrollback");
		frame();
		const firstRun = runs[0];
		for (const expanded of [false, true]) {
			first.context.expanded = expanded; host.setExpanded(expanded); frame(); // User expansion may reflow history.
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
		assert.match(host.render(300).join("\n"), /Running — executing command/);
		const queuedBefore = queued.render(100); const queuedInvalidations = queued.invalidations();
		firstRun.resolve({ text: "Done reading", exitCode: 0, stderrTail: "" });
		for (let i = 0; i < 100 && !entries.some((e) => e.customType === CARD_STATE_TYPE && e.data.originToolCallId === "first"); i++) await new Promise((r) => setTimeout(r, 5));
		assert.match(first.render(100).join("\n"), /✓ Finished/);
		assert.doesNotMatch(host.render(300).join("\n"), /d0001|Done reading/, "completed cards leave the dock and stay in the transcript");
		assert.equal(runs.length, 2, "the queued child starts without collecting its predecessor");
		assert.deepEqual(queued.render(100), queuedBefore); assert.equal(queued.invalidations(), queuedInvalidations);
		assert.doesNotMatch(host.render(300).join("\n"), /Queued — waiting for GPU/);
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
	return { stableScrollback: true, bottomAnchored: true, fullPinnedCards: true, terminalWithoutCollect: true, queuedAndPromoted: true, singleMount: true, noModelCalls: true };
}
