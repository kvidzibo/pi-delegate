import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { assertKind, delegateConfigRevision, saveDelegatePatch, type AgentConfig, type ConfigPaths, type DelegateConfig, type Kind } from "./config.ts";
import { roleMenu } from "./role-menu.ts";
import { modelId, pickDelegateModel, selectableDelegateModels, type AvailableModel } from "./model-picker.ts";

/** Changes affect future launches only. Accepted runners retain their agent object. */
export class ModelCommand {
	private readonly config: DelegateConfig;
	private readonly paths: ConfigPaths;
	private dialog = new AbortController();
	private busy = false;
	private revision: string;

	constructor(config: DelegateConfig, paths: ConfigPaths, private readonly onRoleAdded?: () => void) {
		this.config = config;
		this.paths = paths;
		this.revision = delegateConfigRevision(paths);
	}

	stop(): void { this.dialog.abort(); }

	async command(args: string, ctx: ExtensionCommandContext, roles = false): Promise<void> {
		const entry = roles ? "roles" : "models";
		if (args.trim()) { ctx.ui.notify(`Usage: /pi-delegate ${entry}`, "warning"); return; }
		if (!ctx.hasUI) { ctx.ui.notify(`/pi-delegate ${entry} requires an interactive UI.`, "warning"); return; }
		if (this.dialog.signal.aborted) return;
		if (this.busy) { ctx.ui.notify("Delegate role settings are already open.", "warning"); return; }
		this.busy = true;
		const signal = this.dialog.signal;
		try {
			// Refresh local configuration/auth presence, without discovery networking or model calls.
			const refreshed = await ctx.modelRegistry.refresh({ allowNetwork: false, signal });
			if (signal.aborted) return;
			if (refreshed?.aborted || refreshed?.errors.size) throw new Error("Model catalogue refresh was incomplete; settings were not changed.");
			const error = ctx.modelRegistry.getError();
			if (error) ctx.ui.notify(`Model catalogue: ${error}`, "warning");
			let notice = "";
			while (!signal.aborted) {
				const availableModels = ctx.modelRegistry.getAvailable();
				const scoped = (ctx.scopedModels?.length ?? 0) > 0;
				const models = selectableDelegateModels(availableModels, ctx.scopedModels);
				const available = new Set(availableModels.map(modelId));
				const selectable = new Set(models.map(modelId));
				const kinds = Object.keys(this.config.agents);
				const options = kinds.map(kind => {
					const id = this.config.agents[kind].model;
					const mark = selectable.has(id) ? "" : scoped && available.has(id) ? " (not in scope)" : " (unavailable)";
					return `${kind} · ${id}${mark} · reasoning: ${this.config.agents[kind].thinking}${roles && this.config.agents[kind].enabled === false ? " · disabled" : ""}`;
				});
				if (roles) options.push("Add named role…");
				const choice = await ctx.ui.select(roles ? ["Delegate roles — saved globally; accepted jobs are unchanged", notice].filter(Boolean).join("\n") : [
					"Delegate models and reasoning — select a role",
					"Selecting a role opens its model picker; reasoning follows",
					"Saved globally; running and queued jobs are unchanged",
					...(notice ? [notice] : []),
				].join("\n"), options, { signal });
				notice = "";
				if (signal.aborted || choice === undefined) return;
				const index = options.indexOf(choice);
				if (index < 0) throw new Error("Invalid delegate role selection.");
				const kind = kinds[index];
				if (!this.paths.userPath) throw new Error("User config is disabled (PI_DELEGATE_SKIP_USER_CONFIG=1).");
				if (roles) {
					const before = this.revision;
					await this.editRole(ctx, kind, models, scoped, signal);
					if (this.revision !== before) notice = "Saved role. New delegates use it now.";
				} else notice = await this.configureRole(ctx, kind, models, scoped, signal);
			}
		} catch (error) {
			if (!signal.aborted) ctx.ui.notify(`Delegate role settings: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally { this.busy = false; }
	}

	private persist(kind: string, current: AgentConfig | undefined, patch: Partial<AgentConfig>): void {
		this.revision = saveDelegatePatch(this.paths, kind, current, patch, this.revision);
	}

	private async editRole(ctx: ExtensionCommandContext, kind: string | undefined, models: AvailableModel[], scoped: boolean, signal: AbortSignal): Promise<void> {
		if (ctx.mode !== "tui") { ctx.ui.notify("Roles requires native Pi TUI mode.", "warning"); return; }
		const adding = kind === undefined;
		if (adding) {
			const name = await ctx.ui.input("New role name", "[a-z][a-z0-9_-]{0,63}", { signal });
			if (signal.aborted || name === undefined) return;
			kind = assertKind(name);
			if (Object.hasOwn(this.config.agents, kind)) throw new Error("Role already exists.");
		}
		const name = kind!;
		const before = adding ? undefined : this.config.agents[name];
		const draft: AgentConfig = before ? { ...before, tools: [...before.tools] }
			: { enabled: true, model: "", thinking: "off", prompt: "", tools: [], extensions: false };
		if (adding) {
			const selected = await pickDelegateModel(ctx, name, "", models, signal, scoped);
			if (signal.aborted || selected === undefined) return;
			draft.model = selected;
			const prompt = await ctx.ui.editor(`Prompt for ${name}`, "");
			if (signal.aborted || prompt === undefined) return;
			if (!prompt.trim()) throw new Error("Prompt must not be blank.");
			draft.prompt = prompt;
		}
		while (!signal.aborted) {
			const model = ctx.modelRegistry.getAll().find(item => modelId(item) === draft.model);
			const levels = model ? getSupportedThinkingLevels(model) : [];
			const action = await roleMenu(ctx, `Delegate role · ${name}${adding ? " (new)" : ""}`, [
				{ id: "enabled", label: "Enabled", currentValue: draft.enabled === false ? "no" : "yes", values: ["yes", "no"] },
				{ id: "model", label: "Model", currentValue: draft.model },
				{ id: "thinking", label: "Reasoning", currentValue: draft.thinking, ...(levels.length > 0 && levels.length < 5 ? { values: levels } : {}) },
				{ id: "tools", label: "Tools", currentValue: draft.tools.join(", ") || "none" },
				{ id: "extensions", label: "Extensions", description: "Allow configured extension/MCP discovery. Not a sandbox.", currentValue: draft.extensions ? "yes" : "no", values: ["no", "yes"] },
				{ id: "prompt", label: "Prompt (multiline)", currentValue: `${draft.prompt.split("\n").length} lines · ≈${Math.ceil(draft.prompt.length / 4)} tokens` },
				{ id: "save", label: "Save role", currentValue: "" },
			], signal, (id, value) => {
				if (id === "thinking") draft.thinking = value as AgentConfig["thinking"];
				else if (id === "enabled") draft.enabled = value === "yes";
				else if (id === "extensions") draft.extensions = value === "yes";
			});
			if (signal.aborted || action === undefined) return;
			if (action === "model") {
				const selected = await pickDelegateModel(ctx, name, draft.model, models, signal, scoped);
				if (selected) draft.model = selected;
			} else if (action === "thinking") {
				const selected = await ctx.ui.select(`Reasoning for ${name}`, levels, { signal });
				if (selected) draft.thinking = selected as AgentConfig["thinking"];
			} else if (action === "prompt") {
				const prompt = await ctx.ui.editor(`Prompt for ${name}`, draft.prompt);
				if (prompt !== undefined) draft.prompt = prompt;
			} else if (action === "tools") {
				const names = [...new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls",
					...Object.values(this.config.agents).flatMap(agent => agent.tools), ...draft.tools].filter(tool => tool !== "*"))];
				let editing = true;
				while (editing && !signal.aborted) {
					const tool = await roleMenu(ctx, `Tools · ${name}`, [
						{ id: "all", label: "All tools", currentValue: draft.tools.includes("*") ? "selected" : "" },
						{ id: "none", label: "No tools", currentValue: draft.tools.length ? "" : "selected" },
						...names.map(id => ({ id, label: id, currentValue: draft.tools.includes("*") || draft.tools.includes(id) ? "yes" : "no", values: ["no", "yes"] })),
					], signal, (id, value) => {
						if (draft.tools.includes("*")) draft.tools = [...names];
						draft.tools = draft.tools.filter(tool => tool !== id);
						if (value === "yes") draft.tools.push(id);
					});
					if (tool === "all") draft.tools = ["*"];
					else if (tool === "none") draft.tools = [];
					else editing = false;
				}
			} else if (action === "save") {
				if (ctx.modelRegistry.getError()) throw new Error("Model catalogue is uncertain; settings were not changed.");
				const latest = ctx.modelRegistry.getAvailable().find(item => modelId(item) === draft.model);
				if (!latest || !getSupportedThinkingLevels(latest).includes(draft.thinking)) throw new Error("Choose an available model and supported reasoning level before saving.");
				if (!draft.prompt.trim()) throw new Error("Prompt must not be blank.");
				this.persist(name, before, draft);
				this.config.agents[name] = { ...draft, tools: [...draft.tools] };
				if (adding) this.onRoleAdded?.();
				return;
			}
		}
	}

	/** Model picker first. Reasoning opens only after a selection, including the current model. */
	private async configureRole(
		ctx: ExtensionCommandContext, kind: Kind, models: AvailableModel[], scoped: boolean, signal: AbortSignal,
	): Promise<string> {
		let modelNotice = "";
		if (!models.length) {
			ctx.ui.notify(scoped
				? "No scoped models are available. Adjust /scoped-models, or configure model access in Pi (/login or models.json)."
				: "No models available. Configure model access in Pi (/login or models.json) first.", "warning");
		} else {
			const picked = await this.saveModel(ctx, kind, models, scoped, signal);
			if (signal.aborted || picked === "cancelled") return "";
			if (picked === "saved") modelNotice = `Saved model: ${this.config.agents[kind].model}. New delegates use it now.`;
		}
		if (signal.aborted) return modelNotice;
		return await this.saveThinking(ctx, kind, signal, modelNotice) || modelNotice;
	}

	private async saveModel(
		ctx: ExtensionCommandContext, kind: Kind, models: AvailableModel[], scoped: boolean, signal: AbortSignal,
	): Promise<"cancelled" | "unchanged" | "saved"> {
		while (!signal.aborted) {
			const current = this.config.agents[kind];
			const selected = await pickDelegateModel(ctx, kind, current.model, models, signal, scoped);
			if (signal.aborted || selected === undefined) return "cancelled";
			if (selected === current.model) return "unchanged";
			const confirmed = await ctx.ui.confirm(`Save ${kind} model?`, [
				`${current.model} → ${selected}`,
				`Save to ${this.paths.userPath}`,
				"Applies to new delegates here immediately. Other open Pi sessions need /reload.",
				"Tools, parent model and existing jobs are unchanged. Reasoning is chosen next.",
			].join("\n"), { signal });
			if (signal.aborted) return "cancelled";
			if (!confirmed) continue;
			if (!selectableDelegateModels(ctx.modelRegistry.getAvailable(), ctx.scopedModels).some(model => modelId(model) === selected)) {
				throw new Error("Selected model is no longer available.");
			}
			if (ctx.modelRegistry.getError()) throw new Error("Model catalogue is uncertain; settings were not changed.");
			const patch = { model: selected };
			this.persist(kind, current, patch);
			// Replace, don't mutate: queued runners close over the previous agent object.
			this.config.agents[kind] = { ...current, ...patch };
			return "saved";
		}
		return "cancelled";
	}

	private async saveThinking(ctx: ExtensionCommandContext, kind: Kind, signal: AbortSignal, modelNotice: string): Promise<string> {
		const current = this.config.agents[kind];
		const model = ctx.modelRegistry.getAll().find(item => modelId(item) === current.model);
		if (!model) {
			ctx.ui.notify(`Cannot determine reasoning levels: ${current.model} is not in Pi's model catalogue.`, "warning");
			return "";
		}
		const supported = getSupportedThinkingLevels(model);
		if (!supported.length) {
			ctx.ui.notify(`No supported reasoning levels for ${current.model}.`, "warning");
			return "";
		}
		let pendingNotice = modelNotice;
		while (!signal.aborted) {
			const latestCurrent = this.config.agents[kind];
			const levels = supported.map(level => `${level}${level === latestCurrent.thinking ? " ✓ current" : ""}`);
			const currentLabel = `${latestCurrent.thinking}${supported.includes(latestCurrent.thinking) ? "" : " (unsupported for this model)"}`;
			const choice = await ctx.ui.select([
				`Reasoning for ${kind}`,
				latestCurrent.model,
				`Current: ${currentLabel}`,
				...(pendingNotice ? [pendingNotice] : []),
			].join("\n"), levels, { signal });
			pendingNotice = "";
			if (signal.aborted) return "";
			if (choice === undefined) return "";
			const thinking = supported[levels.indexOf(choice)];
			if (thinking === undefined) throw new Error("Invalid reasoning selection.");
			if (thinking === latestCurrent.thinking) continue;
			const confirmed = await ctx.ui.confirm(`Save ${kind} reasoning?`, [
				`${latestCurrent.thinking} → ${thinking}`,
				`Save to ${this.paths.userPath}`,
				"Applies to new delegates here immediately. Other open Pi sessions need /reload.",
				"Model, tools, parent and existing jobs are unchanged.",
			].join("\n"), { signal });
			if (signal.aborted) return "";
			if (!confirmed) continue;
			if (ctx.modelRegistry.getError()) throw new Error("Model catalogue is uncertain; settings were not changed.");
			const latest = ctx.modelRegistry.getAvailable().find(item => modelId(item) === latestCurrent.model);
			if (!latest || !getSupportedThinkingLevels(latest).includes(thinking)) throw new Error("Selected reasoning level is no longer supported by this model.");
			const patch = { thinking };
			this.persist(kind, latestCurrent, patch);
			this.config.agents[kind] = { ...latestCurrent, ...patch };
			return `Saved reasoning: ${thinking}. New delegates use it now.`;
		}
		return "";
	}
}
