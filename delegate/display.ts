import { KINDS, type Kind } from "./config.ts";

export type DelegateModels = Record<Kind, string>;

export type ActivityMark = "→" | "✓" | "✗" | "…";

export type ActivityItem = {
	mark: ActivityMark;
	name: string;
	args?: string;
	id?: string;
};

export const LIVE_ACTIVITY_MAX = 3;
export const ACTIVITY_NAME_PAD = 8;
export const ACTIVITY_ARG_MAX = 40;
export const THINKING_TAIL_MAX = ACTIVITY_ARG_MAX;
const THINKING_BUF_MAX = 200;

export function aliasForModel(model: string | undefined): string {
	if (!model) return "…";
	const slash = model.lastIndexOf("/");
	const id = (slash >= 0 ? model.slice(slash + 1) : model).trim();
	if (!id) return "…";
	const lower = id.toLowerCase();
	if (lower.includes("spark")) return "Spark";
	if (lower.includes("luna")) return "Luna";
	if (lower.includes("terra")) return "Terra";
	if (/(^|[-_])sol$/.test(lower)) return "Sol";
	if (lower.startsWith("qwen")) return "Qwen";
	return id;
}

export function plannedModel(kind: Kind, models: DelegateModels): string {
	return models[kind];
}

export function knownKind(value: unknown): Kind | undefined {
	if (typeof value === "string" && (KINDS as readonly string[]).includes(value)) return value as Kind;
	return undefined;
}

export function formatDelegateTarget(kind: string | undefined, model: string | undefined): string {
	const shownKind = knownKind(kind) ?? "…";
	const alias = aliasForModel(model);
	if (!model) return shownKind === "…" ? "…" : `${shownKind} → ${alias}`;
	return `${shownKind} → ${alias} (${model})`;
}

export function delegateTargetLine(kind: string | undefined, model: string | undefined): string {
	return `[delegate ${formatDelegateTarget(kind, model)}]`;
}

export function clipActivityArg(raw: string, max = ACTIVITY_ARG_MAX): string {
	const compact = raw.replace(/\s+/g, " ").trim();
	if (compact.length <= max) return compact;
	return `${compact.slice(0, Math.max(1, max - 1))}…`;
}

export function clipThinkingTail(raw: string, max = THINKING_TAIL_MAX): string {
	const compact = raw.replace(/\s+/g, " ").trim();
	if (!compact) return "";
	if (compact.length <= max) return compact;
	return `…${compact.slice(-Math.max(1, max - 1))}`;
}

function appendThinking(prev: string | undefined, delta: string): string {
	if (!delta) return prev ?? "";
	const next = `${prev ?? ""}${delta}`;
	return next.length > THINKING_BUF_MAX ? next.slice(-THINKING_BUF_MAX) : next;
}

export type HeaderExtras = {
	background?: boolean;
	jobId?: string;
	status?: string;
};

export function delegateHeaderBits(
	kind: string | undefined,
	model: string | undefined,
	thinking?: string,
	tg?: string,
	extras?: HeaderExtras,
): { target: string; model?: string; tg?: string; thinking?: string; background?: boolean; jobId?: string; status?: string } {
	const shownKind = kind && kind.length > 0 ? kind : "…";
	const bits: {
		target: string;
		model?: string;
		tg?: string;
		thinking?: string;
		background?: boolean;
		jobId?: string;
		status?: string;
	} = {
		target: `${shownKind} → ${aliasForModel(model)}`,
	};
	if (model) bits.model = model;
	if (extras?.background) bits.background = true;
	if (extras?.jobId) bits.jobId = extras.jobId;
	if (extras?.status) bits.status = extras.status;
	if (tg) bits.tg = tg;
	const snippet = clipThinkingTail(thinking ?? "");
	if (snippet) bits.thinking = snippet;
	return bits;
}

export type ThemeFg = {
	fg: (key: string, text: string) => string;
	bold: (text: string) => string;
	italic: (text: string) => string;
};

export function paintHeader(
	theme: ThemeFg,
	title: string,
	kind: string | undefined,
	model: string | undefined,
	thinking?: string,
	tg?: string,
	extras?: HeaderExtras,
): string {
	const bits = delegateHeaderBits(kind, model, thinking, tg, extras);
	let line = theme.fg("toolTitle", theme.bold(title));
	line += "  ";
	line += theme.fg("accent", bits.target);
	if (bits.model) line += `  ${theme.fg("dim", bits.model)}`;
	if (bits.background) line += `  ${theme.fg("dim", "bg")}`;
	if (bits.jobId) line += `  ${theme.fg("accent", bits.jobId)}`;
	if (bits.status) {
		const color = bits.status === "running" || bits.status === "done" ? "accent" : "dim";
		line += `  ${theme.fg(color, bits.status)}`;
	}
	if (bits.tg) line += `  ${theme.fg("accent", bits.tg)}`;
	if (bits.thinking) line += `  ${theme.fg("thinkingText", theme.italic(bits.thinking))}`;
	return line;
}

export function summarizeToolArgs(name: string, args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const rec = args as Record<string, unknown>;
	const str = (key: string) => (typeof rec[key] === "string" ? rec[key] : "");
	let raw = "";
	if (name === "bash") raw = str("command");
	else if (name === "grep") raw = str("pattern") || str("glob") || str("path");
	else if (name === "find") raw = str("pattern") || str("path");
	else raw = str("path") || str("pattern") || str("url") || str("query") || "";
	return clipActivityArg(raw);
}

export function parseChildProgress(event: unknown): ActivityItem | undefined {
	if (!event || typeof event !== "object") return undefined;
	const rec = event as {
		type?: unknown;
		toolName?: unknown;
		toolCallId?: unknown;
		args?: unknown;
		isError?: unknown;
		assistantMessageEvent?: { type?: unknown; delta?: unknown };
	};
	if (
		typeof rec.toolName === "string" &&
		(rec.type === "tool_execution_start" || rec.type === "tool_execution_update" || rec.type === "tool_execution_end")
	) {
		const mark: ActivityMark = rec.type === "tool_execution_end" ? (rec.isError ? "✗" : "✓") : "→";
		const args = summarizeToolArgs(rec.toolName, rec.args);
		const item: ActivityItem = { mark, name: rec.toolName };
		if (args) item.args = args;
		if (typeof rec.toolCallId === "string" && rec.toolCallId) item.id = rec.toolCallId;
		return item;
	}
	if (rec.type === "message_update") {
		const ev = rec.assistantMessageEvent;
		const t = ev?.type;
		if (t === "thinking_start") return { mark: "…", name: "thinking" };
		if (t === "thinking_delta") {
			return { mark: "…", name: "thinking", args: typeof ev?.delta === "string" ? ev.delta : "" };
		}
		if (t === "text_delta" || t === "text_start") return { mark: "…", name: "writing" };
	}
	return undefined;
}

export type ProgressState = {
	done: ActivityItem[];
	current?: ActivityItem;
	open: Map<string, ActivityItem>;
	thinking?: string;
};

export function createProgress(): ProgressState {
	return { done: [], open: new Map() };
}

export function formatActivityPlain(item: ActivityItem): string {
	const name = item.name.padEnd(ACTIVITY_NAME_PAD);
	const args = item.args?.trim() ?? "";
	return args ? `${item.mark}  ${name}  ${args}` : `${item.mark}  ${name}`.trimEnd();
}

export function sameActivity(a: ActivityItem, b: ActivityItem): boolean {
	return a.mark === b.mark && a.name === b.name && (a.args ?? "") === (b.args ?? "");
}

function mergeActivity(prev: ActivityItem, next: ActivityItem): ActivityItem {
	const merged: ActivityItem = {
		mark: next.mark,
		name: next.name || prev.name,
	};
	const args = next.args || prev.args;
	if (args) merged.args = args;
	const id = next.id || prev.id;
	if (id) merged.id = id;
	return merged;
}

export function appendActivity(items: ActivityItem[], item: ActivityItem, max = LIVE_ACTIVITY_MAX): boolean {
	const last = items[items.length - 1];
	if (item.id) {
		const idx = items.findIndex((entry) => entry.id === item.id);
		if (idx >= 0) {
			const merged = mergeActivity(items[idx], item);
			if (sameActivity(items[idx], merged)) return false;
			items[idx] = merged;
			return true;
		}
	}
	if (last && sameActivity(last, item)) return false;
	if (item.mark === "✓" || item.mark === "✗") {
		for (let i = items.length - 1; i >= 0; i--) {
			const entry = items[i];
			if (entry.mark === "→" && entry.name === item.name) {
				items[i] = mergeActivity(entry, item);
				return true;
			}
		}
	}
	if (item.mark === "…" && last?.mark === "…") {
		items[items.length - 1] = mergeActivity(last, item);
		return true;
	}
	items.push(item);
	if (items.length > max) items.splice(0, items.length - max);
	return true;
}

function rememberOpen(state: ProgressState, item: ActivityItem): ActivityItem {
	if (!item.id) return item;
	const prev = state.open.get(item.id);
	const merged = prev ? mergeActivity(prev, item) : item;
	state.open.set(item.id, merged);
	return merged;
}

function isThinkingItem(item: ActivityItem): boolean {
	return item.mark === "…" && item.name === "thinking";
}

function clearThinking(state: ProgressState): boolean {
	if (!state.thinking) return false;
	state.thinking = undefined;
	return true;
}

export function applyProgress(state: ProgressState, item: ActivityItem): boolean {
	if (isThinkingItem(item)) {
		if (item.args === undefined) return clearThinking(state);
		const next = appendThinking(state.thinking, item.args);
		if (next === (state.thinking ?? "")) return false;
		state.thinking = next;
		return true;
	}
	if (item.mark === "…") {
		const cleared = clearThinking(state);
		if (state.current?.mark === "→") return cleared;
		if (state.current && sameActivity(state.current, item)) return cleared;
		state.current = item;
		return true;
	}
	if (item.mark === "→") {
		const live = rememberOpen(state, item);
		if (state.current && sameActivity(state.current, live)) return false;
		state.current = live;
		return true;
	}
	const remembered = item.id ? state.open.get(item.id) : undefined;
	if (item.id) state.open.delete(item.id);
	const base =
		remembered ??
		(item.id && state.current?.id === item.id
			? state.current
			: state.current?.mark === "→" && state.current.name === item.name
				? state.current
				: undefined);
	const completed = base ? mergeActivity(base, item) : item;
	appendActivity(state.done, completed);
	if (
		state.current &&
		((completed.id && state.current.id === completed.id) ||
			(state.current.mark === "→" && state.current.name === completed.name))
	) {
		state.current = undefined;
	}
	return true;
}

export function asActivityItem(value: unknown): ActivityItem | undefined {
	return asActivityList(value == null ? [] : [value])[0];
}

export function asActivityList(value: unknown): ActivityItem[] {
	if (!Array.isArray(value)) return [];
	const out: ActivityItem[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") continue;
		const rec = entry as { mark?: unknown; name?: unknown; args?: unknown; id?: unknown };
		if (rec.mark !== "→" && rec.mark !== "✓" && rec.mark !== "✗" && rec.mark !== "…") continue;
		if (typeof rec.name !== "string" || rec.name.length === 0) continue;
		const item: ActivityItem = { mark: rec.mark, name: rec.name };
		if (typeof rec.args === "string" && rec.args.length > 0) item.args = rec.args;
		if (typeof rec.id === "string" && rec.id.length > 0) item.id = rec.id;
		out.push(item);
	}
	return out;
}

export type JobBoardRow = {
	id: string;
	kind: string;
	model?: string;
	local: boolean;
	status: "queued" | "running";
	reason?: "gpu" | "slot";
	tg?: string;
	current?: ActivityItem;
};

export function formatJobBoard(jobs: JobBoardRow[], limits: { maxLocalConcurrent: number }): string[] {
	const run = jobs.filter((job) => job.status === "running");
	const wait = jobs.filter((job) => job.status === "queued");
	const localRun = run.filter((job) => job.local).length;
	const lines = [`delegate  ${run.length} run  ${wait.length} wait  local ${localRun}/${limits.maxLocalConcurrent}`];
	for (const job of [...run, ...wait]) {
		const tag = job.status === "running" ? "run " : "wait";
		let line = `  ${tag}  ${job.id}  ${job.kind} → ${aliasForModel(job.model)}`;
		if (job.status === "running" && job.tg) line += `  ${job.tg}`;
		if (job.status === "queued" && job.reason === "gpu") line += "  gpu";
		const current = job.status === "running" ? job.current : undefined;
		if (current && current.name !== "thinking") {
			line += `  ${current.mark} ${current.name}`;
			if (current.args) line += `  ${current.args}`;
		}
		lines.push(line);
	}
	return lines;
}
