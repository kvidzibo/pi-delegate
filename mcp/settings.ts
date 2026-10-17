import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { McpServer, ProtocolError } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ROLE_NAME, THINKING_LEVELS, parseDelegateConfig, mergeDelegateConfig, type ConfigPaths, type DelegateConfig, type Kind, type AgentConfig } from "../delegate/config.ts";
import { isLocalModel } from "../delegate/tg.ts";
import type { CatalogueLoader, SettingsCatalogue } from "./models.ts";

export const SETTINGS_EXTENSION = "com.kvidzibo/settings";
export const SETTINGS_GET = "kvidzibo/settings/get";
export const SETTINGS_UPDATE = "kvidzibo/settings/update";
export const SETTINGS_TOKEN_ENV = "PI_DELEGATE_SETTINGS_TOKEN";

type RoleValues = Required<AgentConfig>;
type RolePatch = Partial<RoleValues>;
type SettingsPatch = { agents: Partial<Record<Kind, RolePatch>> };
type Overlay = Record<string, unknown> & { agents?: Partial<Record<Kind, Record<string, unknown>>> };

function fault(code: number, message: string): never { throw new ProtocolError(code, message); }
function digest(value: string): Buffer { return createHash("sha256").update(value).digest(); }

/** Capture the complete disk identity, but never expose paths or raw configuration. */
function diskState(paths: ConfigPaths) {
	const shipped = realpathSync(paths.shippedPath);
	const shippedText = readFileSync(shipped, "utf8");
	let target = paths.userPath, text: string | undefined, mode = 0o600;
	if (target) {
		try {
			lstatSync(target); // Unlike existsSync, dangling symlinks must fail closed.
			target = realpathSync(target);
			if (target === shipped) throw new Error("User overlay points at shipped defaults");
			if (!statSync(target).isFile()) throw new Error("Not a regular configuration file");
			text = readFileSync(target, "utf8");
			mode = statSync(target).mode & 0o777;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || target !== paths.userPath) throw error;
			// Refuse a dangling symlink, while allowing a genuinely absent overlay.
			try { lstatSync(target!); throw new Error("Dangling configuration link"); }
			catch (missing) { if ((missing as NodeJS.ErrnoException).code !== "ENOENT") throw missing; }
		}
	}
	const defaults = parseDelegateConfig(JSON.parse(shippedText), "shipped delegate configuration");
	const overlay: Overlay = text === undefined ? {} : JSON.parse(text);
	const config = mergeDelegateConfig(defaults, overlay, "delegate overlay");
	const revision = digest(JSON.stringify([shipped, shippedText, target ?? null, text ?? null])).toString("hex");
	return { shipped, shippedText, target, mode, overlay, config, defaults, revision };
}

function values(config: DelegateConfig): Record<Kind, RoleValues> {
	return Object.fromEntries(Object.keys(config.agents).map(kind => {
		const agent = config.agents[kind];
		return [kind, { ...agent, enabled: agent.enabled !== false, tools: [...agent.tools] }];
	})) as Record<Kind, RoleValues>;
}

const rolePatchSchema = z.object({
	model: z.string().max(256).regex(/^[^/\s]+\/[^\s]+$/).optional(),
	thinking: z.enum(THINKING_LEVELS).optional(),
	enabled: z.boolean().optional(),
	tools: z.array(z.string().refine(value => value.length > 0 && value === value.trim(), "Tool must be nonblank without surrounding whitespace")).refine(items => new Set(items).size === items.length, "Tools must be unique").optional(),
	extensions: z.boolean().optional(),
	prompt: z.string().min(1).regex(/\S/).optional(),
}).strict().refine(patch => Object.keys(patch).length > 0, "Role patch must not be empty");
const patchSchema = z.object({
	agents: z.record(z.string().regex(ROLE_NAME).refine(name => !["constructor", "prototype", "__proto__"].includes(name)), rolePatchSchema)
		.refine(agents => Object.keys(agents).length > 0, "Select at least one role"),
}).strict();

/** Private operator API; never registered as model-callable tools. */
export class DelegateSettings {
	private readonly tokenHash: Buffer;
	private closed = false;
	private state: ReturnType<typeof diskState>;
	private readonly paths: ConfigPaths;
	private readonly catalogue: CatalogueLoader;
	private readonly apply: (agents: DelegateConfig["agents"]) => void;

	constructor(input: { token: string; paths: ConfigPaths; catalogue: CatalogueLoader; apply: (agents: DelegateConfig["agents"]) => void }) {
		if (!/^[A-Za-z0-9_-]{32,256}$/.test(input.token)) throw new Error("PI_DELEGATE_SETTINGS_TOKEN must be a random base64url token of 32–256 characters.");
		this.tokenHash = digest(input.token);
		this.paths = input.paths;
		this.catalogue = input.catalogue;
		this.apply = input.apply;
		this.state = diskState(this.paths);
		// Construction precedes request acceptance: align the host with this exact role snapshot.
		this.apply(this.state.config.agents);
	}

	private authorize(token: string | undefined): void {
		if (!token || !timingSafeEqual(digest(token), this.tokenHash)) fault(-33001, "Settings authorization required.");
	}

	stop(): void { this.closed = true; }

	private assertOpen(): void {
		if (this.closed) fault(-33003, "Settings service is shutting down.");
	}

	private currentDisk() {
		try { return diskState(this.paths); }
		catch { return fault(-33003, "Cannot read delegate settings; repair the configured overlay and restart the server."); }
	}

	private describe(catalogue: SettingsCatalogue) {
		const current = values(this.state.config), defaults = values(this.state.defaults);
		const kinds = Object.keys(current);
		const conflict = this.currentDisk().revision !== this.state.revision;
		const sources = Object.fromEntries(kinds.map(kind => [kind, Object.fromEntries(["enabled", "model", "thinking", "tools", "extensions", "prompt"].map(key =>
			[key, Object.hasOwn(this.state.overlay.agents?.[kind] ?? {}, key) ? "user" : "default"]))]));
		const toolNames = [...new Set(["*", "read", "bash", "edit", "write", "grep", "find", "ls", ...Object.values(current).flatMap(role => role.tools)])];
		const roleSchema = (kind?: string) => {
			const choices = catalogue.models.map(model => ({ const: model.id, title: `${model.label}${model.available ? "" : " (unavailable)"}` }));
			if (kind && !choices.some(choice => choice.const === current[kind].model)) choices.push({ const: current[kind].model, title: `${current[kind].model} (unavailable)` });
			return {
				type: "object", title: kind ?? "Role", additionalProperties: false,
				properties: {
					model: { type: "string", title: "Model", description: "Unavailable models cannot be selected. Use the server catalogue, not the parent session's models.", oneOf: choices, ...(kind ? { default: defaults[kind]?.model ?? current[kind].model } : {}) },
					thinking: { type: "string", title: "Reasoning", description: "Supported levels depend on the selected model; see models[].thinking.", enum: [...THINKING_LEVELS], default: kind ? defaults[kind]?.thinking ?? "off" : "off" },
					enabled: { type: "boolean", title: "Enabled", default: true },
					tools: { type: "array", title: "Tools", uniqueItems: true, items: { type: "string", enum: toolNames }, default: [] },
					extensions: { type: "boolean", title: "Extension access", description: "Enables normal installed/configured extension discovery, including MCP. Not a sandbox or a per-extension allowlist.", default: false },
					prompt: { type: "string", title: "Prompt", minLength: 1, pattern: "\\S", "x-multiline": true, default: "" },
				}, required: kind ? ["model", "thinking", "prompt"] : ["model", "prompt"],
			};
		};
		const roles = Object.fromEntries(kinds.map(kind => [kind, roleSchema(kind)]));
		return {
			schemaVersion: 1, title: "Roles", revision: this.state.revision,
			writable: Boolean(this.paths.userPath) && !conflict && !catalogue.warning, conflict,
			applyTo: "future-jobs", values: { agents: current }, sources: { agents: sources },
			schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false,
				properties: { agents: { type: "object", title: "Roles", propertyNames: { pattern: ROLE_NAME.source }, additionalProperties: roleSchema(), properties: roles, required: kinds } }, required: ["agents"] },
			models: catalogue.models.map(model => ({ ...model, local: isLocalModel(model.id) })),
			...(conflict ? { warning: "Configuration changed outside this server; restart after collecting or cancelling outstanding jobs." }
				: catalogue.warning ? { warning: catalogue.warning } : {}),
		};
	}

	async get(token: string | undefined, signal?: AbortSignal) {
		this.authorize(token);
		this.assertOpen();
		const catalogue = await this.catalogue(signal);
		signal?.throwIfAborted();
		this.assertOpen();
		return this.describe(catalogue);
	}

	async update(input: { token?: string; revision: string; patch: SettingsPatch }, signal?: AbortSignal) {
		this.authorize(input.token);
		this.assertOpen();
		const parsed = patchSchema.safeParse(input.patch);
		if (!parsed.success) fault(-32602, "Only nonempty patches of enabled, model, thinking, tools, extensions and prompt are accepted.");
		if (!this.paths.userPath) fault(-33003, "Settings persistence is disabled for this server.");
		if (input.revision !== this.state.revision) fault(-33002, "Settings revision changed; fetch settings before saving again.");
		const catalogue = await this.catalogue(signal);
		signal?.throwIfAborted();
		this.assertOpen();
		if (catalogue.warning) fault(-33003, "Model catalogue unavailable; settings were not changed.");
		// The asynchronous catalogue read must precede both revision checks and the disk lock.
		if (input.revision !== this.state.revision || this.currentDisk().revision !== this.state.revision) fault(-33002, "Settings changed; fetch settings or restart before saving again.");
		const nextOverlay = structuredClone(this.state.overlay);
		nextOverlay.agents ??= {};
		for (const kind of Object.keys(parsed.data.agents)) {
			const patch = parsed.data.agents[kind] as RolePatch | undefined;
			if (!patch) continue;
			const existing = Object.hasOwn(this.state.config.agents, kind);
			if (!existing && (!patch.model || !patch.prompt?.trim())) fault(-32602, "New roles require an explicit model and nonblank prompt.");
			const before = existing ? this.state.config.agents[kind] : { model: patch.model!, thinking: "off" as const };
			const modelId = patch.model ?? before.model;
			const model = catalogue.models.find(model => model.id === modelId);
			if (!model?.available) fault(-32602, `The ${kind} model is unavailable in this server's catalogue.`);
			if (!model.thinking.includes(patch.thinking ?? before.thinking)) fault(-32602, `The ${kind} reasoning level is unsupported by the selected model.`);
			nextOverlay.agents[kind] = { ...(existing ? nextOverlay.agents[kind] : { enabled: true, thinking: "off", tools: [], extensions: false }), ...patch };
		}
		const next = mergeDelegateConfig(this.state.defaults, nextOverlay, "delegate overlay");
		const target = this.state.target!;
		mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
		const lock = `${target}.settings-lock`;
		try { mkdirSync(lock, { mode: 0o700 }); }
		catch { fault(-33003, "Settings are busy or not writable; no changes were made."); }
		const temp = `${target}.${randomUUID()}.tmp`;
		try {
			const disk = this.currentDisk();
			if (disk.revision !== this.state.revision) fault(-33002, "Configuration changed on disk; settings were not saved.");
			const text = `${JSON.stringify(nextOverlay, null, 2)}\n`;
			const canonicalTarget = join(realpathSync(dirname(target)), basename(target));
			const committed = { ...this.state, mode: disk.mode, target: canonicalTarget, overlay: nextOverlay, config: next,
				revision: digest(JSON.stringify([this.state.shipped, this.state.shippedText, canonicalTarget, text])).toString("hex") };
			writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
			chmodSync(temp, disk.mode); // Explicitly preserve current permissions, independent of umask.
			renameSync(temp, target);
			// No await or fallible file reads after persistence: future launches change in this server turn.
			this.state = committed;
			this.apply(next.agents);
		} catch (error) {
			if (error instanceof ProtocolError) throw error;
			fault(-33003, "Could not persist settings; check overlay permissions and fetch settings again.");
		} finally {
			try { unlinkSync(temp); } catch { /* only our private temporary file */ }
			rmdirSync(lock);
		}
		return this.describe(catalogue);
	}
}

export function registerSettings(server: McpServer, settings: DelegateSettings): void {
	const capability = { version: 1, getMethod: SETTINGS_GET, updateMethod: SETTINGS_UPDATE, authorization: "token", audience: "operator", title: "Roles" };
	server.server.registerCapabilities({
		extensions: { [SETTINGS_EXTENSION]: capability },
		experimental: { [SETTINGS_EXTENSION]: capability }, // v1 clients / 2025-era initialize
	});
	// Accept standard protocol metadata, but reject unknown application fields. Metadata never authorizes writes.
	const token = z.string().max(256).optional();
	const meta = z.record(z.string(), z.unknown()).optional();
	server.server.setRequestHandler(SETTINGS_GET, { params: z.object({ token, _meta: meta }).strict() },
		(input, ctx) => settings.get(input.token, ctx.mcpReq.signal));
	// Legacy v1 clients may send the obsolete acknowledgement; it has no effect.
	server.server.setRequestHandler(SETTINGS_UPDATE, { params: z.object({ token, revision: z.string().regex(/^[a-f0-9]{64}$/), patch: patchSchema, confirmOfflineChange: z.boolean().optional(), _meta: meta }).strict() },
		(input, ctx) => settings.update(input as { token?: string; revision: string; patch: SettingsPatch }, ctx.mcpReq.signal));
}
