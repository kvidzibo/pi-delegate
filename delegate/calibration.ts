import { createHash } from "node:crypto";
import { openSync, readSync, closeSync, fstatSync, constants } from "node:fs";
import type { Tokens } from "./usage.ts";

export type Rates = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type Pricing = Rates & { tiers?: Array<Rates & { inputTokensAbove: number }> };
export type Alternative = { model: string; thinking: string };
export type CalibrationKey = {
	localModel: string; alternativeModel: string; kind: string; localThinking: string; alternativeThinking: string;
	tools: string[]; promptHash: string;
};
export type CalibrationProfile = {
	version: 1; id: string; createdAt: string; key: CalibrationKey; suiteHash: string;
	pairs: number; acceptedPairs: number; localFailures: number; alternativeFailures: number; incompletePairs: number;
	promptRatio: number; outputRatio: number; cacheReadShare: number; cacheWriteShare: number;
	totalRatioRange: [number, number];
};
export type SavingsSnapshot = { version: 1; profile: CalibrationProfile; pricing: Pricing; pricedAt: string };
export type EstimatedUsage = { usd: number; requests: number; unpriced: number };
export type CalibrationSample = { taskId: string; repeat: number; local: SampleArm; alternative: SampleArm };
export type SampleArm = { passed: boolean; complete: boolean; tokens: Tokens };

const obj = (x: unknown): Record<string, any> => x !== null && typeof x === "object" && !Array.isArray(x) ? x as Record<string, any> : {};
const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;
const count = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
const text = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 512 && !/[\x00-\x1f\x7f]/.test(x);
const hash = (x: unknown): x is string => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
export const fingerprint = (text: string): string => createHash("sha256").update(text).digest("hex");
export const keyId = (key: CalibrationKey): string => fingerprint(JSON.stringify([
	key.localModel, key.alternativeModel, key.kind, key.localThinking, key.alternativeThinking, [...key.tools].sort(), key.promptHash,
]));

export function validPricing(value: unknown): value is Pricing {
	const p = obj(value);
	const rates = (v: Record<string, any>) => [v.input, v.output, v.cacheRead, v.cacheWrite].every(finite) && v.input > 0 && v.output > 0;
	return rates(p) && (p.tiers === undefined || (Array.isArray(p.tiers) && p.tiers.length <= 32 && p.tiers.every((t: unknown) => {
		const tier = obj(t); return finite(tier.inputTokensAbove) && rates(tier);
	})));
}
/** Clone only public pricing metadata; never credentials or provider configuration. Zero placeholders are unknown. */
export function snapshotPricing(value: unknown): Pricing | undefined {
	if (!validPricing(value)) return undefined;
	const rates = (p: Rates): Rates => ({ input: p.input, output: p.output, cacheRead: p.cacheRead, cacheWrite: p.cacheWrite });
	return { ...rates(value), ...(value.tiers ? { tiers: value.tiers.map(t => ({ ...rates(t), inputTokensAbove: t.inputTokensAbove })) } : {}) };
}
export function priceTokens(tokens: Pick<Tokens, "input" | "output" | "cacheRead" | "cacheWrite">, pricing: Pricing): number {
	const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite;
	let rates: Rates = pricing, threshold = -1;
	for (const tier of pricing.tiers ?? []) if (prompt > tier.inputTokensAbove && tier.inputTokensAbove > threshold) {
		rates = tier; threshold = tier.inputTokensAbove;
	}
	return (tokens.input * rates.input + tokens.output * rates.output + tokens.cacheRead * rates.cacheRead + tokens.cacheWrite * rates.cacheWrite) / 1_000_000;
}

export function validProfile(value: unknown): value is CalibrationProfile {
	const p = obj(value), k = obj(p.key);
	if (p.version !== 1 || !hash(p.id) || !hash(p.suiteHash) || !text(p.createdAt) || !Number.isFinite(Date.parse(p.createdAt))) return false;
	if (![k.localModel, k.alternativeModel, k.kind, k.localThinking, k.alternativeThinking].every(text) || !hash(k.promptHash)
		|| !Array.isArray(k.tools) || k.tools.length === 0 || !k.tools.every(text) || new Set(k.tools).size !== k.tools.length) return false;
	if (![p.pairs, p.acceptedPairs, p.localFailures, p.alternativeFailures, p.incompletePairs].every(count)
		|| p.acceptedPairs < 4 || p.acceptedPairs > p.pairs || [p.localFailures, p.alternativeFailures, p.incompletePairs].some(n => n > p.pairs)) return false;
	if (![p.promptRatio, p.outputRatio].every(n => finite(n) && n > 0 && n <= 1000)
		|| ![p.cacheReadShare, p.cacheWriteShare].every(finite) || p.cacheReadShare + p.cacheWriteShare > 1) return false;
	return Array.isArray(p.totalRatioRange) && p.totalRatioRange.length === 2 && p.totalRatioRange.every(n => finite(n) && n > 0)
		&& p.totalRatioRange[0] <= p.totalRatioRange[1] && keyId(k as CalibrationKey) === p.id;
}
export function validSnapshot(value: unknown): value is SavingsSnapshot {
	const s = obj(value);
	return s.version === 1 && validProfile(s.profile) && validPricing(s.pricing) && text(s.pricedAt) && Number.isFinite(Date.parse(s.pricedAt));
}
export function validEstimate(value: unknown): value is EstimatedUsage {
	const e = obj(value); return finite(e.usd) && count(e.requests) && count(e.unpriced);
}

/** Successful-pair fit, not a success-adjusted economic claim. Failed and incomplete pairs remain in diagnostics. */
export function fitCalibration(key: CalibrationKey, suiteHash: string, samples: CalibrationSample[], now = new Date()): CalibrationProfile {
	if (new Set(samples.map(s => `${s.taskId}:${s.repeat}`)).size !== samples.length) throw new Error("Duplicate calibration pair");
	const validTokens = (t: Tokens) => [t.input, t.output, t.cacheRead, t.cacheWrite, t.total].every(count)
		&& t.total === t.input + t.output + t.cacheRead + t.cacheWrite && t.total > 0;
	const accepted = samples.filter(s => s.local.passed && s.alternative.passed && s.local.complete && s.alternative.complete
		&& validTokens(s.local.tokens) && validTokens(s.alternative.tokens));
	if (accepted.length < 4 || new Set(accepted.map(s => s.taskId)).size < 4) throw new Error("Calibration needs at least four distinct mutually successful, fully recorded tasks");
	const sum = (arm: "local" | "alternative", bucket: keyof Tokens) => accepted.reduce((n, s) => n + s[arm].tokens[bucket], 0);
	const prompt = (arm: "local" | "alternative") => sum(arm, "input") + sum(arm, "cacheRead") + sum(arm, "cacheWrite");
	const ratios = accepted.map(s => s.alternative.tokens.total / s.local.tokens.total);
	const profile: CalibrationProfile = {
		version: 1, id: keyId(key), createdAt: now.toISOString(), key: structuredClone(key), suiteHash,
		pairs: samples.length, acceptedPairs: accepted.length,
		localFailures: samples.filter(s => !s.local.passed).length, alternativeFailures: samples.filter(s => !s.alternative.passed).length,
		incompletePairs: samples.filter(s => !s.local.complete || !s.alternative.complete || !validTokens(s.local.tokens) || !validTokens(s.alternative.tokens)).length,
		promptRatio: prompt("alternative") / prompt("local"), outputRatio: sum("alternative", "output") / sum("local", "output"),
		cacheReadShare: sum("alternative", "cacheRead") / prompt("alternative"), cacheWriteShare: sum("alternative", "cacheWrite") / prompt("alternative"),
		totalRatioRange: [Math.min(...ratios), Math.max(...ratios)],
	};
	if (!validProfile(profile)) throw new Error("Invalid calibration totals or profile identity");
	return profile;
}

export function estimateRequest(tokens: Tokens, model: string, snapshot: SavingsSnapshot): number | undefined {
	if (model !== snapshot.profile.key.localModel) return undefined;
	const p = snapshot.profile;
	const prompt = (tokens.input + tokens.cacheRead + tokens.cacheWrite) * p.promptRatio;
	const projected = {
		input: prompt * (1 - p.cacheReadShare - p.cacheWriteShare), output: tokens.output * p.outputRatio,
		cacheRead: prompt * p.cacheReadShare, cacheWrite: prompt * p.cacheWriteShare,
	};
	const usd = priceTokens(projected, snapshot.pricing);
	return finite(usd) ? usd : undefined;
}

export function loadSavingsSnapshot(input: {
	key: CalibrationKey; files: string[]; pricing: unknown; now?: Date;
}): { snapshot?: SavingsSnapshot; reason?: string } {
	const pricing = snapshotPricing(input.pricing);
	if (!pricing) return { reason: "Alternative API prices unavailable (zero/invalid pricing is not free work)" };
	const now = input.now ?? new Date();
	let selected: CalibrationProfile | undefined;
	let invalid = false;
	for (const file of input.files) {
		try {
			const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
			let raw: string;
			try {
				const stat = fstatSync(fd);
				if (!stat.isFile() || stat.size > 256 * 1024) throw new Error("Profile must be a small regular file");
				const buffer = Buffer.alloc(256 * 1024 + 1);
				let length = 0, n: number;
				while (length < buffer.length && (n = readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += n;
				if (length > 256 * 1024) throw new Error("Profile too large");
				raw = buffer.subarray(0, length).toString("utf8");
			} finally { closeSync(fd); }
			const profile: unknown = JSON.parse(raw);
			if (!validProfile(profile)) throw new Error("Invalid profile");
			if (profile.id !== keyId(input.key)) continue;
			const age = now.getTime() - Date.parse(profile.createdAt);
			if (age < 0 || age > 90 * 86400_000) continue;
			if (!selected || profile.createdAt > selected.createdAt) selected = profile;
		} catch { invalid = true; }
	}
	if (!selected) return { reason: invalid ? "No matching calibration; some profile files are unreadable/invalid" : "No matching calibration (model, thinking, tools, prompt or age differs)" };
	return { snapshot: { version: 1, profile: structuredClone(selected), pricing, pricedAt: now.toISOString() } };
}
