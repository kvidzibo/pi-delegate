import { DynamicBorder, getSettingsListTheme, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, Text, truncateToWidth, type SettingItem } from "@earendil-works/pi-tui";

/** Native settings rows cycle short choices in place; actions return to the caller. */
export async function roleMenu(
	ctx: ExtensionCommandContext, title: string, items: SettingItem[], signal: AbortSignal,
	onChange: (id: string, value: string) => void,
): Promise<string | undefined> {
	if (signal.aborted) return undefined;
	return ctx.ui.custom<string | undefined>((tui, theme, keys, done) => {
		const cancel = () => done(undefined);
		const border = new DynamicBorder();
		const heading = new Text(theme.fg("accent", theme.bold(title)), 0, 0);
		const footer = new Text(theme.fg("dim", "Save role applies to future jobs; Back discards the draft."), 0, 0);
		const rows = items.map(item => item.values ? item : { ...item, submenu: () => { done(item.id); return new Text("", 0, 0); } });
		let selected = 0, capacity = 0;
		let list: SettingsList;
		const resize = (visible: number) => {
			if (visible === capacity) return;
			capacity = visible;
			list = new SettingsList(rows, visible, getSettingsListTheme(), onChange, cancel);
			list.selectItem(rows[selected].id);
		};
		signal.addEventListener("abort", cancel, { once: true });
		let usable = false;
		let geometry = "";
		return {
			render(width: number) {
				geometry = `${tui.terminal.rows}:${tui.terminal.columns}`;
				const height = Math.max(1, tui.terminal.rows - 6);
				const frame = () => [...border.render(width), ...heading.render(width), ...list.render(width), ...footer.render(width), ...border.render(width)];
				resize(Math.max(1, Math.min(rows.length, height - 6)));
				let lines = frame();
				// Descriptions, wrapping and native scroll/hint rows all consume the same budget.
				while (lines.length > height && capacity > 1) { resize(capacity - 1); lines = frame(); }
				usable = width >= 20 && lines.length <= height;
				return usable ? lines : [truncateToWidth("Enlarge terminal; Esc goes back", width)];
			},
			invalidate() { heading.invalidate(); footer.invalidate(); list?.invalidate(); },
			handleInput(data: string) {
				if (keys.matches(data, "tui.select.cancel")) cancel();
				else if (usable && geometry === `${tui.terminal.rows}:${tui.terminal.columns}`) {
					// SettingsList has selectItem but no selection getter or viewport setter.
					// Track native up/down navigation so resizing can rebuild without losing focus.
					if (keys.matches(data, "tui.select.up")) selected = (selected + rows.length - 1) % rows.length;
					else if (keys.matches(data, "tui.select.down")) selected = (selected + 1) % rows.length;
					list.handleInput(data);
				}
				tui.requestRender();
			},
			dispose() { signal.removeEventListener("abort", cancel); },
		};
	});
}
