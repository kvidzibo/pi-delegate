import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSpeed, serviceTier, SPEED_ENV } from "./speed.ts";

/** Private child extension: request the role's Codex service tier on eligible model requests. */
export default function serviceTierExtension(pi: ExtensionAPI): void {
	const speed = process.env[SPEED_ENV];
	if (!isSpeed(speed)) throw new Error("Missing delegate speed policy.");
	pi.on("before_provider_request", (event, ctx) => {
		const payload = event.payload;
		const model = ctx.model;
		if (!payload || typeof payload !== "object" || Array.isArray(payload) || !model) return;
		// Only the child's own model; subscription tiers do not apply to API-key billing.
		if ((payload as { model?: unknown }).model !== model.id || !ctx.modelRegistry.isUsingOAuth(model)) return;
		const tier = serviceTier(model.provider, model.id, speed);
		if (tier) return { ...payload, service_tier: tier };
	});
}
