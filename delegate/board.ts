import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Component, Container } from "@earendil-works/pi-tui";
import type { ThemeFg } from "./display.ts";
import { mountBottomDock } from "./dock.ts";

export type BoardUi = Pick<ExtensionUIContext, "setWidget"> & Partial<Pick<ExtensionUIContext, "getToolsExpanded">>;
export const BOARD_MAX_ROWS = 12;
export const plainBoardTheme: ThemeFg = { fg: (_color, text) => text, bold: (text) => text, italic: (text) => text };
type Draw<T> = (state: T, width: number, maxRows: number, theme: ThemeFg, expanded: boolean) => string[];

/** Mount once: Pi's setWidget removes/reinserts its key, changing widget order. */
export class JobBoard<T = string> {
	private state: T | undefined;
	private stateKey: string | undefined;
	private sent: string | undefined;
	private mounted = false;
	private widget: Component | undefined;
	private requestRender: (() => void) | undefined;
	private readonly draw: Draw<T>;
	private readonly createContainer: (() => Container) | undefined;
	private readonly rpcLines: (state: T) => string[];
	private disposeDock: (() => void) | undefined;

	constructor(draw: Draw<T>, createContainer?: () => Container, rpcLines: (state: T) => string[] = (state) => [String(state)]) {
		this.draw = draw;
		this.createContainer = createContainer;
		this.rpcLines = rpcLines;
	}

	private releaseDock(): void {
		const dispose = this.disposeDock;
		this.disposeDock = undefined;
		try { dispose?.(); } catch { /* UI may already be gone. */ }
	}

	paint(ui: BoardUi, mode: string | undefined, state: T | undefined): void {
		try {
			if (mode !== "tui") {
				// RPC supports string widgets, not component factories.
				const lines = state === undefined ? undefined : this.rpcLines(state);
				const key = JSON.stringify(lines);
				if (key !== this.sent) {
					ui.setWidget("delegate", lines);
					this.sent = key;
				}
				return;
			}
			// State is a display-only projection: no raw thinking, usage or clocks.
			const key = JSON.stringify(state), changed = this.stateKey !== key;
			this.state = state; this.stateKey = key;
			if (!this.mounted && state !== undefined) {
				ui.setWidget("delegate", (tui, theme) => {
					let availableRows = Infinity;
					this.requestRender = () => tui.requestRender();
					const component = {
						render: (width: number) => {
							if (this.state === undefined) return [];
							const limit = Math.max(0, Math.min(BOARD_MAX_ROWS, Math.floor((tui.terminal?.rows ?? 24) / 2), tui.mode === "regular" ? availableRows : Infinity));
							return this.draw(this.state, width, limit, theme ?? plainBoardTheme, ui.getToolsExpanded?.() ?? false).slice(0, limit);
						},
						invalidate() {},
						dispose: () => {
							if (this.widget !== component) return;
							this.releaseDock(); this.widget = undefined; this.mounted = false; this.requestRender = undefined;
						},
					};
					this.widget = component;
					if (this.createContainer) this.disposeDock = mountBottomDock(tui, component, () => this.state !== undefined, this.createContainer(), (rows) => { availableRows = rows; });
					return component;
				}, { placement: "aboveEditor" });
				this.mounted = true;
			} else if (changed) {
				this.requestRender?.();
			}
		} catch {
			if (!this.mounted) { this.releaseDock(); this.widget = undefined; this.requestRender = undefined; }
			/* A dead UI must not affect jobs or accounting. */
		}
	}

	close(ui?: BoardUi): void {
		try {
			if (this.mounted || this.sent !== undefined) ui?.setWidget("delegate", undefined);
		} catch { /* UI may already be gone. */ }
		this.releaseDock();
		this.state = undefined; this.stateKey = this.sent = undefined;
		this.widget = undefined; this.mounted = false; this.requestRender = undefined;
	}
}
