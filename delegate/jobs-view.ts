import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { JobBoardState } from "./panel.ts";
import { renderChildCall, renderChildResult, type RowState } from "./view.ts";
import { plainBoardTheme } from "./board.ts";

/** Browse every active job without expanding the editor dock or changing job state. */
export async function showJobs(ctx: ExtensionCommandContext, read: () => JobBoardState | undefined, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return;
	const renderCards = (state: JobBoardState | undefined, width: number, theme: typeof plainBoardTheme): string[] => {
		if (!state?.cards.length) return ["No active delegates. Finished results are in the transcript."];
		return state.cards.flatMap(details => {
			const row: RowState = { details, expanded: true, isPartial: true, collect: false, live: true, pinned: true };
			const input = { theme, read: () => row };
			return [...renderChildCall(input).render(width), ...renderChildResult(input).render(width), ""];
		});
	};
	if (ctx.mode !== "tui") {
		const report = renderCards(read(), 100, plainBoardTheme).join("\n");
		if (ctx.hasUI) await ctx.ui.select(report, ["Back"], { signal });
		else ctx.ui.notify(report, "info");
		return;
	}
	await ctx.ui.custom<void>((tui, theme, keys, done) => {
		let offset = 0, total = 0;
		const pageSize = () => Math.max(1, tui.terminal.rows - 8);
		let state = read(), previous = JSON.stringify(state);
		const timer = setInterval(() => {
			const next = read(), serialized = JSON.stringify(next);
			if (serialized !== previous) { state = next; previous = serialized; tui.requestRender(); }
		}, 500);
		const close = () => { clearInterval(timer); done(); };
		signal?.addEventListener("abort", close, { once: true });
		return {
			render(width: number) {
				const lines = renderCards(state, width, theme);
				total = lines.length;
				offset = Math.min(offset, Math.max(0, total - pageSize()));
				return [theme.fg("accent", theme.bold(`pi-delegate · jobs · ${state?.cards.length ?? 0} active`)),
					...lines.slice(offset, offset + pageSize()),
					theme.fg("dim", `${offset + 1}–${Math.min(total, offset + pageSize())}/${total} · ↑↓ PgUp/PgDn Home/End · esc back`),
				].map(line => truncateToWidth(line, width));
			},
			invalidate() {},
			handleInput(data: string) {
				if (keys.matches(data, "tui.select.cancel")) { close(); return; }
				if (keys.matches(data, "tui.select.up")) offset--;
				if (keys.matches(data, "tui.select.down")) offset++;
				if (keys.matches(data, "tui.select.pageUp")) offset -= pageSize();
				if (keys.matches(data, "tui.select.pageDown")) offset += pageSize();
				if (matchesKey(data, "home")) offset = 0;
				if (matchesKey(data, "end")) offset = total;
				offset = Math.max(0, Math.min(offset, Math.max(0, total - pageSize())));
				tui.requestRender();
			},
			dispose() { clearInterval(timer); signal?.removeEventListener("abort", close); },
		};
	}, { overlay: true, overlayOptions: { width: "100%", margin: 0 } });
}
