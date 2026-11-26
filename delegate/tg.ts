export const TG_MIN_MS = 200;

const LOCAL_PROVIDERS = new Set(["local-qwen38", "llama.cpp", "ollama"]);

export type LocalModelRef = { provider?: string; id?: string } | string | undefined | null;

export function providerFrom(model: LocalModelRef): string {
	if (!model) return "";
	if (typeof model === "string") {
		const slash = model.indexOf("/");
		return (slash >= 0 ? model.slice(0, slash) : model).trim().toLowerCase();
	}
	const provider = model.provider?.trim().toLowerCase();
	if (provider) return provider;
	const id = model.id?.trim();
	if (!id) return "";
	const slash = id.indexOf("/");
	return (slash >= 0 ? id.slice(0, slash) : id).toLowerCase();
}

export function isLocalModel(model: LocalModelRef): boolean {
	const provider = providerFrom(model);
	if (!provider) return false;
	if (LOCAL_PROVIDERS.has(provider)) return true;
	return provider.startsWith("local-qwen");
}

export function estimateTokensFromText(text: string): number {
	const compact = text.replace(/\s+/g, " ").trim();
	if (!compact) return 0;
	return Math.max(1, Math.round(compact.length / 4));
}

export function pickTokenCount(usageOutput: number | undefined, estimated: number): number {
	if (typeof usageOutput === "number" && usageOutput > 0) return usageOutput;
	return Math.max(0, estimated);
}

export function speedFrom(tokens: number, elapsedMs: number, minMs = TG_MIN_MS): number | undefined {
	if (tokens < 1 || elapsedMs < minMs) return undefined;
	const tps = (tokens * 1000) / elapsedMs;
	if (!Number.isFinite(tps) || tps < 0) return undefined;
	return tps;
}

export function formatTg(tps: number): string {
	if (!Number.isFinite(tps) || tps < 0) return "";
	if (tps < 100) return `~tg ${tps.toFixed(1)}/s`;
	return `~tg ${Math.round(tps)}/s`;
}

/** Current assistant message plus completed streamed messages (tokens/ms from first to last generated delta). */
export type TgMeter = {
	t0?: number;
	last?: number;
	estimated: number;
	usage?: number;
	tokens: number;
	ms: number;
};

export function createTgMeter(): TgMeter {
	return { estimated: 0, tokens: 0, ms: 0 };
}

function messageWindow(meter: TgMeter): { tokens: number; ms: number } {
	const ms = meter.t0 === undefined ? 0 : Math.max(0, (meter.last ?? meter.t0) - meter.t0);
	// Too-short windows (e.g. a tool call delivered in one chunk) cannot be timed.
	return ms < TG_MIN_MS ? { tokens: 0, ms: 0 } : { tokens: pickTokenCount(meter.usage, meter.estimated), ms };
}

function foldMessage(meter: TgMeter): void {
	const window = messageWindow(meter);
	meter.tokens += window.tokens;
	meter.ms += window.ms;
	meter.t0 = undefined;
	meter.last = undefined;
	meter.estimated = 0;
	meter.usage = undefined;
}

function usageOutputValue(value: unknown): number | undefined {
	if (!value || typeof value !== "object") return undefined;
	const n = (value as { output?: unknown }).output;
	return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function assistantRole(message: unknown): boolean {
	return Boolean(message && typeof message === "object" && (message as { role?: unknown }).role === "assistant");
}

const GENERATED_DELTAS = new Set(["thinking_delta", "text_delta", "toolcall_delta"]);

export function applyTgEvent(meter: TgMeter, event: unknown, now = Date.now()): boolean {
	if (!event || typeof event !== "object") return false;
	const rec = event as {
		type?: unknown;
		message?: unknown;
		usage?: unknown;
		assistantMessageEvent?: { type?: unknown; delta?: unknown };
	};
	if (rec.type === "message_start") {
		if (rec.message && !assistantRole(rec.message)) return false;
		const had = meter.t0 !== undefined || meter.estimated > 0 || meter.usage !== undefined;
		foldMessage(meter);
		return had;
	}
	let changed = false;
	const ev = rec.assistantMessageEvent;
	if (
		rec.type === "message_update" &&
		GENERATED_DELTAS.has(ev?.type as string) &&
		typeof ev?.delta === "string" &&
		ev.delta.length > 0
	) {
		meter.t0 ??= now;
		meter.last = now;
		meter.estimated += estimateTokensFromText(ev.delta);
		changed = true;
	}
	const usage =
		usageOutputValue(rec.usage) ??
		usageOutputValue(
			rec.message && typeof rec.message === "object" ? (rec.message as { usage?: unknown }).usage : undefined,
		);
	if (usage !== undefined && usage > 0 && usage !== meter.usage) {
		meter.usage = usage;
		if (meter.t0 !== undefined) meter.last = now;
		changed = true;
	}
	// Close the window at message end so tool execution does not dilute the live rate.
	if (rec.type === "message_end" && assistantRole(rec.message) && meter.t0 !== undefined) {
		foldMessage(meter);
		changed = true;
	}
	return changed;
}

/** Live rate of the current assistant message. */
export function tgLabel(meter: TgMeter, now = Date.now()): string | undefined {
	if (meter.t0 === undefined) return undefined;
	const tps = speedFrom(pickTokenCount(meter.usage, meter.estimated), now - meter.t0);
	return tps === undefined ? undefined : formatTg(tps) || undefined;
}

/** Frozen average over every streamed assistant message, for finished runs. */
export function averageTg(meter: TgMeter): number | undefined {
	const current = messageWindow(meter);
	return speedFrom(meter.tokens + current.tokens, meter.ms + current.ms);
}

export function averageTgLabel(meter: TgMeter): string | undefined {
	const tps = averageTg(meter);
	return tps === undefined ? undefined : formatTg(tps) || undefined;
}
