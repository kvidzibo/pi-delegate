import { BorderedLoader, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { assertKind, delegateConfigRevision, parseCompletionHook, resolveCheckpointAgent, saveCheckpointSettings, saveDelegatePatch, saveRolesSpeed, type AgentConfig, type ConfigPaths, type DelegateConfig, type Kind } from "./config.ts";
import { roleMenu } from "./role-menu.ts";
import { compileResponseSchema } from "../child-runtime/response-schema.ts";
import { SPEEDS, speedForModel, supportedSpeeds, type Speed } from "../child-runtime/speed.ts";
import { modelId, pickDelegateModel, scopedDelegateModels, type AvailableModel } from "./model-picker.ts";

const BULK_SPEED = "Set speed for all Codex roles…";

const KEEP_EDITING = "Do not save", SAVE_ANYWAY = "Save anyway";
export const ROLE_CHECK_TASK = "Reply with exactly: OK";
export const ROLE_CHECK_TIMEOUT_MS = 120_000;

/** Same launch settings as the role; a one-line prompt and no response contract or hook. */
export function roleCheckAgent(agent: AgentConfig): AgentConfig {
	return { enabled: true, model: agent.model, thinking: agent.thinking, tools: [...agent.tools], extensions: agent.extensions,
		...(agent.speed ? { speed: agent.speed } : {}), prompt: "This is a connectivity check. Reply with the single word OK. Do not use tools." };
}

/** Whether a save changes how the role's child is launched, so a check can tell something new. */
export function launchChanged(before: AgentConfig | undefined, next: AgentConfig): boolean {
	return !before || before.enabled === false || before.model !== next.model || before.thinking !== next.thinking
		|| (before.speed ?? "standard") !== (next.speed ?? "standard") || before.extensions !== next.extensions
		|| [...before.tools].sort().join() !== [...next.tools].sort().join();
}

/** Starts the role once against the real provider. */
export type RoleCheck = (kind: string, agent: AgentConfig, ctx: ExtensionCommandContext, signal: AbortSignal) => Promise<{ failed: boolean; text: string }>;

/** Changes affect future launches only. Accepted runners retain their agent object. */
export class ModelCommand {
	private readonly config: DelegateConfig;
	private readonly paths: ConfigPaths;
	private dialog = new AbortController();
	private busy = false;
	private revision: string;

	constructor(config: DelegateConfig, paths: ConfigPaths, private readonly onRoleAdded?: () => void, private readonly roleCheck?: RoleCheck) {
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
				const models = ctx.modelRegistry.getAvailable();
				const scoped = (ctx.scopedModels?.length ?? 0) > 0;
				const scopedModels = scopedDelegateModels(models, ctx.scopedModels);
				const available = new Set(models.map(modelId));
				const inScope = new Set(scopedModels.map(modelId));
				const kinds = Object.keys(this.config.agents);
				const options = kinds.map(kind => {
					const id = this.config.agents[kind].model;
					const mark = !available.has(id) ? " (unavailable)" : scoped && !inScope.has(id) ? " (not in scope)" : "";
					const speed = this.config.agents[kind].speed;
					const speedLabel = speed && speed !== "standard" ? ` · speed: ${speed}${supportedSpeeds(id).includes(speed) ? "" : " (inactive)"}` : "";
					return `${kind} · ${id}${mark} · reasoning: ${this.config.agents[kind].thinking}${speedLabel}${roles && this.config.agents[kind].enabled === false ? " · disabled" : ""}`;
				});
				if (roles) options.push(BULK_SPEED, "Add named role…");
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
				if (roles && choice === BULK_SPEED) notice = await this.saveCodexSpeed(ctx, signal);
				else if (roles) {
					const before = this.revision;
					await this.editRole(ctx, kind, models, scopedModels, signal);
					if (this.revision !== before) notice = "Saved role. New delegates use it now.";
				} else notice = await this.configureRole(ctx, kind, models, scopedModels, signal);
			}
		} catch (error) {
			if (!signal.aborted) ctx.ui.notify(`Delegate role settings: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally { this.busy = false; }
	}

	async checkpoints(args: string, ctx: ExtensionCommandContext): Promise<void> {
		if (args.trim()) { ctx.ui.notify("Usage: /pi-delegate checkpoints", "warning"); return; }
		if (!ctx.hasUI || ctx.mode !== "tui") { ctx.ui.notify("Checkpoints requires native Pi TUI mode.", "warning"); return; }
		if (this.dialog.signal.aborted) return;
		if (this.busy) { ctx.ui.notify("Delegate settings are already open.", "warning"); return; }
		this.busy = true;
		const signal = this.dialog.signal;
		const before = this.config.checkpoints;
		const draft = { ...before };
		let catalogueReady = false;
		const refresh = async () => {
			catalogueReady = false;
			const refreshed = await ctx.modelRegistry.refresh({ allowNetwork: false, signal });
			if (signal.aborted) return;
			if (refreshed?.aborted || refreshed?.errors.size) throw new Error("Model catalogue refresh was incomplete; checkpoints cannot be enabled.");
			if (ctx.modelRegistry.getError()) throw new Error("Model catalogue is uncertain; checkpoints cannot be enabled.");
			catalogueReady = true;
		};
		const validate = () => {
			const resolved = resolveCheckpointAgent({ ...this.config, checkpoints: draft });
			if (!catalogueReady) throw new Error("Model catalogue is uncertain; checkpoints cannot be enabled.");
			if (!ctx.modelRegistry.getAvailable().some(item => modelId(item) === resolved.model)) {
				throw new Error(`Advisor model ${resolved.model} is unavailable. Configure model access in Pi (/login or models.json).`);
			}
		};
		try {
			// Catalogue trouble must not prevent switching checks off.
			try { await refresh(); }
			catch (error) { if (!signal.aborted) ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning"); }
			while (!signal.aborted) {
				const roles = Object.keys(this.config.agents).filter(role => {
					try { resolveCheckpointAgent({ ...this.config, checkpoints: { ...draft, role } }); return true; }
					catch { return false; }
				});
				let unavailable = "";
				try { validate(); } catch (error) { unavailable = error instanceof Error ? error.message : String(error); }
				const action = await roleMenu(ctx, "Delegate checkpoints", [
					{ id: "enabled", label: "Automatic checks", description: "Pauses work and sends request/tool excerpts to the advisor provider. Excerpts may contain sensitive data.", currentValue: draft.enabled ? "on" : "off", values: ["off", "on"] },
					{ id: "role", label: "Advisor role", currentValue: `${draft.role}${unavailable ? " (unavailable)" : ""}`,
						description: unavailable ? `${unavailable} Configure an enabled role with tools: [] and extensions: false via /pi-delegate roles or delegate.json.` : "Enabled role with no tools or extension discovery." },
					{ id: "interval", label: "Interval", description: "Main-agent tool-using rounds between checks; a batch counts once.", currentValue: String(draft.interval), values: [...new Set([10, 20, draft.interval])].map(String) },
					{ id: "save", label: "Save", currentValue: "" },
					{ id: "back", label: "Back", currentValue: "" },
				], signal, (id, value) => {
					if (id === "interval") draft.interval = Number(value);
					else if (id === "enabled") {
						draft.enabled = value === "on";
						if (draft.enabled) {
							try { validate(); }
							catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning"); }
						}
					}
				}, "Save for future checks; Esc/Back discards draft.");
				if (signal.aborted || action === undefined || action === "back") return;
				if (action === "role") {
					if (!roles.length) { ctx.ui.notify("No compatible advisor roles. Configure an enabled role with tools: [] and extensions: false in /pi-delegate roles or delegate.json.", "warning"); continue; }
					const role = await ctx.ui.select("Checkpoint advisor role", roles, { signal });
					if (signal.aborted) return;
					if (role !== undefined) draft.role = role;
				} else if (action === "save") {
					try {
						if (draft.enabled) { await refresh(); if (signal.aborted) return; validate(); }
						this.revision = saveCheckpointSettings(this.paths, before, draft, this.revision);
						this.config.checkpoints = { ...draft };
						ctx.ui.notify("Checkpoints saved globally; active here for future checks. Other sessions need /reload. Existing jobs unchanged.", "info");
						return;
					} catch (error) {
						if (!signal.aborted) ctx.ui.notify(`Delegate checkpoints: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
				}
			}
		} catch (error) {
			if (!signal.aborted) ctx.ui.notify(`Delegate checkpoints: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally { this.busy = false; }
	}

	/** One-time bulk set: writes the chosen speed into every role using an OpenAI Codex model. */
	private async saveCodexSpeed(ctx: ExtensionCommandContext, signal: AbortSignal): Promise<string> {
		const targets = Object.keys(this.config.agents).filter(kind => this.config.agents[kind].model.startsWith("openai-codex/"));
		if (!targets.length) { ctx.ui.notify("No roles use OpenAI Codex models.", "warning"); return ""; }
		const speeds = new Set(targets.map(kind => this.config.agents[kind].speed ?? "standard"));
		const labels = SPEEDS.map(speed => `${speed}${speeds.size === 1 && speeds.has(speed) ? " ✓ current" : ""}`);
		const choice = await ctx.ui.select([
			"Speed for all OpenAI Codex roles",
			`Roles: ${targets.join(", ")}`,
			"Fast and Ultrafast need ChatGPT sign-in and use more plan allowance; Ultrafast needs an eligible plan.",
		].join("\n"), labels, { signal });
		if (signal.aborted || choice === undefined) return "";
		const speed = SPEEDS[labels.indexOf(choice)];
		if (speed === undefined) throw new Error("Invalid speed selection.");
		const inactive = targets.filter(kind => !supportedSpeeds(this.config.agents[kind].model).includes(speed));
		const confirmed = await ctx.ui.confirm(`Set ${speed} speed for ${targets.length} Codex roles?`, [
			targets.join(", "),
			...(inactive.length ? [`Inactive, model lacks ${speed}: ${inactive.join(", ")}`] : []),
			`Save to ${this.paths.userPath}`,
			"Applies to new delegates here immediately. Other open Pi sessions need /reload.",
			"Other settings, non-Codex roles and existing jobs are unchanged.",
		].join("\n"), { signal });
		if (signal.aborted || !confirmed) return "";
		const current = Object.fromEntries(targets.map(kind => [kind, this.config.agents[kind]]));
		// One declined or cancelled check leaves the whole batch unsaved.
		for (const kind of targets) if (!await this.verify(ctx, kind, current[kind], { ...current[kind], speed }, signal)) return "";
		this.revision = saveRolesSpeed(this.paths, current, speed, this.revision);
		// Replace, don't mutate: queued runners close over the previous agent object.
		for (const kind of targets) this.config.agents[kind] = { ...current[kind], speed };
		return `Saved ${speed} speed for ${targets.length} Codex roles. New delegates use it now.`;
	}

	/**
	 * True when the save may proceed: the role answered, the check does not apply, or the user
	 * chose to save despite a failure. False on Escape or when the user declines.
	 */
	private async verify(ctx: ExtensionCommandContext, kind: string, before: AgentConfig | undefined, next: AgentConfig, signal: AbortSignal): Promise<boolean> {
		if (!this.roleCheck || next.enabled === false || !launchChanged(before, next)) return true;
		const check = new AbortController();
		const stop = () => check.abort();
		signal.addEventListener("abort", stop, { once: true });
		let result: { failed: boolean; text: string } | undefined;
		const run = () => this.roleCheck!(kind, next, ctx, check.signal).catch(error => ({ failed: true, text: error instanceof Error ? error.message : String(error) }));
		try {
			// Only the TUI can draw a loader; other clients get a notice and the same check.
			if (ctx.mode !== "tui") { ctx.ui.notify(`Checking ${kind} with ${next.model}…`, "info"); result = await run(); }
			else result = await ctx.ui.custom<{ failed: boolean; text: string } | undefined>((tui, theme, _keys, done) => {
				const loader = new BorderedLoader(tui, theme, `Checking ${kind} with ${next.model}…`);
				loader.onAbort = () => { check.abort(); done(undefined); };
				void run().then(done);
				return loader;
			});
		} finally { signal.removeEventListener("abort", stop); }
		if (signal.aborted || check.signal.aborted || !result) return false;
		if (!result.failed) return true;
		const reason = result.text.trim().split("\n").slice(-12).join("\n").slice(-1200) || "The role returned no response.";
		// Not a confirm: its default answer would save a broken role on Enter.
		return await ctx.ui.select([
			`${kind} check failed: ${next.model} did not return a response`,
			reason,
			`Delegates to ${kind} will fail the same way.`,
		].join("\n"), [KEEP_EDITING, SAVE_ANYWAY], { signal }) === SAVE_ANYWAY && !signal.aborted;
	}

	private persist(kind: string, current: AgentConfig | undefined, patch: Partial<AgentConfig>): void {
		this.revision = saveDelegatePatch(this.paths, kind, current, patch, this.revision);
	}

	private async editRole(ctx: ExtensionCommandContext, kind: string | undefined, models: AvailableModel[], scopedModels: AvailableModel[], signal: AbortSignal): Promise<void> {
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
		const draft: AgentConfig = before ? structuredClone(before)
			: { enabled: true, model: "", thinking: "off", prompt: "", tools: [], extensions: false };
		if (adding) {
			const selected = await pickDelegateModel(ctx, name, "", models, scopedModels, signal);
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
			const speed = draft.speed ?? "standard";
			const speeds = supportedSpeeds(draft.model);
			const speedNote = speeds.length === 1 ? " Not supported by this model." : ` This model supports ${speeds.join(", ")}.`;
			const action = await roleMenu(ctx, `Delegate role · ${name}${adding ? " (new)" : ""}`, [
				{ id: "enabled", label: "Enabled", currentValue: draft.enabled === false ? "no" : "yes", values: ["yes", "no"] },
				{ id: "model", label: "Model", currentValue: draft.model },
				{ id: "thinking", label: "Reasoning", currentValue: draft.thinking, ...(levels.length > 0 && levels.length < 5 ? { values: levels } : {}) },
				{ id: "speed", label: "Speed", description: `OpenAI Codex service tier with ChatGPT sign-in. Fast and Ultrafast use more plan allowance; Ultrafast needs an eligible plan.${speedNote}`, currentValue: speed, values: speeds.includes(speed) ? speeds : [...speeds, speed] },
				{ id: "tools", label: "Tools", currentValue: draft.tools.join(", ") || "none" },
				{ id: "extensions", label: "Extensions", description: "Allow configured extension/MCP discovery. Not a sandbox.", currentValue: draft.extensions ? "yes" : "no", values: ["no", "yes"] },
				{ id: "prompt", label: "Prompt (multiline)", currentValue: `${draft.prompt.split("\n").length} lines · ≈${Math.ceil(draft.prompt.length / 4)} tokens` },
				{ id: "responseTemplate", label: "Response template", description: "Free-form text; inactive when a response schema is enabled. Empty disables. No placeholder processing.", currentValue: draft.responseTemplate?.trim() ? `${draft.responseTemplate.split("\n").length} lines · ≈${Math.ceil(draft.responseTemplate.length / 4)} tokens` : "disabled" },
				{ id: "saveToFile", label: "Save to file", description: "Return a private temporary file path instead of response text.", currentValue: draft.saveToFile ? "yes" : "no", values: ["no", "yes"] },
				{ id: "responseSchema", label: "Response schema", description: "Paste an entire JSON Schema (draft-07), not an example. Takes precedence over the template when enabled; empty disables.", currentValue: draft.responseSchema == null ? "disabled" : "configured" },
				{ id: "responseSchemaEnabled", label: "Response schema enabled", description: "No keeps the schema but runs the role as schema-less. No effect without a schema.", currentValue: draft.responseSchemaEnabled === false ? "no" : "yes", values: ["yes", "no"] },
				{ id: "responseRepairAttempts", label: "Repair attempts", description: "Retries for schema-invalid responses.", currentValue: String(draft.responseRepairAttempts ?? 2), values: ["0", "1", "2"] },
				{ id: "completionHook", label: "Completion hook", description: "Runs with full user permissions, also on failure/cancellation. JSON object; empty disables.", currentValue: draft.completionHook == null ? "disabled" : "configured" },
				{ id: "save", label: "Save role", currentValue: "" },
			], signal, (id, value) => {
				if (id === "thinking") draft.thinking = value as AgentConfig["thinking"];
				else if (id === "speed") draft.speed = value as Speed;
				else if (id === "enabled") draft.enabled = value === "yes";
				else if (id === "extensions") draft.extensions = value === "yes";
				else if (id === "saveToFile") draft.saveToFile = value === "yes";
				else if (id === "responseSchemaEnabled") draft.responseSchemaEnabled = value === "yes";
				else if (id === "responseRepairAttempts") draft.responseRepairAttempts = Number(value);
			});
			if (signal.aborted || action === undefined) return;
			if (action === "model") {
				const selected = await pickDelegateModel(ctx, name, draft.model, models, scopedModels, signal);
				if (selected && selected !== draft.model) {
					draft.model = selected;
					// Assign only on change: an own `speed: undefined` would fail the next save's conflict check.
					if (speedForModel(selected, draft.speed) !== draft.speed) draft.speed = "standard";
				}
			} else if (action === "thinking") {
				const selected = await ctx.ui.select(`Reasoning for ${name}`, levels, { signal });
				if (selected) draft.thinking = selected as AgentConfig["thinking"];
			} else if (action === "prompt") {
				const prompt = await ctx.ui.editor(`Prompt for ${name}`, draft.prompt);
				if (signal.aborted) return;
				if (prompt !== undefined) draft.prompt = prompt;
			} else if (action === "responseTemplate") {
				const template = await ctx.ui.editor(`Response template for ${name} (empty disables)`, draft.responseTemplate ?? "");
				if (signal.aborted) return;
				if (template !== undefined) draft.responseTemplate = template;
			} else if (action === "responseSchema") {
				let text = draft.responseSchema == null ? "" : JSON.stringify(draft.responseSchema, null, 2);
				while (!signal.aborted) {
					const edited = await ctx.ui.editor(`Response schema for ${name} (JSON Schema draft-07; empty disables)`, text);
					if (signal.aborted) return;
					if (edited === undefined) break;
					text = edited;
					if (!text.trim()) { draft.responseSchema = null; break; }
					try {
						const schema: unknown = JSON.parse(text);
						compileResponseSchema(schema);
						draft.responseSchema = schema as Record<string, unknown> | boolean;
						break;
					} catch (error) {
						ctx.ui.notify(`Invalid response schema: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
				}
			} else if (action === "completionHook") {
				let text = draft.completionHook == null ? "" : JSON.stringify(draft.completionHook, null, 2);
				while (!signal.aborted) {
					const edited = await ctx.ui.editor(`Completion hook for ${name} (JSON object; empty disables)`, text);
					if (signal.aborted) return;
					if (edited === undefined) break;
					text = edited;
					try {
						draft.completionHook = parseCompletionHook(text.trim() ? JSON.parse(text) : null);
						break;
					} catch (error) {
						ctx.ui.notify(`Invalid completion hook: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
				}
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
				if (!await this.verify(ctx, name, before, draft, signal)) continue;
				this.persist(name, before, draft);
				this.config.agents[name] = { ...draft, tools: [...draft.tools] };
				if (adding) this.onRoleAdded?.();
				return;
			}
		}
	}

	/** Model picker first. Reasoning opens only after a selection, including the current model. */
	private async configureRole(
		ctx: ExtensionCommandContext, kind: Kind, models: AvailableModel[], scopedModels: AvailableModel[], signal: AbortSignal,
	): Promise<string> {
		let modelNotice = "";
		if (!models.length) {
			ctx.ui.notify("No models available. Configure model access in Pi (/login or models.json) first.", "warning");
		} else {
			const picked = await this.saveModel(ctx, kind, models, scopedModels, signal);
			if (signal.aborted || picked === "cancelled") return "";
			if (picked === "saved") modelNotice = `Saved model: ${this.config.agents[kind].model}. New delegates use it now.`;
		}
		if (signal.aborted) return modelNotice;
		return await this.saveThinking(ctx, kind, signal, modelNotice) || modelNotice;
	}

	private async saveModel(
		ctx: ExtensionCommandContext, kind: Kind, models: AvailableModel[], scopedModels: AvailableModel[], signal: AbortSignal,
	): Promise<"cancelled" | "unchanged" | "saved"> {
		while (!signal.aborted) {
			const current = this.config.agents[kind];
			const selected = await pickDelegateModel(ctx, kind, current.model, models, scopedModels, signal);
			if (signal.aborted || selected === undefined) return "cancelled";
			if (selected === current.model) return "unchanged";
			const speed = speedForModel(selected, current.speed);
			const confirmed = await ctx.ui.confirm(`Save ${kind} model?`, [
				`${current.model} → ${selected}`,
				...(speed !== current.speed ? [`Speed ${current.speed} → standard: not supported by this model.`] : []),
				`Save to ${this.paths.userPath}`,
				"Applies to new delegates here immediately. Other open Pi sessions need /reload.",
				"Tools, parent model and existing jobs are unchanged. Reasoning is chosen next.",
			].join("\n"), { signal });
			if (signal.aborted) return "cancelled";
			if (!confirmed) continue;
			if (!ctx.modelRegistry.getAvailable().some(model => modelId(model) === selected)) {
				throw new Error("Selected model is no longer available.");
			}
			if (ctx.modelRegistry.getError()) throw new Error("Model catalogue is uncertain; settings were not changed.");
			const patch = { model: selected, ...(speed !== current.speed ? { speed } : {}) };
			if (!await this.verify(ctx, kind, current, { ...current, ...patch }, signal)) { if (signal.aborted) return "cancelled"; continue; }
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
			if (!await this.verify(ctx, kind, latestCurrent, { ...latestCurrent, ...patch }, signal)) { if (signal.aborted) return ""; continue; }
			this.persist(kind, latestCurrent, patch);
			this.config.agents[kind] = { ...latestCurrent, ...patch };
			return `Saved reasoning: ${thinking}. New delegates use it now.`;
		}
		return "";
	}
}
