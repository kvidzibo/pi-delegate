import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface DelegateOption {
	name: string;
	description: string;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	complete?: (prefix: string) => string[];
}

/** Optional extensions contribute options without registering additional slash commands. */
export const OPTIONS_EVENT = "pi-delegate:options";

export function registerDelegateCommand(pi: ExtensionAPI, defaults: DelegateOption[]): void {
	const options = () => {
		const result = [...defaults];
		pi.events.emit(OPTIONS_EVENT, result);
		return result;
	};
	pi.registerCommand("pi-delegate", {
		description: "Delegate settings and usage: models, stats.",
		getArgumentCompletions: (prefix) => {
			const entries = options();
			const match = prefix.trimStart().match(/^(\S+)\s+(.*)$/s);
			if (match) return (entries.find(option => option.name === match[1])?.complete?.(match[2]) ?? [])
				.map(value => ({ value: `${match[1]} ${value}`, label: value }));
			return entries.filter(option => option.name.startsWith(prefix.trim()))
				.map(option => ({ value: option.name, label: `${option.name} — ${option.description}` }));
		},
		handler: async (args, ctx) => {
			const entries = options();
			const input = args.trim();
			let name = input.match(/^\S+/)?.[0];
			const rest = name ? input.slice(name.length).trim() : "";
			if (!name && ctx.hasUI) {
				name = await ctx.ui.select("pi-delegate", entries.map(option => option.name));
				if (name === undefined) return;
			}
			const option = entries.find(option => option.name === name);
			if (!option) {
				ctx.ui.notify(`Usage: /pi-delegate <${entries.map(option => option.name).join("|")}>`, "warning");
				return;
			}
			await option.handler(rest, ctx);
		},
	});
}
