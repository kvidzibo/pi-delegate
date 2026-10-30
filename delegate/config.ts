import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { Alternative } from "./calibration.ts";
import { isLocalModel } from "./tg.ts";
import { MAX_TIMER_MS } from "../child-runtime/policy.ts";

export type Kind = string;
export const ROLE_NAME = /^[a-z][a-z0-9_-]{0,63}$/;

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface AgentConfig {
	enabled?: boolean;
	model: string;
	prompt: string;
	extensions: boolean;
	tools: string[];
	thinking: ThinkingLevel;
}

export interface DelegateConfig {
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
	override: string | undefined,
	config: DelegateConfig,
): { kind: Kind; model: string; agent: AgentConfig } {
	assertKind(kind);
	if (!Object.hasOwn(config.agents, kind)) throw new Error(`delegate refused: unknown role ${kind}.`);
	const agent = config.agents[kind];
	if (agent.enabled === false) throw new Error(`delegate refused: ${kind} is disabled in configuration.`);
	const model = override?.trim() ? override.trim() : agent.model;
	if (!model) throw new Error("delegate refused: model is empty.");
	return { kind, model, agent };
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
	let tools: string[] | undefined;
	try {
		tools = parsed.tools === undefined ? ["*"] : parseTools(parsed.tools, "tools");
	} catch (error) {
		errors.push(error instanceof Error ? error.message : "tools");
	}
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
		extensions: base.extensions,
		tools: base.tools,
		thinking: base.thinking,
	};
	if (parsed.enabled !== undefined) next.enabled = parsed.enabled;
	if (parsed.model !== undefined) next.model = parsed.model;
	if (parsed.prompt !== undefined) next.prompt = parsed.prompt;
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
	const state = readConfigState(paths);
	const baseline = JSON.stringify(state.identity);
	const conflict = () => { throw new Error(`${kind} changed on disk. Run /reload before changing it here (reload stops outstanding children).`); };
	if (revision !== undefined && revision !== baseline) conflict();
	const { overlay, shipped, config, mode } = state;
	const saved = Object.hasOwn(config.agents, kind) ? config.agents[kind] : undefined;
	if (!isDeepStrictEqual(saved, current)) conflict();
	if (!current && (!patch.model || !patch.prompt?.trim())) throw new Error("New roles require an explicit model and nonblank prompt.");
	const next = { ...overlay, agents: { ...overlay.agents, [kind]: {
		...(current ? overlay.agents?.[kind] : { enabled: true, tools: [], extensions: false, thinking: "off" }), ...patch,
	} } };
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
