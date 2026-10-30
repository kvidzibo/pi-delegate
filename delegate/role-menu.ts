import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, truncateToWidth, type SettingItem } from "@earendil-works/pi-tui";

/** Native settings rows cycle short choices in place; actions return to the caller. */
export async function roleMenu(
	ctx: ExtensionCommandContext, title: string, items: SettingItem[], signal: AbortSignal,
	onChange: (id: string, value: string) => void,
): Promise<string | undefined> {
	if (signal.aborted) return undefined;
	return ctx.ui.custom<string | undefined>((tui, theme, keys, done) => {
		const cancel = () => done(undefined);
		const container = new Container();
		container.addChild(new DynamicBorder());
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 0, 0));
		const rows = items.map(item => item.values ? item : { ...item, submenu: () => { done(item.id); return new Text("", 0, 0); } });
		const list = new SettingsList(rows, Math.max(1, Math.min(items.length, tui.terminal.rows - 6)), getSettingsListTheme(),
			(id, value) => {
				if (items.find(item => item.id === id)?.values) onChange(id, value);
				else done(id);
			}, cancel);
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", "Save role applies to future jobs; Back discards the draft."), 0, 0));
		container.addChild(new DynamicBorder());
		signal.addEventListener("abort", cancel, { once: true });
		let usable = false;
		let geometry = "";
		return {
			render(width: number) {
				geometry = `${tui.terminal.rows}:${tui.terminal.columns}`;
				const lines = container.render(width);
				usable = width >= 20 && lines.length <= tui.terminal.rows - 6;
				return usable ? lines : [truncateToWidth("Enlarge terminal; Esc goes back", width)];
			},
			invalidate: () => container.invalidate(),
			handleInput(data: string) {
				if (keys.matches(data, "tui.select.cancel")) cancel();
				else if (usable && geometry === `${tui.terminal.rows}:${tui.terminal.columns}`) list.handleInput(data);
				tui.requestRender();
			},
			dispose() { signal.removeEventListener("abort", cancel); },
		};
	});
}
