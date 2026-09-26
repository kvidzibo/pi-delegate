import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Input, SelectList, fuzzyFilter, truncateToWidth } from "@earendil-works/pi-tui";

export interface AvailableModel {
	provider: string;
	id: string;
	name: string;
}

export function modelId(model: AvailableModel): string {
	return `${model.provider}/${model.id}`;
}

/** Same list as `/model`: scoped models when a scope is set, otherwise every available model. */
export function selectableDelegateModels(
	available: readonly AvailableModel[],
	scopedModels: readonly { model: { provider: string; id: string } }[] | undefined,
): AvailableModel[] {
	if (!scopedModels?.length) return [...available];
	const allowed = new Set(scopedModels.map(item => `${item.model.provider}/${item.model.id}`));
	return available.filter(model => allowed.has(modelId(model)));
}

export async function pickDelegateModel(
	ctx: ExtensionCommandContext, kind: string, current: string, models: AvailableModel[], signal: AbortSignal,
	scoped = false,
): Promise<string | undefined> {
	if (signal.aborted) return undefined;
	const sorted = [...models].sort((a, b) => Number(modelId(b) === current) - Number(modelId(a) === current)
		|| modelId(a).localeCompare(modelId(b)));
	if (ctx.mode !== "tui") {
		const options = sorted.map(model => `${modelId(model)}${modelId(model) === current ? " ✓ current" : ""}`);
		const choice = await ctx.ui.select(`Model for ${kind}\nCurrent: ${current}${scoped ? "\nSame models as /model" : ""}`, options, { signal });
		const index = options.indexOf(choice ?? "");
		return index < 0 ? undefined : modelId(sorted[index]);
	}
	return ctx.ui.custom<string | undefined>((tui, theme, keys, done) => {
		const search = new Input();
		let filtered = sorted;
		const visibleRows = () => Math.max(1, Math.min(12, tui.terminal.rows - 10));
		let visible = visibleRows();
		const finish = (value: string | undefined) => done(value);
		const cancel = () => finish(undefined);
		const makeList = () => {
			const list = new SelectList(filtered.map(model => ({
				value: modelId(model), label: `${modelId(model)}${modelId(model) === current ? " ✓ current" : ""}`,
			})), visible, {
				selectedPrefix: text => theme.fg("accent", text), selectedText: text => theme.fg("accent", text),
				description: text => theme.fg("muted", text), scrollInfo: text => theme.fg("dim", text),
				noMatch: () => theme.fg("warning", "No matching models"),
			});
			list.onSelect = item => finish(item.value);
			list.onCancel = cancel;
			return list;
		};
		let list = makeList();
		signal.addEventListener("abort", cancel, { once: true });
		return {
			get focused() { return search.focused; },
			set focused(value: boolean) { search.focused = value; },
			render(width: number) {
				if (visible !== visibleRows()) {
					const selected = list.getSelectedItem()?.value;
					visible = visibleRows();
					list = makeList();
					list.setSelectedIndex(filtered.findIndex(model => modelId(model) === selected));
				}
				return [
					theme.fg("accent", theme.bold(`Delegate model · ${kind}`)),
					theme.fg("muted", `Current: ${current}`),
					...(scoped ? [theme.fg("muted", "Same models as /model.")] : []),
					"Search by provider, model ID or name:", ...search.render(width), "",
					...list.render(width), "",
					theme.fg("dim", `${filtered.length}/${sorted.length} ${scoped ? "scoped" : "available"} · ↑↓ navigate · enter select · esc back`),
				].map(line => truncateToWidth(line, width));
			},
			invalidate() { search.invalidate(); list.invalidate(); },
			handleInput(data: string) {
				const navigation = ["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const;
				if (navigation.some(key => keys.matches(data, key))) {
					list.handleInput(data);
				} else {
					const previous = search.getValue();
					search.handleInput(data);
					if (search.getValue() !== previous) {
						filtered = fuzzyFilter(sorted, search.getValue(), model => `${modelId(model)} ${model.name}`);
						list = makeList();
					}
				}
				tui.requestRender();
			},
			dispose() { signal.removeEventListener("abort", cancel); },
		};
	});
}
