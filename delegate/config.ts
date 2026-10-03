import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Alternative } from "./calibration.ts";
import { isLocalModel } from "./tg.ts";
import { isNonEmptyStringArray, MAX_TIMER_MS } from "../child-runtime/policy.ts";

export const KINDS = ["recon", "implement", "review", "oracle"] as const;
export type Kind = (typeof KINDS)[number];

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface AgentConfig {
	model: string;
	tools: string[];
	thinking: ThinkingLevel;
	offline: boolean;
}

export interface SnapshotConfig {
	directory?: string;
	defaultEnabled?: boolean;
	repositories: Record<string, boolean>;
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
	snapshots: SnapshotConfig;
}

export function assertKind(value: unknown): Kind {
	if (typeof value !== "string" || !(KINDS as readonly string[]).includes(value)) {
		throw new Error(`delegate refused: kind must be one of ${KINDS.join("|")}.`);
	}
	return value as Kind;
}

export function resolveAgent(
	kind: Kind,
	override: string | undefined,
	config: DelegateConfig,
): { kind: Kind; model: string; agent: AgentConfig } {
	const agent = config.agents[kind];
	const model = override?.trim() ? override.trim() : agent.model;
	if (!model) throw new Error("delegate refused: model is empty.");
	return { kind, model, agent };
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function parseTools(value: unknown, label: string): string[] {
	if (!isNonEmptyStringArray(value)) {
		throw new Error(`${label} (non-empty string array)`);
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
	if (tools.length === 0) throw new Error(`${label} (non-empty string array)`);
	return tools;
}

function parseAgent(value: unknown, label: string): AgentConfig {
	if (!value || typeof value !== "object") {
		throw new Error(`${label} (object)`);
	}
	const parsed = value as Record<string, unknown>;
	const errors: string[] = [];
	if (typeof parsed.model !== "string" || parsed.model.trim().length === 0) {
		errors.push("model (non-empty string)");
	}
	let tools: string[] | undefined;
	try {
		tools = parseTools(parsed.tools, "tools");
	} catch (error) {
		errors.push(error instanceof Error ? error.message : "tools");
	}
	if (!isThinkingLevel(parsed.thinking)) errors.push(`thinking (one of ${THINKING_LEVELS.join("|")})`);
	if (parsed.offline !== undefined && typeof parsed.offline !== "boolean") errors.push("offline (boolean)");
	if (errors.length > 0) throw new Error(`${label} (${errors.join("; ")})`);
	const model = (parsed.model as string).trim();
	if (!model) throw new Error(`${label} (model (non-empty string))`);
	return {
		model,
		tools: tools as string[],
		thinking: parsed.thinking as ThinkingLevel,
		offline: parsed.offline === true,
	};
}

function parseSnapshots(value: unknown, label = "snapshots"): SnapshotConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} (object)`);
	const raw = value as Record<string, unknown>;
	const errors: string[] = [];
	if (raw.defaultEnabled !== undefined && typeof raw.defaultEnabled !== "boolean") errors.push("defaultEnabled (boolean)");
	if (raw.directory !== undefined && (typeof raw.directory !== "string" || raw.directory.length === 0 || !isAbsolute(raw.directory))) {
		errors.push("directory (non-empty absolute path)");
	}
	if (!raw.repositories || typeof raw.repositories !== "object" || Array.isArray(raw.repositories) ||
		(Object.getPrototypeOf(raw.repositories) !== Object.prototype && Object.getPrototypeOf(raw.repositories) !== null)) {
		errors.push("repositories (object)");
	} else {
		for (const [root, enabled] of Object.entries(raw.repositories)) {
			if (!isAbsolute(root) || resolve(root) !== root) errors.push(`repositories.${root} (absolute canonical repository root path)`);
			if (typeof enabled !== "boolean") errors.push(`repositories.${root} (boolean)`);
		}
	}
	if (errors.length) throw new Error(`${label} (${errors.join("; ")})`);
	return {
		...(raw.directory === undefined ? {} : { directory: raw.directory as string }),
		...(raw.defaultEnabled === undefined ? {} : { defaultEnabled: raw.defaultEnabled as boolean }),
		repositories: { ...(raw.repositories as Record<string, boolean>) },
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
	if (!parsed.agents || typeof parsed.agents !== "object") {
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
	let snapshots: SnapshotConfig = { repositories: {} };
	try { if (parsed.snapshots !== undefined) snapshots = parseSnapshots(parsed.snapshots); }
	catch (error) { errors.push(error instanceof Error ? error.message : "snapshots"); }
	const profiles = parsed.calibrationProfiles ?? [];
	if (!Array.isArray(profiles) || profiles.length > 100 || !profiles.every(p => typeof p === "string" && isAbsolute(p))) {
		errors.push("calibrationProfiles (up to 100 absolute file paths)");
	}
	const agents = {} as Record<Kind, AgentConfig>;
	if (parsed.agents && typeof parsed.agents === "object") {
		const rawAgents = parsed.agents as Record<string, unknown>;
		for (const kind of KINDS) {
			try {
				agents[kind] = parseAgent(rawAgents[kind], `agents.${kind}`);
			} catch (error) {
				errors.push(error instanceof Error ? error.message : `agents.${kind}`);
			}
		}
		for (const key of Object.keys(rawAgents)) {
			if (!(KINDS as readonly string[]).includes(key)) errors.push(`agents.${key} (unknown agent)`);
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
		snapshots,
	};
}

function mergeAgent(base: AgentConfig, extra: unknown, label: string): AgentConfig {
	if (extra === undefined) return base;
	if (!extra || typeof extra !== "object" || Array.isArray(extra)) {
		throw new Error(`${label} (object)`);
	}
	const parsed = extra as Record<string, unknown>;
	const next: Record<string, unknown> = {
		model: base.model,
		tools: base.tools,
		thinking: base.thinking,
		offline: base.offline,
	};
	if (parsed.model !== undefined) next.model = parsed.model;
	if (parsed.tools !== undefined) next.tools = parsed.tools;
	if (parsed.thinking !== undefined) next.thinking = parsed.thinking;
	if (parsed.offline !== undefined) next.offline = parsed.offline;
	return parseAgent(next, label);
}

function mergeSnapshots(base: SnapshotConfig, extra: unknown, path: string): SnapshotConfig {
	if (extra === undefined) return base;
	if (!extra || typeof extra !== "object" || Array.isArray(extra)) throw new Error(`Invalid delegate config: ${path} (snapshots (object))`);
	const raw = extra as Record<string, unknown>;
	if (raw.repositories !== undefined && (!raw.repositories || typeof raw.repositories !== "object" || Array.isArray(raw.repositories))) {
		throw new Error(`Invalid delegate config: ${path} (snapshots.repositories (object))`);
	}
	return parseSnapshots({
		...(raw.directory === undefined ? (base.directory === undefined ? {} : { directory: base.directory }) : { directory: raw.directory }),
		defaultEnabled: raw.defaultEnabled === undefined ? base.defaultEnabled : raw.defaultEnabled,
		repositories: { ...base.repositories, ...((raw.repositories ?? {}) as Record<string, unknown>) },
	}, `Invalid delegate config: ${path} snapshots`);
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
		snapshots: mergeSnapshots(base.snapshots, extra.snapshots, path),
	};
	if (extra.agents !== undefined) {
		if (!extra.agents || typeof extra.agents !== "object" || Array.isArray(extra.agents)) {
			throw new Error(`Invalid delegate config: ${path} (agents (object))`);
		}
		const rawAgents = extra.agents as Record<string, unknown>;
		const agents: Record<string, AgentConfig> = { ...base.agents };
		for (const key of Object.keys(rawAgents)) {
			if (!(KINDS as readonly string[]).includes(key)) {
				throw new Error(`Invalid delegate config: ${path} (agents.${key} (unknown agent))`);
			}
			const kind = key as Kind;
			agents[kind] = mergeAgent(base.agents[kind], rawAgents[kind], `agents.${kind}`);
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

/** Patch only this role's model/startup mode; never rewrite shipped defaults or other settings. */
export function saveDelegateModel(paths: ConfigPaths, kind: Kind, current: AgentConfig, model: string): Pick<AgentConfig, "model" | "offline"> {
	if (!/^[^/\s]+\/[^\s]+$/.test(model)) throw new Error("Expected a provider/model ID.");
	const patch = { model, offline: isLocalModel(model) ? current.offline : false };
	saveDelegatePatch(paths, kind, current, patch);
	return patch;
}

/** Persist reasoning independently; preserve model, startup mode and tools. */
export function saveDelegateThinking(paths: ConfigPaths, kind: Kind, current: AgentConfig, thinking: ThinkingLevel): Pick<AgentConfig, "thinking"> {
	if (!isThinkingLevel(thinking)) throw new Error("Unsupported thinking level.");
	const patch = { thinking };
	saveDelegatePatch(paths, kind, current, patch);
	return patch;
}

function sameSnapshots(a: SnapshotConfig, b: SnapshotConfig): boolean {
	if (a.directory !== b.directory || (a.defaultEnabled ?? false) !== (b.defaultEnabled ?? false)) return false;
	const aKeys = Object.keys(a.repositories).sort();
	const bKeys = Object.keys(b.repositories).sort();
	return aKeys.length === bKeys.length && aKeys.every((key, index) => key === bKeys[index] && a.repositories[key] === b.repositories[key]);
}

/** Persist opt-in repository snapshot settings without disturbing other user configuration. */
export function saveDelegateSnapshots(paths: ConfigPaths, current: SnapshotConfig, next: SnapshotConfig): void {
	if (!paths.userPath) throw new Error("User config is disabled (PI_DELEGATE_SKIP_USER_CONFIG=1).");
	const validatedCurrent = parseSnapshots(current, "current snapshots");
	const validatedNext = parseSnapshots(next, "next snapshots");
	let path = paths.userPath;
	let overlay: Record<string, unknown> & { snapshots?: unknown } = {};
	let mode = 0o600;
	let exists = false;
	try { lstatSync(path); exists = true; }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	if (exists) {
		path = realpathSync(path);
		overlay = JSON.parse(readFileSync(path, "utf8"));
		mode = statSync(path).mode & 0o777;
	}
	if (path === realpathSync(paths.shippedPath)) throw new Error("User config must not point at shipped delegate defaults.");
	const shipped = loadDelegateConfig({ shippedPath: paths.shippedPath });
	const saved = mergeDelegateConfig(shipped, overlay, path).snapshots;
	if (!sameSnapshots(saved, validatedCurrent)) {
		throw new Error("Snapshots changed on disk. Run /reload before changing them here (reload stops outstanding children).");
	}
	const updated = { ...overlay, snapshots: validatedNext };
	mergeDelegateConfig(shipped, updated, path);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temp, `${JSON.stringify(updated, null, 2)}\n`, { mode, flag: "wx" });
		renameSync(temp, path);
	} finally {
		try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
}

function saveDelegatePatch(paths: ConfigPaths, kind: Kind, current: AgentConfig, patch: Partial<AgentConfig>): void {
	if (!paths.userPath) throw new Error("User config is disabled (PI_DELEGATE_SKIP_USER_CONFIG=1).");
	assertKind(kind);
	let path = paths.userPath;
	let overlay: Record<string, unknown> & { agents?: Partial<Record<Kind, Record<string, unknown>>> } = {};
	let mode = 0o600;
	let exists = false;
	try { lstatSync(path); exists = true; }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	if (exists) {
		// Preserve symlinks; a dangling link or unreadable/invalid file fails without writes.
		path = realpathSync(path);
		overlay = JSON.parse(readFileSync(path, "utf8"));
		mode = statSync(path).mode & 0o777;
	}
	if (path === realpathSync(paths.shippedPath)) throw new Error("User config must not point at shipped delegate defaults.");
	const shipped = loadDelegateConfig({ shippedPath: paths.shippedPath });
	const saved = mergeDelegateConfig(shipped, overlay, path).agents[kind];
	if (saved.model !== current.model || (Object.keys(patch) as (keyof AgentConfig)[]).some(key => saved[key] !== current[key])) {
		throw new Error(`${kind} changed on disk. Run /reload before changing it here (reload stops outstanding children).`);
	}
	const next = { ...overlay, agents: { ...overlay.agents, [kind]: { ...overlay.agents?.[kind], ...patch } } };
	mergeDelegateConfig(shipped, next, path);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode, flag: "wx" });
		renameSync(temp, path);
	} finally {
		try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
}
