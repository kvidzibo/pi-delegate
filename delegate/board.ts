import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

export type BoardUi = Pick<ExtensionUIContext, "setWidget">;

/** Mount once: Pi's setWidget removes/reinserts its key, changing widget order. */
export class JobBoard {
	private line: string | undefined;
	private sent: string | undefined;
	private mounted = false;
	private requestRender: (() => void) | undefined;
	private readonly renderLine: (line: string, width: number) => string[];

	constructor(renderLine: (line: string, width: number) => string[]) {
		this.renderLine = renderLine;
	}

	paint(ui: BoardUi, mode: string | undefined, line: string | undefined): void {
		try {
			if (mode !== "tui") {
				// RPC supports string widgets, not component factories. Suppress identical sends.
				if (line !== this.sent) {
					ui.setWidget("delegate", line === undefined ? undefined : [line]);
					this.sent = line;
				}
				return;
			}
			const changed = this.line !== line;
			this.line = line;
			if (!this.mounted && line !== undefined) {
				ui.setWidget("delegate", (tui) => {
					this.requestRender = () => tui.requestRender();
					return {
						render: (width) => this.line === undefined ? [] : this.renderLine(this.line, width),
						invalidate() {},
						dispose: () => { this.mounted = false; this.requestRender = undefined; },
					};
				}, { placement: "aboveEditor" });
				this.mounted = true;
			} else if (changed) {
				this.requestRender?.();
			}
		} catch { /* A dead UI must not affect jobs or accounting. */ }
	}

	close(ui?: BoardUi): void {
		try {
			if (this.mounted || this.sent !== undefined) ui?.setWidget("delegate", undefined);
		} catch { /* UI may already be gone. */ }
		this.line = this.sent = undefined;
		this.mounted = false;
		this.requestRender = undefined;
	}
}
