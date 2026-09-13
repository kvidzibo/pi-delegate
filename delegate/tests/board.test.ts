import assert from "node:assert/strict";
import { test } from "node:test";
import { JobBoard } from "../board.ts";
import { formatJobBoard } from "../display.ts";

// Lifecycle is independent of Pi. Real width rendering is covered by the CLI UI probe.
const draw = (line: string, width: number) => [line.slice(0, width)];
function host() {
	const widgets = new Map<string, any>(); const calls: any[] = [];
	let repaints = 0; let throwOnRender = false;
	const ui: any = { setWidget(key: string, content: any, options: any) {
		calls.push({ key, content, options });
		widgets.get(key)?.dispose?.(); widgets.delete(key);
		if (content !== undefined) widgets.set(key, typeof content === "function" ? content({ requestRender() {
			repaints++; if (throwOnRender) throw new Error("dead renderer");
		} }) : content);
	} };
	return { widgets, calls, ui, repaints: () => repaints, breakRender: () => { throwOnRender = true; } };
}

test("board mounts once, updates in place, requests idle/reuse repaints and preserves sibling order", () => {
	const h = host(); const board = new JobBoard(draw);
	board.paint(h.ui, "tui", undefined); assert.equal(h.calls.length, 0);
	board.paint(h.ui, "tui", "working");
	const component = h.widgets.get("delegate");
	assert.deepEqual(h.calls[0].options, { placement: "aboveEditor" });
	h.ui.setWidget("other", ["other"]);
	board.paint(h.ui, "tui", "reading");
	assert.deepEqual([...h.widgets.keys()], ["delegate", "other"]);
	assert.equal(h.widgets.get("delegate"), component);
	assert.deepEqual(component.render(4), ["read"], "forward current text and width to the renderer");
	assert.equal(h.repaints(), 1);
	board.paint(h.ui, "tui", undefined);
	assert.equal(h.repaints(), 2); assert.deepEqual(component.render(80), []);
	board.paint(h.ui, "tui", undefined); assert.equal(h.repaints(), 2);
	board.paint(h.ui, "tui", "next");
	assert.equal(h.repaints(), 3); assert.equal(h.widgets.get("delegate"), component);
	assert.equal(h.calls.filter((c) => c.key === "delegate").length, 1);
	board.close(h.ui); board.close(h.ui);
	assert.equal(h.calls.filter((c) => c.key === "delegate").length, 2);
	assert.equal(h.widgets.has("delegate"), false);
});

test("thinking-only deltas stay generic and identical board strings do not request repaints", () => {
	const h = host(); const board = new JobBoard(draw);
	for (const thinking of ["SECRET one", "SECRET two", "SECRET three"]) {
		const line = formatJobBoard([{ id: "d0001", local: false, status: "running", thinking }], { maxLocalConcurrent: 1 })[0];
		assert.match(line, /d0001 thinking$/); assert.doesNotMatch(line, /SECRET/);
		board.paint(h.ui, "tui", line);
	}
	assert.equal(h.calls.length, 1); assert.equal(h.repaints(), 0);
	board.close(h.ui);
});

test("RPC publishes only changed string arrays and clears once, never a component factory", () => {
	const h = host(); const board = new JobBoard(draw);
	for (const line of [undefined, "working", "working", "reading", undefined, undefined]) board.paint(h.ui, "rpc", line);
	assert.deepEqual(h.calls.map((c) => c.content), [["working"], ["reading"], undefined]);
	board.close(h.ui); assert.equal(h.calls.length, 3);
	board.paint(h.ui, "rpc", "next"); board.close(h.ui);
	assert.deepEqual(h.calls.slice(-2).map((c) => c.content), [["next"], undefined]);
});

test("failed mount/send retries, dead repaint/close are isolated, and disposed widgets can remount", () => {
	const dead: any = { setWidget() { throw new Error("dead UI"); } };
	for (const mode of ["tui", "rpc"]) {
		const board = new JobBoard(draw); const h = host();
		assert.doesNotThrow(() => board.paint(dead, mode, "same text"));
		board.paint(h.ui, mode, "same text"); assert.ok(h.widgets.has("delegate"));
		if (mode === "tui") {
			h.breakRender(); assert.doesNotThrow(() => board.paint(h.ui, mode, "updated"));
			assert.deepEqual(h.widgets.get("delegate").render(80), ["updated"]);
			h.ui.setWidget("delegate", undefined);
			board.paint(h.ui, mode, "updated"); assert.ok(h.widgets.has("delegate"));
		}
		assert.doesNotThrow(() => board.close(dead));
		const recovered = host(); board.paint(recovered.ui, mode, "same text");
		assert.ok(recovered.widgets.has("delegate")); board.close(recovered.ui);
	}
});
