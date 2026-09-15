import assert from "node:assert/strict";
import { test } from "node:test";
import type { Component, Container, TUI } from "@earendil-works/pi-tui";
import { mountBottomDock } from "../dock.ts";
import { JobBoard } from "../board.ts";

// Only structure/lifecycle here; native Container identity, renderer frames and
// screen coordinates are exercised through the installed CLI in panel.ts.
class TestContainer {
	children: Component[] = [];
	render(width: number): string[] { return this.children.flatMap((child) => child.render(width)); }
	invalidate(): void { for (const child of this.children) child.invalidate(); }
}
const container = () => new TestContainer() as unknown as Container;
function content(lines: string[]) {
	return { lines, paints: 0, invalidations: 0,
		render() { this.paints++; return [...this.lines]; }, invalidate() { this.invalidations++; } };
}
function setup() {
	const transcript = content(["output"]), widget = content(["delegate"]), editor = content(["editor"]), footer = content(["footer"]);
	const widgets = container(); widgets.children.push(widget);
	const roots = [transcript, widgets, editor, footer];
	const tui = { mode: "regular", terminal: { rows: 10 }, children: [...roots] } as unknown as TUI;
	let active = true;
	const dock = container();
	const dispose = mountBottomDock(tui, widget, () => active, dock);
	return { tui, dock, dispose, roots, transcript, widget, editor, footer, setActive: (next: boolean) => { active = next; } };
}

test("bottom dock fills only spare rows, preserves content order, and renders each component once", () => {
	const h = setup();
	assert.deepEqual(h.tui.children, [h.dock]);
	assert.deepEqual(h.dock.render(80), ["output", "", "", "", "", "", "", "delegate", "editor", "footer"]);
	for (const component of [h.transcript, h.widget, h.editor, h.footer]) assert.equal(component.paints, 1);
	h.dock.invalidate();
	for (const component of [h.transcript, h.widget, h.editor, h.footer]) assert.equal(component.invalidations, 1);
	h.transcript.lines.push(...Array.from({ length: 20 }, (_, i) => `output ${i}`));
	assert.deepEqual(h.dock.render(80), [...h.transcript.lines, "delegate", "editor", "footer"]);
	h.dispose(); h.dispose();
	assert.deepEqual(h.tui.children, h.roots);
	assert.deepEqual(h.dock.render(80), [], "detached wrapper releases its child references");
});

test("card sizing accounts for editor/footer and sibling widgets without rendering them twice", () => {
	const transcript = content(["output"]), sibling = content(["other", "other"]), editor = content(["input", "input", "input"]), footer = content(["footer"]);
	let budget = 0, paints = 0;
	const widget = { render() { paints++; return Array(budget).fill("card"); }, invalidate() {} };
	const widgets = container(); widgets.children.push(widget, sibling);
	const tui = { mode: "regular", terminal: { rows: 12 }, children: [transcript, widgets, editor, footer] } as unknown as TUI;
	const dock = container();
	const dispose = mountBottomDock(tui, widget, () => true, dock, (rows) => { budget = rows; });
	assert.deepEqual(dock.render(80), ["output", ...Array(5).fill("card"), "other", "other", "input", "input", "input", "footer"]);
	assert.equal(budget, 5); assert.equal(paints, 1);
	for (const component of [transcript, sibling, editor, footer]) assert.equal(component.paints, 1);
	Object.assign(tui.terminal, { rows: 6 });
	assert.ok(!dock.render(80).includes("card")); assert.equal(budget, 0, "the panel yields to an oversized input dock");
	dispose();
});

test("small shrinks retain bottom alignment; large collapses and resizes discard old padding", () => {
	const h = setup();
	h.transcript.lines = Array.from({ length: 30 }, (_, i) => `output ${i}`);
	assert.equal(h.dock.render(80).length, 33);
	h.transcript.lines.pop();
	assert.deepEqual(h.dock.render(80).slice(-4), ["", "delegate", "editor", "footer"]);
	assert.equal(h.dock.render(80).length, 33);
	h.transcript.lines = ["collapsed"];
	assert.equal(h.dock.render(80).length, 10, "do not retain pages of artificial scrollback");
	Object.assign(h.tui.terminal, { rows: 6 });
	assert.deepEqual(h.dock.render(20), ["collapsed", "", "", "delegate", "editor", "footer"]);
	Object.assign(h.tui.terminal, { rows: 1 });
	assert.deepEqual(h.dock.render(20), ["collapsed", "delegate", "editor", "footer"], "never drop native content to force a dock into a tiny terminal");
	h.dispose();
});

test("idle and fullscreen rendering remain native; reuse restores anchoring", () => {
	const h = setup();
	h.dock.render(80);
	h.setActive(false);
	assert.deepEqual(h.dock.render(80), ["output", "delegate", "editor", "footer"]);
	h.setActive(true);
	Object.assign(h.tui, { mode: "fullscreen" });
	assert.deepEqual(h.dock.render(80), ["output", "delegate", "editor", "footer"]);
	Object.assign(h.tui, { mode: "regular" });
	assert.equal(h.dock.render(80).length, 10);
	h.dispose();
});

test("cleanup follows a replaced renderer through Pi's stable reference", () => {
	const h = setup(); h.dispose();
	let renderer = h.tui;
	const reference = new Proxy({} as TUI, { get: (_target, key) => Reflect.get(renderer, key) });
	const dock = container();
	const dispose = mountBottomDock(reference, h.widget, () => true, dock);
	const extra = content(["other extension"]);
	renderer = { ...h.tui, children: [dock, extra] } as TUI;
	dispose();
	assert.deepEqual(renderer.children, [...h.roots, extra]);
});

test("cleanup preserves later foreign roots and nested wrappers", () => {
	const h = setup();
	const extra = content(["other extension"]), widget = content(["another widget"]);
	const outer = container(); outer.children.push(h.dock, widget);
	h.tui.children = [outer, extra];
	h.dispose();
	assert.deepEqual(h.tui.children, [outer, extra]);
	assert.deepEqual(outer.children, [...h.roots, widget]);
});

test("missing widget and unsupported hosts pass through without destructive layout changes", () => {
	const h = setup();
	h.dispose();
	const dock = container(); const absent = content(["absent"]);
	const dispose = mountBottomDock(h.tui, absent, () => true, dock);
	assert.deepEqual(dock.render(80), ["output", "delegate", "editor", "footer"]);
	dispose(); assert.deepEqual(h.tui.children, h.roots);
	const unsupported = { children: [...h.roots] } as unknown as TUI;
	mountBottomDock(unsupported, h.widget, () => true, container())();
	assert.deepEqual(unsupported.children, h.roots);
});

test("board removes its layout wrapper even when the UI's clear callback is dead", () => {
	const transcript = content(["output"]), widgets = container(), editor = content(["editor"]);
	const roots = [transcript, widgets, editor];
	const tui = { mode: "regular", terminal: { rows: 10 }, children: [...roots], requestRender() {} } as unknown as TUI;
	const ui: any = { setWidget(_key: string, factory: any) {
		widgets.children = factory ? [factory(tui)] : [];
	} };
	const board = new JobBoard((line) => [line], container);
	board.paint(ui, "tui", "delegate");
	assert.equal(tui.children.length, 1);
	assert.equal(tui.children[0].render(80).length, 10);
	board.close({ setWidget() { throw new Error("dead UI"); } });
	assert.deepEqual(tui.children, roots);
	assert.deepEqual(widgets.render(80), [], "stale mounted widget is inert even if removal failed");
});
