import assert from "node:assert/strict";
import { test } from "node:test";
import serviceTierExtension from "../service-tier.ts";
import { SPEED_ENV, supportedSpeeds } from "../speed.ts";

function handler(speed: string | undefined) {
	const previous = process.env[SPEED_ENV];
	if (speed === undefined) delete process.env[SPEED_ENV]; else process.env[SPEED_ENV] = speed;
	try {
		let request: Function | undefined;
		serviceTierExtension({ on: (name: string, fn: Function) => { if (name === "before_provider_request") request = fn; } } as any);
		return request!;
	} finally {
		if (previous === undefined) delete process.env[SPEED_ENV]; else process.env[SPEED_ENV] = previous;
	}
}

const ctx = (provider: string, id: string, oauth = true) => ({ model: { provider, id }, modelRegistry: { isUsingOAuth: () => oauth } });

test("child requests the Codex tier only for its own eligible ChatGPT-authenticated model", () => {
	assert.throws(() => handler(undefined), /Missing delegate speed policy/);
	assert.throws(() => handler("priority"), /Missing delegate speed policy/);
	const fast = handler("fast");
	const payload = { model: "gpt-6.1-terra", input: [] };
	assert.deepEqual(fast({ payload }, ctx("openai-codex", "gpt-6.1-terra")), { ...payload, service_tier: "priority" });
	assert.equal("service_tier" in payload, false, "payload is replaced, not mutated");
	assert.equal(fast({ payload }, ctx("openai-codex", "gpt-6.1-terra", false)), undefined, "API-key billing is unchanged");
	assert.equal(fast({ payload }, ctx("openai", "gpt-6.1-terra")), undefined);
	assert.equal(fast({ payload: { ...payload, model: "other" } }, ctx("openai-codex", "gpt-6.1-terra")), undefined);
	assert.equal(fast({ payload: { model: "codex-auto-review" } }, ctx("openai-codex", "codex-auto-review")), undefined);
	assert.equal(fast({ payload: [] }, ctx("openai-codex", "gpt-6.1-terra")), undefined);
	const ultra = handler("ultrafast");
	assert.equal(ultra({ payload: { model: "gpt-6.2-sol" } }, ctx("openai-codex", "gpt-6.2-sol")).service_tier, "ultrafast");
	assert.equal(ultra({ payload }, ctx("openai-codex", "gpt-6.1-terra")), undefined, "Terra has no Ultrafast tier");
	assert.equal(handler("standard")({ payload }, ctx("openai-codex", "gpt-6.1-terra")), undefined);
});

test("supported speeds follow the documented Codex model tiers", () => {
	assert.deepEqual(supportedSpeeds("openai-codex/gpt-6.2-astra"), ["standard", "fast", "ultrafast"]);
	assert.deepEqual(supportedSpeeds("openai-codex/gpt-6-luna"), ["standard", "fast"]);
	assert.deepEqual(supportedSpeeds("openai/gpt-6-luna"), ["standard"]);
	assert.deepEqual(supportedSpeeds("local-qwen38/qwen38-q4km"), ["standard"]);
});
