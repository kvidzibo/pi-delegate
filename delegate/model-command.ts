import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { KINDS, saveDelegateModel, saveDelegateThinking, type ConfigPaths, type DelegateConfig } from "./config.ts";
import { modelId, pickDelegateModel, selectableDelegateModels } from "./model-picker.ts";
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
		if (args.trim()) { ctx.ui.notify("Usage: /pi-delegate models", "warning"); return; }
		if (!ctx.hasUI) { ctx.ui.notify("/pi-delegate models requires an interactive UI.", "warning"); return; }
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
				const availableModels = ctx.modelRegistry.getAvailable();
				const scoped = (ctx.scopedModels?.length ?? 0) > 0;
				const models = selectableDelegateModels(availableModels, ctx.scopedModels);
				const available = new Set(availableModels.map(modelId));
				const selectable = new Set(models.map(modelId));
				const options = KINDS.map(kind => {
					const id = this.config.agents[kind].model;
					const mark = selectable.has(id) ? "" : scoped && available.has(id) ? " (not in scope)" : " (unavailable)";
					return `${kind} · ${id}${mark} · reasoning: ${this.config.agents[kind].thinking}`;
				});
				const choice = await ctx.ui.select("Delegate models and reasoning — select a role\nSaved globally; running and queued jobs are unchanged", options, { signal });
				if (signal.aborted || choice === undefined) return;
				const index = options.indexOf(choice);
				if (index < 0) throw new Error("Invalid delegate role selection.");
				const kind = KINDS[index];
				if (!this.paths.userPath) throw new Error("User config is disabled (PI_DELEGATE_SKIP_USER_CONFIG=1).");
				const current = this.config.agents[kind];
				const fields = [`Model · ${current.model}`, `Reasoning · ${current.thinking}`];
				const field = await ctx.ui.select(`Settings for ${kind}`, fields, { signal });
				if (signal.aborted) return;
				if (field === undefined) continue;
				if (field === fields[1]) {
					const model = ctx.modelRegistry.getAll().find(model => modelId(model) === current.model);
					if (!model) {
						ctx.ui.notify(`Cannot determine reasoning levels: ${current.model} is not in Pi's model catalogue.`, "warning");
						continue;
					}
					const supported = getSupportedThinkingLevels(model);
					if (!supported.length) {
						ctx.ui.notify(`No supported reasoning levels for ${current.model}.`, "warning");
						continue;
					}
					const levels = supported.map(level => `${level}${level === current.thinking ? " ✓ current" : ""}`);
					const currentLabel = `${current.thinking}${supported.includes(current.thinking) ? "" : " (unsupported for this model)"}`;
					const choice = await ctx.ui.select(`Reasoning for ${kind}\n${current.model}\nCurrent: ${currentLabel}`, levels, { signal });
					if (signal.aborted) return;
					if (choice === undefined) continue;
					const thinking = supported[levels.indexOf(choice)];
					if (thinking === undefined) throw new Error("Invalid reasoning selection.");
					if (thinking === current.thinking) continue;
					const confirmed = await ctx.ui.confirm(`Save ${kind} reasoning?`, [
						`${current.thinking} → ${thinking}`,
						`Save to ${this.paths.userPath}`,
						"Applies to new delegates here immediately. Other open Pi sessions need /reload.",
						"Model, tools, offline setting, parent and existing jobs are unchanged.",
					].join("\n"), { signal });
					if (signal.aborted) return;
					if (!confirmed) continue;
					const latest = ctx.modelRegistry.getAll().find(model => modelId(model) === current.model);
					if (!latest || !getSupportedThinkingLevels(latest).includes(thinking)) throw new Error("Selected reasoning level is no longer supported by this model.");
					const patch = saveDelegateThinking(this.paths, kind, current, thinking);
					this.config.agents[kind] = { ...current, ...patch };
					ctx.ui.notify(`${kind}: reasoning ${thinking}\nSaved; new delegates use it now.`, "info");
					continue;
				}
				if (field !== fields[0]) throw new Error("Invalid delegate setting selection.");
				if (!models.length) {
					ctx.ui.notify(scoped
						? "No scoped models are available. Adjust /scoped-models, or configure model access in Pi (/login or models.json)."
						: "No models available. Configure model access in Pi (/login or models.json) first.", "warning");
					continue;
				}
				const selected = await pickDelegateModel(ctx, kind, current.model, models, signal, scoped);
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
				if (!selectableDelegateModels(ctx.modelRegistry.getAvailable(), ctx.scopedModels).some(model => modelId(model) === selected)) throw new Error("Selected model is no longer available.");
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
