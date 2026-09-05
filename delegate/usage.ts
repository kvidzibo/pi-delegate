import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { isLocalModel } from "./tg.ts";

export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
export type UsageSummary = {
	local: Tokens;
	hosted: Tokens;
	reported: number;
	missing: number;
	incomplete: boolean;
};

export const emptyTokens = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
export const emptyUsage = (): UsageSummary => ({ local: emptyTokens(), hosted: emptyTokens(), reported: 0, missing: 0, incomplete: false });
export const record = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};

export function addTokens(target: Tokens, source: Tokens): void {
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) target[key] += source[key];
}

export function totalTokens(usage: UsageSummary): number { return usage.local.total + usage.hosted.total; }

/** Pi normalizes input/cache buckets. Reasoning is already included in output; never add it again. */
export function reportedTokens(value: unknown): Tokens | undefined {
	const usage = record(value);
	const keys = ["input", "output", "cacheRead", "cacheWrite"] as const;
	if (!keys.every((key) => Number.isSafeInteger(usage[key]) && usage[key] >= 0)) return undefined;
	const total = keys.reduce((n, key) => n + usage[key], 0);
	// Pi uses all-zero usage as a placeholder on missing/provider-error responses.
	if (!Number.isSafeInteger(total) || total === 0) return undefined;
	return { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, total };
}

export function addUsage(summary: UsageSummary, value: unknown, model: string): void {
	const tokens = reportedTokens(value);
	if (!tokens) { summary.missing++; summary.incomplete = true; return; }
	addTokens(isLocalModel(model) ? summary.local : summary.hosted, tokens);
	summary.reported++;
}

export function messageModel(value: unknown, fallback: string): string {
	const m = record(value);
	return typeof m.provider === "string" && m.provider.trim() && typeof m.model === "string" && m.model.trim()
		? `${m.provider.trim()}/${m.model.trim()}` : fallback;
}

/** Live counters only. Cumulative agent_end/turn_end and streaming updates are never added as turns. */
export class UsageMeter {
	readonly completed = emptyUsage();
	model: string;
	resolvedModel?: string;
	settled = false;
	private pending?: Tokens;
	private inFlight = false;
	private seen = new Set<string>();
	private messageEpoch = 0;
	private compactionEpoch = 0;

	constructor(model: string) { this.model = model; }

	observe(event: unknown): { changed: boolean; checkpoint: boolean } {
		const e = record(event);
		const m = record(e.message);
		if (e.type === "agent_settled") { this.settled = true; return { changed: true, checkpoint: true }; }
		if (e.type === "compaction_start") { this.compactionEpoch++; return { changed: false, checkpoint: false }; }
		if (e.type === "message_start" && m.role === "assistant") {
			this.messageEpoch++;
			this.inFlight = true; this.pending = undefined;
			this.resolvedModel = messageModel(m, this.resolvedModel ?? "") || undefined;
			this.model = this.resolvedModel ?? this.model;
			return { changed: true, checkpoint: false };
		}
		if (e.type === "message_update") {
			const pending = reportedTokens(e.usage);
			if (pending && JSON.stringify(pending) !== JSON.stringify(this.pending)) {
				this.pending = pending; this.inFlight = true;
				return { changed: true, checkpoint: false };
			}
		}
		const message = e.type === "message_end" && (m.role === "assistant" || (m.role === "toolResult" && m.usage !== undefined));
		const compaction = e.type === "compaction_end" && e.result;
		if (message || compaction) {
			const epoch = message ? `message:${this.messageEpoch}` : `compaction:${this.compactionEpoch}`;
			const key = `${epoch}:${createHash("sha256").update(JSON.stringify(e)).digest("hex")}`;
			if (this.seen.has(key)) return { changed: false, checkpoint: false };
			this.seen.add(key);
			if (message && m.role === "assistant") {
				this.resolvedModel = messageModel(m, this.resolvedModel ?? "") || undefined;
				this.model = this.resolvedModel ?? this.model;
				if (!reportedTokens(m.usage) && this.pending) addTokens(isLocalModel(this.model) ? this.completed.local : this.completed.hosted, this.pending);
				this.pending = undefined; this.inFlight = false;
			}
			addUsage(this.completed, message ? m.usage : record(e.result).usage, this.model);
			return { changed: true, checkpoint: true };
		}
		if (e.type === "compaction_end" && (e.aborted || e.errorMessage)) {
			this.completed.incomplete = true;
			return { changed: true, checkpoint: true };
		}
		return { changed: false, checkpoint: false };
	}

	snapshot(): UsageSummary {
		const result = structuredClone(this.completed);
		if (this.pending) addTokens(isLocalModel(this.model) ? result.local : result.hosted, this.pending);
		if (this.inFlight) result.incomplete = true;
		return result;
	}
}

/** LF-only file reader; keep one native entry in memory, not the full lifetime transcript. */
export async function* jsonlLines(path: string): AsyncGenerator<string> {
	const stream = createReadStream(path, { encoding: "utf8" });
	let tail = "";
	for await (const chunk of stream) {
		tail += chunk;
		let start = 0;
		let end: number;
		while ((end = tail.indexOf("\n", start)) !== -1) {
			yield tail.slice(start, end);
			start = end + 1;
		}
		tail = tail.slice(start);
	}
	if (tail.trim()) yield tail;
}

export async function sessionUsage(path: string, fallbackModel: string): Promise<UsageSummary> {
	const summary = emptyUsage();
	const seen = new Set<string>();
	let header = false;
	let model = fallbackModel;
	for await (const line of jsonlLines(path)) {
		if (!line.trim()) continue;
		let e: Record<string, any>;
		try { e = record(JSON.parse(line)); } catch { summary.incomplete = true; continue; }
		if (e.type === "session") { header = e.version === 3 && typeof e.id === "string"; continue; }
		if (typeof e.id !== "string") { summary.incomplete = true; continue; }
		if (seen.has(e.id)) continue;
		seen.add(e.id);
		if (e.type === "model_change" && typeof e.provider === "string" && typeof e.modelId === "string") model = `${e.provider}/${e.modelId}`;
		if (e.type === "message") {
			const m = record(e.message);
			if (m.role === "assistant") {
				model = messageModel(m, model);
				addUsage(summary, m.usage, model);
			} else if (m.role === "toolResult" && m.usage !== undefined) addUsage(summary, m.usage, model);
		} else if (e.type === "compaction" || e.type === "branch_summary") {
			addUsage(summary, e.usage, model);
			// retainedTail contains copies of old messages, NOT new inference.
		}
	}
	if (!header) summary.incomplete = true;
	return summary;
}

export function validUsage(value: unknown): value is UsageSummary {
	const u = record(value);
	return [u.local, u.hosted].every((value) => {
		const t = record(value);
		return ["input", "output", "cacheRead", "cacheWrite", "total"].every((k) => Number.isSafeInteger(t[k]) && t[k] >= 0)
			&& t.total === t.input + t.output + t.cacheRead + t.cacheWrite;
	}) && Number.isSafeInteger(u.reported) && u.reported >= 0 && Number.isSafeInteger(u.missing) && u.missing >= 0 && typeof u.incomplete === "boolean";
}
