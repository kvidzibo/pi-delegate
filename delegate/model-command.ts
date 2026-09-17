import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { KINDS, saveDelegateModel, type ConfigPaths, type DelegateConfig } from "./config.ts";
import { modelId, pickDelegateModel } from "./model-picker.ts";
import { isLocalModel } from "./tg.ts";

/** Changes affect future launches only. Accepted runners retain their agent object. */
export class ModelCommand {
	private readonly config: DelegateConfig;
	private readonly paths: ConfigPaths;
	private dialog = new AbortController();
	private busy = false;

	constructor(config: DelegateConfig, paths: ConfigPaths) {
		this.config = config;
		this.paths = paths;
	}

	stop(): void { this.dialog.abort(); }

	async command(args: string, ctx: ExtensionCommandContext): Promise<void> {
		if (args.trim()) { ctx.ui.notify("Usage: /delegate", "warning"); return; }
		if (!ctx.hasUI) { ctx.ui.notify("/delegate requires an interactive UI.", "warning"); return; }
		if (this.dialog.signal.aborted) return;
		if (this.busy) { ctx.ui.notify("Delegate model settings are already open.", "warning"); return; }
		this.busy = true;
		const signal = this.dialog.signal;
		try {
			// Refresh local configuration/auth presence, without discovery networking or model calls.
			await ctx.modelRegistry.refresh({ allowNetwork: false, signal });
			if (signal.aborted) return;
			const error = ctx.modelRegistry.getError();
			if (error) ctx.ui.notify(`Model catalogue: ${error}`, "warning");
			while (!signal.aborted) {
				const models = ctx.modelRegistry.getAvailable();
				const available = new Set(models.map(modelId));
				const options = KINDS.map(kind => `${kind} · ${this.config.agents[kind].model}${available.has(this.config.agents[kind].model) ? "" : " (unavailable)"}`);
				const choice = await ctx.ui.select("Delegate models — select a role\nSaved globally; running and queued jobs are unchanged", options, { signal });
				if (signal.aborted || choice === undefined) return;
				const index = options.indexOf(choice);
				if (index < 0) throw new Error("Invalid delegate role selection.");
				const kind = KINDS[index];
				if (!models.length) { ctx.ui.notify("No models available. Configure model access in Pi (/login or models.json) first.", "warning"); return; }
				if (!this.paths.userPath) throw new Error("User config is disabled (PI_DELEGATE_SKIP_USER_CONFIG=1).");
				const current = this.config.agents[kind];
				const selected = await pickDelegateModel(ctx, kind, current.model, models, signal);
				if (signal.aborted) return;
				if (selected === undefined || selected === current.model) continue;
				const offlineChange = current.offline && !isLocalModel(selected);
				const confirmed = await ctx.ui.confirm(`Save ${kind} model?`, [
					`${current.model} → ${selected}`,
					...(offlineChange ? ["offline: true → false (hosted model startup)"] : []),
					`Save to ${this.paths.userPath}`,
					"Applies to new delegates here immediately. Other open Pi sessions need /reload.",
					"Tools, thinking, parent model and existing jobs are unchanged.",
				].join("\n"), { signal });
				if (signal.aborted) return;
				if (!confirmed) continue;
				if (!ctx.modelRegistry.getAvailable().some(model => modelId(model) === selected)) throw new Error("Selected model is no longer available.");
				const patch = saveDelegateModel(this.paths, kind, current, selected);
				// Replace, don't mutate: queued runners close over the previous agent object.
				this.config.agents[kind] = { ...current, ...patch };
				ctx.ui.notify(`${kind}: ${selected}\nSaved; new delegates use it now.`, "info");
			}
		} catch (error) {
			if (!signal.aborted) ctx.ui.notify(`Delegate model settings: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally { this.busy = false; }
	}
}
