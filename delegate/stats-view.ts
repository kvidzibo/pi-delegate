import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { displayText } from "./stats.ts";

export type StatsScope = "session" | "today" | "all";
export interface StatsViewOptions {
	scope: StatsScope;
	load: (scope: StatsScope) => Promise<string>;
	signal?: AbortSignal;
}

/** Keep usage reports out of chat history; long reports scroll inside the dialog. */
export async function showStats(ctx: ExtensionCommandContext, report: string, options?: StatsViewOptions): Promise<void> {
	if (options?.signal?.aborted) return;
	if (!ctx.hasUI) { ctx.ui.notify(report, "info"); return; }
	if (ctx.mode !== "tui") { await ctx.ui.select(report, ["Back"], { signal: options?.signal }); return; }
	await ctx.ui.custom<void>((tui, theme, keys, done) => {
		let scope = options?.scope ?? "session";
		let loading = false, error = "", request = 0, disposed = false;
		let text = new Text(report, 0, 0);
		let offset = 0, total = 0;
		const pageSize = () => Math.max(1, tui.terminal.rows - 8);
		const changeScope = (next: StatsScope) => {
			if (!options || (next === scope && !error)) return;
			scope = next;
			const id = ++request;
			loading = true; error = ""; offset = 0; tui.requestRender();
			Promise.resolve().then(() => options.load(next)).then(value => {
				if (disposed || id !== request) return;
				loading = false; text = new Text(value, 0, 0); tui.requestRender();
			}).catch(reason => {
				if (disposed || id !== request) return;
				loading = false; error = displayText(reason instanceof Error ? reason.message : String(reason)); tui.requestRender();
			});
		};
		const close = () => { disposed = true; done(); };
		options?.signal?.addEventListener("abort", close, { once: true });
		return {
			render(width: number) {
				const lines = loading ? ["Loading…"] : error ? new Text(`Could not load report: ${error}\nPress the scope key to retry.`, 0, 0).render(width) : text.render(width);
				total = lines.length;
				const size = pageSize();
				offset = Math.min(offset, Math.max(0, total - size));
				return [
					theme.fg("accent", theme.bold(`pi-delegate · stats · ${scope}`)),
					...(options ? [["session", "today", "all"].map((value, i) => theme.fg(value === scope ? "accent" : "dim", `${i + 1} ${value}`)).join(" · ")] : []),
					...lines.slice(offset, offset + size),
					theme.fg("dim", "↑↓ scroll · PgUp/PgDn · Home/End"),
					theme.fg("dim", `esc back · ${offset + 1}–${Math.min(total, offset + size)}/${total}`),
				].map(line => truncateToWidth(line, width));
			},
			invalidate() { text.invalidate(); },
			handleInput(data: string) {
				if (keys.matches(data, "tui.select.cancel")) { close(); return; }
				const scopeKey = ["1", "2", "3"].findIndex(key => matchesKey(data, key));
				if (options && scopeKey !== -1) {
					changeScope((["session", "today", "all"] as const)[scopeKey]); return;
				}
				const max = Math.max(0, total - pageSize());
				if (keys.matches(data, "tui.select.up")) offset = Math.max(0, offset - 1);
				else if (keys.matches(data, "tui.select.down")) offset = Math.min(max, offset + 1);
				else if (keys.matches(data, "tui.select.pageUp")) offset = Math.max(0, offset - pageSize());
				else if (keys.matches(data, "tui.select.pageDown")) offset = Math.min(max, offset + pageSize());
				else if (matchesKey(data, "home")) offset = 0;
				else if (matchesKey(data, "end")) offset = max;
				tui.requestRender();
			},
			dispose() { disposed = true; request++; options?.signal?.removeEventListener("abort", close); },
		};
	}, { overlay: true, overlayOptions: { width: "100%", margin: 0 } });
}
