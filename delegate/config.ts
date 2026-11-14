import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { Alternative } from "./calibration.ts";
import { isLocalModel } from "./tg.ts";
import { MAX_TIMER_MS } from "../child-runtime/policy.ts";
import { assertRepairAttempts, compileResponseSchema, type ResponseSchema } from "../child-runtime/response-schema.ts";

export type Kind = string;
export const ROLE_NAME = /^[a-z][a-z0-9_-]{0,63}$/;

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface CompletionHookConfig {
	command: string[];
	timeoutMs: number;
}

export function parseCompletionHook(value: unknown): CompletionHookConfig | null {
	if (value === null) return null;
	if (!value || typeof value !== "object" || Array.isArray(value)
		|| Reflect.ownKeys(value).some(key => key !== "command" && key !== "timeoutMs")) {
		throw new Error("completionHook (object with only command and timeoutMs, or null)");
	}
	const { command, timeoutMs = 10000 } = value as Record<string, unknown>;
	if (!Array.isArray(command) || command.length === 0
		|| Array.from(command).some(arg => typeof arg !== "string" || arg.includes("\0"))
		|| !command[0].trim() || !isAbsolute(command[0])) {
		throw new Error("completionHook.command (nonempty array of NUL-free strings; first entry must be an absolute executable path)");
	}
	if (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1 || (timeoutMs as number) > 300000) {
		throw new Error("completionHook.timeoutMs (integer 1..300000)");
	}
	return { command: [...command], timeoutMs: timeoutMs as number };
}

export interface AgentConfig {
	enabled?: boolean;
	model: string;
	prompt: string;
	completionHook?: CompletionHookConfig | null;
	responseTemplate?: string;
	responseSchema?: ResponseSchema | null;
	responseRepairAttempts?: number;
	saveToFile?: boolean;
	extensions: boolean;
	tools: string[];
	thinking: ThinkingLevel;
}

export interface CheckpointConfig {
	enabled: boolean;
	role: string;
	interval: number;
}

export interface DelegateConfig {
	checkpoints: CheckpointConfig;
	maxTaskChars: number;
	maxConcurrent: number;
	maxLocalConcurrent: number;
	maxQueued: number;
	defaultTimeoutMs: number;
	maxTimeoutMs: number;
	checkIntervalMs: number;
	hardTimeoutMs: number;
	maxOutputBytes: number;
	agents: Record<Kind, AgentConfig>;
	localAlternatives: Record<string, Alternative>;
	calibrationProfiles: string[];
}

export function assertKind(value: unknown): Kind {
	if (typeof value !== "string" || !ROLE_NAME.test(value)) {
		throw new Error("delegate refused: kind must match [a-z][a-z0-9_-]{0,63}.");
	}
	return value;
}

export function resolveAgent(
	kind: Kind,
	config: DelegateConfig,
): { kind: Kind; model: string; agent: AgentConfig } {
	assertKind(kind);
	if (!Object.hasOwn(config.agents, kind)) throw new Error(`delegate refused: unknown role ${kind}.`);
	const agent = config.agents[kind];
	if (agent.enabled === false) throw new Error(`delegate refused: ${kind} is disabled in configuration.`);
	const model = agent.model;
	if (!model) throw new Error("delegate refused: model is empty.");
	return { kind, model, agent };
}

export function resolveCheckpointAgent(config: DelegateConfig): ReturnType<typeof resolveAgent> {
	const resolved = resolveAgent(config.checkpoints.role, config);
	if (resolved.agent.tools.length !== 0 || resolved.agent.extensions) {
		throw new Error(`Checkpoint advisor ${resolved.kind} must have tools: [] and extensions: false.`);
	}
	return resolved;
}

function parseCheckpoints(value: unknown, base: CheckpointConfig = { enabled: false, role: "goldfish", interval: 10 }): CheckpointConfig {
	if (value === undefined) return { ...base };
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("checkpoints (object)");
	const next = { ...base, ...value } as CheckpointConfig;
	if (typeof next.enabled !== "boolean") throw new Error("checkpoints.enabled (boolean)");
	if (typeof next.role !== "string" || !ROLE_NAME.test(next.role)) throw new Error("checkpoints.role (role name)");
	if (!Number.isInteger(next.interval) || next.interval < 1 || next.interval > 1000) throw new Error("checkpoints.interval (integer 1..1000)");
	return { enabled: next.enabled, role: next.role, interval: next.interval };
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function parseTools(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || !value.every(item => typeof item === "string")) {
		throw new Error(`${label} (array of non-empty strings; [] disables tools)`);
	}
	const seen = new Set<string>();
	const tools: string[] = [];
	for (const item of value) {
		const name = item.trim();
		if (!name) throw new Error(`${label} (non-empty string array)`);
		if (seen.has(name)) continue;
		seen.add(name);
		tools.push(name);
	}
	return tools;
}

function parseAgent(value: unknown, label: string): AgentConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} (object)`);
	}
	const parsed = value as Record<string, unknown>;
	const errors: string[] = [];
	if (typeof parsed.model !== "string" || parsed.model.trim().length === 0) {
		errors.push("model (non-empty string)");
	}
	if (typeof parsed.prompt !== "string" || !parsed.prompt.trim()) errors.push("prompt (non-empty string)");
	let completionHook: CompletionHookConfig | null | undefined;
	try {
		if (parsed.completionHook !== undefined) completionHook = parseCompletionHook(parsed.completionHook);
	} catch (error) { errors.push(error instanceof Error ? error.message : "completionHook"); }
	let tools: string[] | undefined;
	try {
		tools = parsed.tools === undefined ? ["*"] : parseTools(parsed.tools, "tools");
	} catch (error) {
		errors.push(error instanceof Error ? error.message : "tools");
	}
	if (parsed.responseTemplate !== undefined && typeof parsed.responseTemplate !== "string") errors.push("responseTemplate (string)");
	try {
		if (parsed.responseSchema !== undefined && parsed.responseSchema !== null) compileResponseSchema(parsed.responseSchema);
		if (parsed.responseRepairAttempts !== undefined) assertRepairAttempts(parsed.responseRepairAttempts);
	} catch (error) { errors.push(`responseSchema/responseRepairAttempts: ${error instanceof Error ? error.message : String(error)}`); }
	if (parsed.saveToFile !== undefined && typeof parsed.saveToFile !== "boolean") errors.push("saveToFile (boolean)");
	if (parsed.enabled !== undefined && typeof parsed.enabled !== "boolean") errors.push("enabled (boolean)");
	if (parsed.extensions !== undefined && typeof parsed.extensions !== "boolean") errors.push("extensions (boolean)");
	if (parsed.thinking !== undefined && !isThinkingLevel(parsed.thinking)) errors.push(`thinking (one of ${THINKING_LEVELS.join("|")})`);
	if (errors.length > 0) throw new Error(`${label} (${errors.join("; ")})`);
	const model = (parsed.model as string).trim();
	if (!model) throw new Error(`${label} (model (non-empty string))`);
	return {
		enabled: parsed.enabled === undefined ? true : parsed.enabled as boolean,
		model,
		prompt: parsed.prompt as string,
		...(completionHook !== undefined ? { completionHook } : {}),
		...(parsed.responseTemplate !== undefined ? { responseTemplate: parsed.responseTemplate as string } : {}),
		...(parsed.responseSchema !== undefined ? { responseSchema: structuredClone(parsed.responseSchema) as ResponseSchema | null } : {}),
		...(parsed.responseRepairAttempts !== undefined ? { responseRepairAttempts: parsed.responseRepairAttempts as number } : {}),
		...(parsed.saveToFile !== undefined ? { saveToFile: parsed.saveToFile as boolean } : {}),
		extensions: parsed.extensions === true,
		tools: tools as string[],
		thinking: (parsed.thinking ?? "off") as ThinkingLevel,
	};
}

function collectConfigErrors(parsed: Record<string, unknown>): string[] {
	const errors: string[] = [];
	if (!Number.isInteger(parsed.maxTaskChars) || (parsed.maxTaskChars as number) < 1) {
		errors.push("maxTaskChars (integer >= 1)");
	}
	if (!Number.isInteger(parsed.maxConcurrent) || (parsed.maxConcurrent as number) < 1) {
		errors.push("maxConcurrent (integer >= 1)");
	}
	if (!Number.isInteger(parsed.maxLocalConcurrent) || (parsed.maxLocalConcurrent as number) < 1) {
		errors.push("maxLocalConcurrent (integer >= 1)");
	}
	if (!Number.isInteger(parsed.maxQueued) || (parsed.maxQueued as number) < 1) {
		errors.push("maxQueued (integer >= 1)");
	}
	for (const key of ["defaultTimeoutMs", "maxTimeoutMs", "checkIntervalMs", "hardTimeoutMs"] as const) {
		if (!Number.isSafeInteger(parsed[key]) || (parsed[key] as number) > MAX_TIMER_MS) {
			errors.push(`${key} (integer <= ${MAX_TIMER_MS})`);
		}
	}
	if (!Number.isInteger(parsed.maxOutputBytes) || (parsed.maxOutputBytes as number) < 1) {
		errors.push("maxOutputBytes (integer >= 1)");
	}
	if (errors.length === 0) {
		const defaultTimeoutMs = parsed.defaultTimeoutMs as number;
		const maxTimeoutMs = parsed.maxTimeoutMs as number;
		const checkIntervalMs = parsed.checkIntervalMs as number;
		const hardTimeoutMs = parsed.hardTimeoutMs as number;
		if (maxTimeoutMs < 1000) errors.push("maxTimeoutMs (>= 1000)");
		if (defaultTimeoutMs < 1000 || defaultTimeoutMs > maxTimeoutMs) {
			errors.push("defaultTimeoutMs (in [1000, maxTimeoutMs])");
		}
		if (checkIntervalMs < 1000 || checkIntervalMs > maxTimeoutMs) {
			errors.push("checkIntervalMs (in [1000, maxTimeoutMs])");
		}
		if (hardTimeoutMs !== 0 && hardTimeoutMs < 1000) {
			errors.push("hardTimeoutMs (0 or >= 1000)");
		}
	}
	if (!parsed.agents || typeof parsed.agents !== "object" || Array.isArray(parsed.agents) || !Object.keys(parsed.agents).length) {
		errors.push("agents (object)");
	}
	return errors;
}

function parseAlternatives(value: unknown): Record<string, Alternative> {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("localAlternatives must be an object");
	const modelId = (v: unknown): v is string => typeof v === "string" && /^[^/\s]+\/[^\s]+$/.test(v) && v.length <= 512;
	const result: Record<string, Alternative> = Object.create(null);
	for (const [local, raw] of Object.entries(value)) {
		const entry = typeof raw === "string" ? { model: raw, thinking: "low" } : raw as Alternative;
		if (!modelId(local) || !entry || !modelId(entry.model) || !isThinkingLevel(entry.thinking) || !isLocalModel(local) || isLocalModel(entry.model)) {
			throw new Error("localAlternatives entries need provider/model IDs and a supported thinking level");
		}
		result[local] = { model: entry.model, thinking: entry.thinking };
	}
	return result;
}

export function parseDelegateConfig(value: unknown, path: string): DelegateConfig {
	if (!value || typeof value !== "object") {
		throw new Error(`Invalid delegate config: ${path}`);
	}
	const parsed = value as Record<string, unknown>;
	const errors = collectConfigErrors(parsed);
	const alternatives = parseAlternatives(parsed.localAlternatives);
	const checkpoints = parseCheckpoints(parsed.checkpoints);
	const profiles = parsed.calibrationProfiles ?? [];
	if (!Array.isArray(profiles) || profiles.length > 100 || !profiles.every(p => typeof p === "string" && isAbsolute(p))) {
		errors.push("calibrationProfiles (up to 100 absolute file paths)");
	}
	const agents: Record<Kind, AgentConfig> = {};
	if (parsed.agents && typeof parsed.agents === "object" && !Array.isArray(parsed.agents)) {
		for (const [kind, value] of Object.entries(parsed.agents)) {
			try {
				assertKind(kind);
				agents[kind] = parseAgent(value, `agents.${kind}`);
			} catch (error) {
				errors.push(error instanceof Error ? error.message : `agents.${kind}`);
			}
		}
	}
	if (errors.length > 0) {
		throw new Error(`Invalid delegate config: ${path} (${errors.join("; ")})`);
	}
	return {
		checkpoints,
		maxTaskChars: parsed.maxTaskChars as number,
		maxConcurrent: parsed.maxConcurrent as number,
		maxLocalConcurrent: parsed.maxLocalConcurrent as number,
		maxQueued: parsed.maxQueued as number,
		defaultTimeoutMs: parsed.defaultTimeoutMs as number,
		maxTimeoutMs: parsed.maxTimeoutMs as number,
		checkIntervalMs: parsed.checkIntervalMs as number,
		hardTimeoutMs: parsed.hardTimeoutMs as number,
		maxOutputBytes: parsed.maxOutputBytes as number,
		agents,
		localAlternatives: alternatives,
		calibrationProfiles: [...profiles],
	};
}

function mergeAgent(base: AgentConfig | undefined, extra: unknown, label: string): AgentConfig {
	if (!base) return parseAgent(extra, label);
	if (extra === undefined) return base;
	if (!extra || typeof extra !== "object" || Array.isArray(extra)) {
		throw new Error(`${label} (object)`);
	}
	const parsed = extra as Record<string, unknown>;
	const next: Record<string, unknown> = {
		enabled: base.enabled,
		model: base.model,
		prompt: base.prompt,
		completionHook: base.completionHook,
		responseTemplate: base.responseTemplate,
		responseSchema: base.responseSchema,
		responseRepairAttempts: base.responseRepairAttempts,
		saveToFile: base.saveToFile,
		extensions: base.extensions,
		tools: base.tools,
		thinking: base.thinking,
	};
	if (parsed.enabled !== undefined) next.enabled = parsed.enabled;
	if (parsed.model !== undefined) next.model = parsed.model;
	if (parsed.prompt !== undefined) next.prompt = parsed.prompt;
	if (parsed.completionHook !== undefined) next.completionHook = parsed.completionHook;
	if (parsed.responseTemplate !== undefined) next.responseTemplate = parsed.responseTemplate;
	if (parsed.responseSchema !== undefined) next.responseSchema = parsed.responseSchema;
	if (parsed.responseRepairAttempts !== undefined) next.responseRepairAttempts = parsed.responseRepairAttempts;
	if (parsed.saveToFile !== undefined) next.saveToFile = parsed.saveToFile;
	if (parsed.extensions !== undefined) next.extensions = parsed.extensions;
	if (parsed.tools !== undefined) next.tools = parsed.tools;
	if (parsed.thinking !== undefined) next.thinking = parsed.thinking;
	return parseAgent(next, label);
}

export function mergeDelegateConfig(base: DelegateConfig, overlay: unknown, path: string): DelegateConfig {
	if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) {
		throw new Error(`Invalid delegate config: ${path}`);
	}
	const extra = overlay as Record<string, unknown>;
	const merged: Record<string, unknown> = {
		checkpoints: parseCheckpoints(extra.checkpoints, base.checkpoints),
		maxTaskChars: extra.maxTaskChars ?? base.maxTaskChars,
		maxConcurrent: extra.maxConcurrent ?? base.maxConcurrent,
		maxLocalConcurrent: extra.maxLocalConcurrent ?? base.maxLocalConcurrent,
		maxQueued: extra.maxQueued ?? base.maxQueued,
		defaultTimeoutMs: extra.defaultTimeoutMs ?? base.defaultTimeoutMs,
		maxTimeoutMs: extra.maxTimeoutMs ?? base.maxTimeoutMs,
		checkIntervalMs: extra.checkIntervalMs ?? base.checkIntervalMs,
		hardTimeoutMs: extra.hardTimeoutMs ?? base.hardTimeoutMs,
		maxOutputBytes: extra.maxOutputBytes ?? base.maxOutputBytes,
		agents: { ...base.agents },
		localAlternatives: extra.localAlternatives ?? base.localAlternatives,
		calibrationProfiles: extra.calibrationProfiles ?? base.calibrationProfiles,
	};
	if (extra.agents !== undefined) {
		if (!extra.agents || typeof extra.agents !== "object" || Array.isArray(extra.agents)) {
			throw new Error(`Invalid delegate config: ${path} (agents (object))`);
		}
		const rawAgents = extra.agents as Record<string, unknown>;
		const agents: Record<string, AgentConfig> = { ...base.agents };
		for (const kind of Object.keys(rawAgents)) {
			assertKind(kind);
			agents[kind] = mergeAgent(Object.hasOwn(base.agents, kind) ? base.agents[kind] : undefined, rawAgents[kind], `agents.${kind}`);
		}
		merged.agents = agents;
	}
	return parseDelegateConfig(merged, path);
}

export interface ConfigPaths { shippedPath: string; userPath?: string }

export function loadDelegateConfig(input: ConfigPaths): DelegateConfig {
	const shipped = parseDelegateConfig(JSON.parse(readFileSync(input.shippedPath, "utf8")), input.shippedPath);
	if (!input.userPath || !existsSync(input.userPath)) return shipped;
	return mergeDelegateConfig(shipped, JSON.parse(readFileSync(input.userPath, "utf8")), input.userPath);
}

export function delegateConfigRevision(paths: ConfigPaths): string {
	return JSON.stringify(readConfigState(paths).identity);
}

function readConfigState(paths: ConfigPaths) {
	const shippedPath = realpathSync(paths.shippedPath);
	const shippedText = readFileSync(shippedPath, "utf8");
	let path = paths.userPath;
	let text: string | undefined;
	let mode = 0o600;
	if (path) {
		let exists = false;
		try { lstatSync(path); exists = true; }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		if (exists) {
			path = realpathSync(path); // Dangling links fail closed.
			if (path === shippedPath) throw new Error("User config must not point at shipped delegate defaults.");
			if (!statSync(path).isFile()) throw new Error("User config must be a regular file.");
			text = readFileSync(path, "utf8");
			mode = statSync(path).mode & 0o777;
		}
	}
	const shipped = parseDelegateConfig(JSON.parse(shippedText), shippedPath);
	const overlay = (text === undefined ? {} : JSON.parse(text)) as Record<string, unknown> & { agents?: Record<string, Record<string, unknown>> };
	const config = mergeDelegateConfig(shipped, overlay, path ?? shippedPath);
	return { path, mode, shipped, overlay, config, identity: [shippedPath, shippedText, path ?? null, text ?? null] };
}

export function saveDelegatePatch(paths: ConfigPaths, kind: Kind, current: AgentConfig | undefined, patch: Partial<AgentConfig>, revision?: string): string {
	if (!paths.userPath) throw new Error("User config is disabled (PI_DELEGATE_SKIP_USER_CONFIG=1).");
	assertKind(kind);
	if (["constructor", "prototype", "__proto__"].includes(kind)) throw new Error("Reserved role name.");
	if (patch.model !== undefined && !/^[^/\s]+\/[^\s]+$/.test(patch.model)) throw new Error("Expected a provider/model ID.");
	return saveSettingsPatch(paths, kind, revision, state => {
		const { overlay, config } = state;
		const saved = Object.hasOwn(config.agents, kind) ? config.agents[kind] : undefined;
		if (!isDeepStrictEqual(saved, current)) throw settingsConflict(kind);
		if (!current && (!patch.model || !patch.prompt?.trim())) throw new Error("New roles require an explicit model and nonblank prompt.");
		return { ...overlay, agents: { ...overlay.agents, [kind]: {
			...(current ? overlay.agents?.[kind] : { enabled: true, tools: [], extensions: false, thinking: "off" }), ...patch,
		} } };
	});
}

export function saveCheckpointSettings(paths: ConfigPaths, current: CheckpointConfig, patch: Partial<CheckpointConfig>, revision?: string): string {
	return saveSettingsPatch(paths, "Checkpoints", revision, state => {
		if (!isDeepStrictEqual(state.config.checkpoints, current)) throw settingsConflict("Checkpoints");
		parseCheckpoints(patch, current);
		return { ...state.overlay, checkpoints: { ...(state.overlay.checkpoints as object | undefined), ...patch } };
	});
}

function settingsConflict(label: string): Error {
	return new Error(`${label} changed on disk. Run /reload before changing it here (reload stops outstanding children).`);
}

function saveSettingsPatch(paths: ConfigPaths, label: string, revision: string | undefined,
	update: (state: ReturnType<typeof readConfigState>) => Record<string, unknown>): string {
	if (!paths.userPath) throw new Error("User config is disabled (PI_DELEGATE_SKIP_USER_CONFIG=1).");
	const state = readConfigState(paths);
	const baseline = JSON.stringify(state.identity);
	const conflict = () => { throw settingsConflict(label); };
	if (revision !== undefined && revision !== baseline) conflict();
	const { shipped, mode } = state;
	const next = update(state);
	mergeDelegateConfig(shipped, next, state.path!);
	const path = state.path!;
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const lock = `${path}.settings-lock`;
	try { mkdirSync(lock, { mode: 0o700 }); }
	catch { throw new Error("Settings are busy or not writable; no changes were made."); }
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		if (delegateConfigRevision(paths) !== baseline) conflict();
		const text = `${JSON.stringify(next, null, 2)}\n`;
		const nextRevision = JSON.stringify([state.identity[0], state.identity[1], join(realpathSync(dirname(path)), basename(path)), text]);
		writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
		chmodSync(temp, mode);
		if (delegateConfigRevision(paths) !== baseline) conflict();
		renameSync(temp, path);
		return nextRevision;
	} finally {
		try { unlinkSync(temp); } catch { /* private temporary file only */ }
		try { rmdirSync(lock); } catch { /* Persistence may already have succeeded. */ }
	}
}
