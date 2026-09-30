import assert from "node:assert/strict";
import { getKeybindings, stripTerminalSequences, Text, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { showStats } from "../../delegate/stats-view.ts";
import { showJobs } from "../../delegate/jobs-view.ts";
import type { JobBoardState } from "../../delegate/panel.ts";

export async function uxProbe(ctx: any) {
	const tick = () => new Promise(resolve => setTimeout(resolve, 0));
	const pending = new Map<string, { resolve: (value: string) => void; reject: (reason: Error) => void }>();
	let view: any, closed = false, repaints = 0;
	const tui = { terminal: { rows: 20 }, requestRender: () => { repaints++; } };
	const ui = { ...ctx.ui, custom: async (create: Function) => { view = create(tui, ctx.ui.theme, getKeybindings(), () => { closed = true; }); } };
	const report = Array.from({ length: 60 }, (_, i) => `Usage line ${i + 1}`).join("\n");
	await showStats({ ...ctx, hasUI: true, mode: "tui", ui }, report, {
		scope: "session", load: scope => new Promise((resolve, reject) => pending.set(scope, { resolve, reject })),
	});
	const screen = (width = 80) => view.render(width).map((line: string) => stripTerminalSequences(line).replace(/^│ ?| ?│$/g, "").trimEnd()).join("\n");
	try {
		assert.match(screen(), /Usage line 1\n/);
		assert.equal(view.render(80).length, 16, "the panel fills its bounded height even for short reports");
		assert.ok(view.render(80).every((line: string) => visibleWidth(line) === 80), "opaque frame fills every row");
		view.handleInput("\x1b[6~"); assert.doesNotMatch(screen(), /Usage line 1\n/);
		view.handleInput("\x1b[F"); assert.match(screen(), /Usage line 60\n/);
		view.handleInput("\x1b[H"); assert.match(screen(), /Usage line 1\n/);
		view.handleInput("2"); await tick(); assert.match(screen(), /Loading/); assert.doesNotMatch(screen(), /Usage line/);
		view.handleInput("\x1b[51u"); await tick();
		pending.get("all")!.resolve("All report"); await tick();
		pending.get("today")!.resolve("Stale today"); await tick();
		assert.match(screen(), /All report/); assert.doesNotMatch(screen(), /Stale today/);
		view.handleInput("2"); await tick(); pending.get("today")!.reject(new Error("retry me")); await tick();
		assert.match(screen(), /retry me/); assert.doesNotMatch(screen(), /All report/);
		view.handleInput("2"); await tick(); pending.get("today")!.resolve("Today report"); await tick();
		assert.match(screen(), /Today report/);
		for (const width of [16, 40, 80]) assert.ok(view.render(width).every((line: string) => visibleWidth(line) <= width));
		view.handleInput("1"); await tick(); view.handleInput("\x1b");
		const before = repaints; pending.get("session")!.resolve("Late result"); await tick();
		assert.equal(repaints, before); assert.equal(closed, true);
	} finally { view.dispose(); }
	let state: JobBoardState | undefined = { summary: "8 active", cards: Array.from({ length: 8 }, (_, i) => ({
		jobId: `d000${i + 1}`, kind: "review", model: "hosted/reviewer", reasoning: "high", status: i ? "queued" : "running",
		task: `Full task ${i + 1}: ` + "Inspect layout and navigation. ".repeat(6),
	})) };
	const lifetime = new AbortController();
	let reads = 0;
	closed = false;
	const jobs = showJobs({ ...ctx, hasUI: true, mode: "tui", ui: { ...ui,
		custom: (create: Function) => new Promise<void>(resolve => {
			view = create(tui, ctx.ui.theme, getKeybindings(), () => { closed = true; view.dispose(); resolve(); });
		}),
	} }, () => { reads++; return state; }, lifetime.signal);
	try {
		assert.match(screen(), /8 active/); assert.match(screen(), /Full task 1/);
		view.handleInput("\x1b[F"); assert.match(screen(), /Full task 8/);
		for (const width of [16, 40, 80]) {
			const lines = view.render(width); assert.ok(lines.length <= tui.terminal.rows);
			assert.ok(lines.every((line: string) => visibleWidth(line) <= width));
		}
		state = undefined; await new Promise(resolve => setTimeout(resolve, 550));
		assert.match(screen(), /No active delegates/); assert.match(screen(), /0 active/);
		lifetime.abort(); await jobs;
		assert.equal(closed, true, "session shutdown settles the open overlay");
		const before = reads;
		await new Promise(resolve => setTimeout(resolve, 550));
		assert.equal(reads, before, "shutdown stops polling even without a keypress");
	} finally { lifetime.abort(); view.dispose(); }
	// Real regular-mode compositing: parent output must not bleed through the panel.
	const terminal: any = { columns: 80, rows: 20, write() {}, hideCursor() {}, showCursor() {}, stop() {} };
	const real = new TuiMainScreen(terminal, false);
	const transcript = new Text("PARENT 0", 0, 0);
	real.addChild(transcript);
	const session = new AbortController();
	const overlay = showJobs({ ...ctx, hasUI: true, mode: "tui", ui: { ...ui,
		custom: (create: Function, options: any) => new Promise<void>(resolve => {
			const component = create(real, ctx.ui.theme, getKeybindings(), () => { real.hideOverlay(); component.dispose(); resolve(); });
			real.showOverlay(component, options.overlayOptions);
		}),
	} }, () => ({ summary: "one job", cards: [{ jobId: "d0001", kind: "review", model: "hosted/reviewer", task: "Inspect UI", status: "running" }] }), session.signal);
	try {
		for (const length of [1, 15, 35, 60]) {
			transcript.setText(Array.from({ length }, (_, i) => `PARENT ${i} `.repeat(8)).join("\n"));
			real.renderNow();
			const rendered = real.captureRenderState();
			const screen = rendered.previousLines.slice(rendered.previousViewportTop, rendered.previousViewportTop + terminal.rows).map(stripTerminalSequences);
			assert.match(screen[2], /╭.*pi-delegate · jobs/);
			assert.ok(screen[17].includes("╰"), "panel stays at fixed viewport coordinates while parent output grows");
			assert.ok(screen.slice(2, 18).every(line => !line.slice(4, 76).includes("PARENT")), "panel rows stay opaque");
		}
	} finally { session.abort(); await overlay; real.stop({ preserveScreen: true }); }
	return { jobs: true, navigation: true, scopes: true, staleLoads: true, retry: true, disposal: true, noModelCalls: true };
}
