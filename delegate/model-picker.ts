import { keyHint, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Input, SelectList, fuzzyFilter, truncateToWidth } from "@earendil-works/pi-tui";

export interface AvailableModel {
	provider: string;
	id: string;
	name: string;
}

export function modelId(model: AvailableModel): string {
	return `${model.provider}/${model.id}`;
}

/** Available models in the `/model` scope; empty when no scope is set. */
export function scopedDelegateModels(
	available: readonly AvailableModel[],
	scopedModels: readonly { model: { provider: string; id: string } }[] | undefined,
): AvailableModel[] {
	if (!scopedModels?.length) return [];
	const allowed = new Set(scopedModels.map(item => `${item.model.provider}/${item.model.id}`));
	return available.filter(model => allowed.has(modelId(model)));
}

/** Like `/model`: starts on scoped models when a scope is set; the scope toggles to all available models. */
export async function pickDelegateModel(
	ctx: ExtensionCommandContext, kind: string, current: string, models: AvailableModel[], scopedModels: AvailableModel[],
	signal: AbortSignal,
): Promise<string | undefined> {
	if (signal.aborted) return undefined;
	const sort = (list: AvailableModel[]) => [...list].sort((a, b) => Number(modelId(b) === current) - Number(modelId(a) === current)
		|| modelId(a).localeCompare(modelId(b)));
	const lists = { all: sort(models), scoped: sort(scopedModels) };
	const toggle = lists.scoped.length > 0;
	let scope: keyof typeof lists = toggle ? "scoped" : "all";
	const other = () => scope === "all" ? "scoped" : "all";
	if (ctx.mode !== "tui") {
		while (!signal.aborted) {
			const sorted = lists[scope];
			const switchLabel = `Show ${other()} models…`;
			const options = [...sorted.map(model => `${modelId(model)}${modelId(model) === current ? " ✓ current" : ""}`), ...(toggle ? [switchLabel] : [])];
			const choice = await ctx.ui.select(`Model for ${kind}\nCurrent: ${current}${toggle ? `\nScope: ${scope}` : ""}`, options, { signal });
			if (toggle && choice === switchLabel) { scope = other(); continue; }
			const index = options.indexOf(choice ?? "");
			return index < 0 || index >= sorted.length ? undefined : modelId(sorted[index]);
		}
		return undefined;
	}
	return ctx.ui.custom<string | undefined>((tui, theme, keys, done) => {
		const search = new Input();
		let sorted = lists[scope];
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
		const applyFilter = () => {
			filtered = fuzzyFilter(sorted, search.getValue(), model => `${modelId(model)} ${model.name}`);
			list = makeList();
		};
		const scopeLabel = (value: typeof scope) => theme.fg(value === scope ? "accent" : "muted", value);
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
					// One line, as before the toggle, so short terminals keep the same list height.
					...(toggle ? [`${theme.fg("muted", "Scope: ")}${scopeLabel("all")}${theme.fg("muted", " | ")}${scopeLabel("scoped")}${theme.fg("muted", " · ")}${keyHint("tui.input.tab", "toggle")}`] : []),
					"Search by provider, model ID or name:", ...search.render(width), "",
					...list.render(width), "",
					theme.fg("dim", `${filtered.length}/${sorted.length} ${scope === "scoped" ? "scoped" : "available"} · ↑↓ navigate · enter select · esc back`),
				].map(line => truncateToWidth(line, width));
			},
			invalidate() { search.invalidate(); list.invalidate(); },
			handleInput(data: string) {
				const navigation = ["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const;
				if (keys.matches(data, "tui.input.tab")) {
					if (toggle) { scope = other(); sorted = lists[scope]; applyFilter(); }
				} else if (navigation.some(key => keys.matches(data, key))) {
					list.handleInput(data);
				} else {
					const previous = search.getValue();
					search.handleInput(data);
					if (search.getValue() !== previous) applyFilter();
				}
				tui.requestRender();
			},
			dispose() { signal.removeEventListener("abort", cancel); },
		};
	});
}
