import { priceTokens, validPricing, type Pricing } from "../delegate/calibration.ts";
import { reportedTokens } from "../delegate/usage.ts";

export type BudgetConfig = { model: string; thinking: string; tools: string[]; local: boolean; budgetUsd: number; maxRequests: number; contextWindow: number; maxTokens: number; pricing?: Pricing };
export type BudgetState = { spentUsd: number; reservedUsd: number; requests: number; pending: boolean; stopped?: string };
export function validBudgetState(value: unknown, maxRequests: number): value is BudgetState {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const s = value as BudgetState;
	return [s.spentUsd, s.reservedUsd].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)
		&& Number.isSafeInteger(s.requests) && s.requests >= 0 && s.requests <= maxRequests && typeof s.pending === "boolean"
		&& (s.pending ? s.requests > 0 : s.reservedUsd === 0)
		&& (s.stopped === undefined || (typeof s.stopped === "string" && s.stopped.length > 0));
}
export function requestReservation(config: BudgetConfig): number {
	if (!Number.isFinite(config.budgetUsd) || config.budgetUsd < 0 || !Number.isSafeInteger(config.maxRequests) || config.maxRequests < 1
		|| !Number.isSafeInteger(config.contextWindow) || config.contextWindow < 1 || !Number.isSafeInteger(config.maxTokens) || config.maxTokens < 1) throw new Error("Invalid benchmark budget limits");
	if (config.local) return 0;
	if (!validPricing(config.pricing)) throw new Error("Known positive API pricing is required for hosted benchmarks");
	const rates = [config.pricing, ...(config.pricing.tiers ?? [])];
	return (config.contextWindow * Math.max(...rates.flatMap(r => [r.input, r.cacheRead, r.cacheWrite])) + config.maxTokens * Math.max(...rates.map(r => r.output))) / 1_000_000;
}
/** Reserve a metadata-based worst case BEFORE every request. Missing usage retains the reservation. */
export class Budget {
	readonly config: BudgetConfig;
	readonly state: BudgetState = { spentUsd: 0, reservedUsd: 0, requests: 0, pending: false };
	readonly reservation: number;
	constructor(config: BudgetConfig) { this.config = config; this.reservation = requestReservation(config); }
	approve(model: string): void {
		if (model !== this.config.model) throw new Error("Benchmark model changed");
		if (this.state.pending) throw new Error("Previous request usage is unresolved; no further requests allowed");
		if (this.state.requests >= this.config.maxRequests) throw new Error("Benchmark request limit reached");
		if (this.state.spentUsd + this.reservation > this.config.budgetUsd) throw new Error("Insufficient remaining budget to reserve the next request");
		this.state.reservedUsd = this.reservation; this.state.pending = true; this.state.requests++;
	}
	settle(usage: unknown): void {
		if (!this.state.pending) return;
		const tokens = reportedTokens(usage);
		if (!tokens) throw new Error("Missing benchmark request usage; reservation retained");
		const cost = this.config.local ? 0 : priceTokens(tokens, this.config.pricing!);
		if (!Number.isFinite(cost)) throw new Error("Invalid request cost");
		this.state.spentUsd += cost; this.state.reservedUsd = 0; this.state.pending = false;
		if (cost > this.reservation + 1e-9) throw new Error("Provider usage exceeded the metadata-based reservation; benchmark stopped");
	}
}
