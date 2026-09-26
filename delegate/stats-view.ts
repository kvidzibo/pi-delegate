import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";

/** Keep usage reports out of chat history; long reports scroll inside the dialog. */
export async function showStats(ctx: ExtensionCommandContext, report: string): Promise<void> {
	if (!ctx.hasUI) { ctx.ui.notify(report, "info"); return; }
	if (ctx.mode !== "tui") { await ctx.ui.select(report, ["Back"]); return; }
	await ctx.ui.custom<void>((tui, theme, keys, done) => {
		const text = new Text(report, 0, 0);
		let offset = 0, total = 0;
		const pageSize = () => Math.max(1, tui.terminal.rows - 10);
		return {
			render(width: number) {
				const lines = text.render(width);
				total = lines.length;
				const size = pageSize();
				offset = Math.min(offset, Math.max(0, total - size));
				return [
					theme.fg("accent", theme.bold("pi-delegate · stats")), "",
					...lines.slice(offset, offset + size), "",
					theme.fg("dim", `↑↓ scroll · esc back · ${offset + 1}–${Math.min(total, offset + size)}/${total}`),
				].map(line => truncateToWidth(line, width));
			},
			invalidate() { text.invalidate(); },
			handleInput(data: string) {
				if (keys.matches(data, "tui.select.cancel")) { done(); return; }
				if (keys.matches(data, "tui.select.up")) offset = Math.max(0, offset - 1);
				if (keys.matches(data, "tui.select.down")) offset = Math.min(Math.max(0, total - pageSize()), offset + 1);
				tui.requestRender();
			},
		};
	}, { overlay: true, overlayOptions: { width: "100%", margin: 0 } });
}
