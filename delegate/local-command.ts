import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LocalControl, localStatusText } from "./local-control.ts";

const STATUS_KEY = "delegate-local";

/** UI and polling are session-scoped; the switch and reservations are not. */
export class LocalCommand {
	private timer?: ReturnType<typeof setInterval>;
	private ui?: ExtensionContext["ui"];
	private lastStatus?: string;
	private closed = false;
	private dialog = new AbortController();
	private readonly control: LocalControl;
	private readonly wake: () => void;

	constructor(control: LocalControl, wake: () => void) {
		this.control = control;
		this.wake = wake;
	}

	start(ctx: Pick<ExtensionContext, "hasUI" | "ui">): void {
		this.closed = false;
		if (this.dialog.signal.aborted) this.dialog = new AbortController();
		this.ui = ctx.hasUI ? ctx.ui : undefined;
		this.lastStatus = undefined;
		this.refresh();
		if (!this.timer) {
			this.timer = setInterval(() => this.refresh(), 1000);
			this.timer.unref();
		}
	}

	refresh(): void {
		if (this.closed) return;
		this.wake();
		let text: string | undefined;
		try {
			const status = this.control.status();
			// Keep the ordinary ON footer uncluttered; the picker/status command always shows it.
			if (!status.enabled || status.uncertain) text = localStatusText(status);
		} catch { text = "Local delegation: unavailable · not safe to assume idle"; }
		if (text === this.lastStatus) return;
		try { this.ui?.setStatus(STATUS_KEY, text); this.lastStatus = text; }
		catch { /* UI observers must not affect admission or the shared switch. */ }
	}

	stop(): void {
		this.closed = true;
		this.dialog.abort();
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		try { this.ui?.setStatus(STATUS_KEY, undefined); } catch { /* disposed UI */ }
		this.ui = undefined;
	}

	async command(args: string, ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">): Promise<void> {
		const action = args.trim().toLowerCase();
		if (action && !["on", "off", "status"].includes(action)) {
			ctx.ui.notify("Usage: /delegate-local [on|off|status]", "warning"); return;
		}
		if (this.closed) return;
		try {
			let enabled: boolean | undefined;
			if (!action) {
				if (!ctx.hasUI) {
					ctx.ui.notify("Use /delegate-local on|off|status without an interactive picker.", "warning"); return;
				}
				const status = this.control.status();
				const on = `On${status.enabled ? " ✓ current" : ""}`;
				const off = `Off${!status.enabled ? " ✓ current" : ""}`;
				const options = status.enabled ? [on, off] : [off, on];
				const signal = this.dialog.signal;
				const choice = await ctx.ui.select(`${localStatusText(status)}\nAll Pi sessions using this agent directory`, options, { signal });
				if (this.closed || signal.aborted || choice === undefined) return;
				if (choice !== on && choice !== off) throw new Error("Invalid local delegation selection");
				enabled = choice === on;
			} else if (action !== "status") enabled = action === "on";
			if (enabled !== undefined) this.control.setEnabled(enabled);
			this.refresh();
			const status = this.control.status();
			const caution = status.uncertain ? `\nUnverified reservations in ${this.control.root}/active; verify their work has stopped before removing them.` : "";
			ctx.ui.notify(`${localStatusText(status)}\nShared across this agent directory. Hosted delegates are unchanged.${caution}`, status.uncertain ? "warning" : "info");
		} catch (error) {
			ctx.ui.notify(`Local delegation control unavailable: ${String(error)}. Do not assume idle.`, "error");
		}
	}
}
