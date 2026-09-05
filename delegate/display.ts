import { KINDS, type Kind } from "./config.ts";

export type ActivityMark = "→" | "✓" | "✗" | "…";

export type ActivityItem = {
	mark: ActivityMark;
	name: string;
	args?: string;
	id?: string;
};

export const LIVE_ACTIVITY_MAX = 3;
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
	jobId?: string,
): string {
	return [
		theme.fg("toolTitle", theme.bold(title)),
		theme.fg("accent", kind || "…"),
		theme.fg("dim", model || "…"),
		...(jobId ? [theme.fg("accent", jobId)] : []),
	].join(" · ");
}

export function activityLabel(current: ActivityItem | undefined): string {
	if (!current) return "working";
	if (current.name === "writing") return "writing result";
	if (current.name === "thinking") return "thinking";
	const labels: Record<string, string> = {
		bash: "executing command", read: "reading file", write: "writing file", edit: "editing file",
		grep: "searching files", find: "finding files", ls: "listing files",
	};
	return labels[current.name] ?? `using ${current.name}`;
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

function sameToolCall(a: ActivityItem, b: ActivityItem): boolean {
	return a.id && b.id ? a.id === b.id : a.name === b.name;
}

export function sameActivity(a: ActivityItem, b: ActivityItem): boolean {
	return a.id === b.id && a.mark === b.mark && a.name === b.name && (a.args ?? "") === (b.args ?? "");
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
			if (entry.mark === "→" && sameToolCall(entry, item)) {
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
	const base = remembered ?? (state.current?.mark === "→" && sameToolCall(state.current, item) ? state.current : undefined);
	const completed = base ? mergeActivity(base, item) : item;
	if (completed.id) state.open.delete(completed.id);
	appendActivity(state.done, completed);
	if (state.current && sameToolCall(state.current, completed)) {
		state.current = [...state.open.values()].at(-1);
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

export type JobBoardRow = { local: boolean; status: string };

export function formatJobBoard(jobs: JobBoardRow[], limits: { maxLocalConcurrent: number }): string[] {
	const run = jobs.filter((job) => job.status === "running");
	const wait = jobs.filter((job) => job.status === "queued");
	const localRun = run.filter((job) => job.local).length;
	return [`delegate  ${run.length} run  ${wait.length} wait  local ${localRun}/${limits.maxLocalConcurrent}`];
}
