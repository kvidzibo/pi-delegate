import type { Component, Container, TUI } from "@earendil-works/pi-tui";

function parentOf(root: { children: Component[] }, target: Component): { children: Component[] } | undefined {
	const pending = [root];
	const seen = new Set<object>();
	while (pending.length) {
		const node = pending.pop()!;
		if (seen.has(node)) continue;
		seen.add(node);
		if (node.children.includes(target)) return node;
		for (const child of node.children) {
			const children = (child as Partial<Container>).children;
			if (Array.isArray(children)) pending.push(child as Container);
		}
	}
	return undefined;
}

/**
 * Regular Pi renders a flowing component tree, not a fixed input dock. Group the
 * existing roots in a native Container and fill unused rows before the widget.
 * Render each original component once; never replace the editor/footer, patch
 * the renderer, or write terminal escapes. Fullscreen keeps its own layout root.
 * The injected Container keeps this adapter testable without installing Pi.
 */
export function mountBottomDock(tui: TUI, widget: Component, active: () => boolean, dock: Container, fitWidget?: (rows: number) => void): () => void {
	if (!Array.isArray(tui.children) || !tui.terminal) return () => {};
	const baseRender = dock.render.bind(dock);
	let boundary: Component | undefined;
	let previousWidth = 0, previousRows = 0, previousLength = 0;
	let disposed = false;
	dock.children = [...tui.children];
	dock.render = (width) => {
		const rows = tui.terminal.rows;
		if (disposed || tui.mode !== "regular" || !active() || width < 1 || rows < 1) {
			previousLength = 0;
			return baseRender(width);
		}
		if (!boundary || !dock.children.includes(boundary)) {
			boundary = dock.children.find((child) => child === widget || parentOf({ children: [child] }, widget));
		}
		if (!boundary) return baseRender(width);
		const boundaryIndex = dock.children.indexOf(boundary);
		let parts: string[][];
		if (fitWidget) {
			// Measure the editor/footer and other widgets once before sizing the
			// card. Only flatten Pi's plain widget Container, never custom layouts.
			parts = dock.children.map((child) => child === boundary ? [] : child.render(width));
			const trailing = parts.slice(boundaryIndex + 1).reduce((sum, lines) => sum + lines.length, 0);
			const group = boundary as Container;
			const plainGroup = Object.getPrototypeOf(group) === Object.getPrototypeOf(dock)
				&& group.render === Object.getPrototypeOf(dock).render && group.children.includes(widget);
			if (plainGroup) {
				const siblings = group.children.map((child) => child === widget ? [] : child.render(width));
				const occupied = siblings.reduce((sum, lines) => sum + lines.length, 0);
				fitWidget(Math.max(0, rows - trailing - occupied - 1)); // Reserve one transcript row.
				siblings[group.children.indexOf(widget)] = widget.render(width);
				parts[boundaryIndex] = siblings.flat();
			} else {
				fitWidget(Math.max(0, rows - trailing - 2));
				parts[boundaryIndex] = boundary.render(width);
			}
		} else parts = dock.children.map((child) => child.render(width));
		const lines: string[] = [];
		let dockStart = 0;
		for (let i = 0; i < parts.length; i++) {
			if (i === boundaryIndex) dockStart = lines.length;
			for (const line of parts[i]) lines.push(line);
		}
		let targetLength = Math.max(rows, lines.length);
		// Native regular rendering retains its viewport after a small shrink.
		// Keep that space above the dock, not below the footer. Large collapses
		// must reflow normally rather than retaining pages of artificial blanks.
		const gap = previousLength - lines.length;
		const dockHeight = lines.length - dockStart;
		if (width === previousWidth && rows === previousRows && gap > 0 && gap < rows - dockHeight) {
			targetLength = Math.max(targetLength, previousLength);
		}
		const padding = targetLength - lines.length;
		if (padding) lines.splice(dockStart, 0, ...Array<string>(padding).fill(""));
		previousWidth = width; previousRows = rows; previousLength = lines.length;
		return lines;
	};
	tui.children.splice(0, tui.children.length, dock);
	return () => {
		if (disposed) return;
		disposed = true;
		// Preserve other extensions' later roots/wrappers and the current renderer
		// when Pi has switched regular/fullscreen through its stable TUI reference.
		const parent = parentOf(tui, dock);
		if (parent) parent.children.splice(parent.children.indexOf(dock), 1, ...dock.children);
		dock.children = [];
		dock.render = baseRender;
	};
}
