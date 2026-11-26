export const SPEEDS = ["standard", "fast", "ultrafast"] as const;
export type Speed = typeof SPEEDS[number];
export const SPEED_ENV = "PI_DELEGATE_SPEED";

// OpenAI Codex (ChatGPT sign-in) service tiers. Fast models match the Codex model catalog;
// Ultrafast models follow OpenAI's Ultrafast documentation and require an eligible plan.
const TIERS = { fast: "priority", ultrafast: "ultrafast" } as const;
const MODELS: Record<keyof typeof TIERS, ReadonlySet<string>> = {
	fast: new Set([
		"gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra", "gpt-6-luna",
		"gpt-6-sol", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6.2-astra", "gpt-6.2-sol",
	]),
	ultrafast: new Set(["gpt-6-astra", "gpt-6.1-sol", "gpt-6.2-astra", "gpt-6.2-sol"]),
};

export function isSpeed(value: unknown): value is Speed {
	return SPEEDS.includes(value as Speed);
}

/** Request service tier for a provider model, or undefined for standard/unsupported speeds. */
export function serviceTier(provider: string, id: string, speed: Speed | undefined): string | undefined {
	if (provider !== "openai-codex" || speed === undefined || speed === "standard") return undefined;
	return MODELS[speed].has(id) ? TIERS[speed] : undefined;
}

/** Non-standard speed that applies to a `provider/model` ID; unsupported saved speeds run at standard. */
export function activeSpeed(model: string, speed: Speed | undefined): Exclude<Speed, "standard"> | undefined {
	return speed && speed !== "standard" && supportedSpeeds(model).includes(speed) ? speed : undefined;
}

/** Speeds available for a `provider/model` ID; always includes standard. */
export function supportedSpeeds(model: string): Speed[] {
	const slash = model.indexOf("/");
	return SPEEDS.filter(speed => speed === "standard" || serviceTier(model.slice(0, slash), model.slice(slash + 1), speed));
}
