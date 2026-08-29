import { existsSync, readFileSync } from "node:fs";
import { isNonEmptyStringArray } from "../child-runtime/policy.ts";

export const KINDS = ["recon", "implement", "review", "oracle"] as const;
export type Kind = (typeof KINDS)[number];

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface AgentConfig {
	model: string;
	tools: string[];
	thinking: ThinkingLevel;
	offline: boolean;
}

export interface DelegateConfig {
	maxTaskChars: number;
	maxConcurrent: number;
	maxLocalConcurrent: number;
	maxQueued: number;
	defaultTimeoutMs: number;
	maxTimeoutMs: number;
	maxOutputBytes: number;
	agents: Record<Kind, AgentConfig>;
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
	if (!Number.isInteger(parsed.defaultTimeoutMs)) errors.push("defaultTimeoutMs (integer)");
	if (!Number.isInteger(parsed.maxTimeoutMs)) errors.push("maxTimeoutMs (integer)");
	if (!Number.isInteger(parsed.maxOutputBytes) || (parsed.maxOutputBytes as number) < 1) {
		errors.push("maxOutputBytes (integer >= 1)");
	}
	if (errors.length === 0) {
		const defaultTimeoutMs = parsed.defaultTimeoutMs as number;
		const maxTimeoutMs = parsed.maxTimeoutMs as number;
		if (maxTimeoutMs < 1000) errors.push("maxTimeoutMs (>= 1000)");
		if (defaultTimeoutMs < 1000 || defaultTimeoutMs > maxTimeoutMs) {
			errors.push("defaultTimeoutMs (in [1000, maxTimeoutMs])");
		}
	}
	if (!parsed.agents || typeof parsed.agents !== "object") {
		errors.push("agents (object)");
	}
	return errors;
}

export function parseDelegateConfig(value: unknown, path: string): DelegateConfig {
	if (!value || typeof value !== "object") {
		throw new Error(`Invalid delegate config: ${path}`);
	}
	const parsed = value as Record<string, unknown>;
	const errors = collectConfigErrors(parsed);
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
		maxOutputBytes: parsed.maxOutputBytes as number,
		agents,
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
		maxOutputBytes: extra.maxOutputBytes ?? base.maxOutputBytes,
		agents: { ...base.agents },
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

export function loadDelegateConfig(input: { shippedPath: string; userPath?: string }): DelegateConfig {
	const shipped = parseDelegateConfig(JSON.parse(readFileSync(input.shippedPath, "utf8")), input.shippedPath);
	if (!input.userPath || !existsSync(input.userPath)) return shipped;
	return mergeDelegateConfig(shipped, JSON.parse(readFileSync(input.userPath, "utf8")), input.userPath);
}
