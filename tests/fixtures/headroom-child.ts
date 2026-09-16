import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { openAICompletionsApi } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Owned offline child fixture: real built-in serialization/stream parser, entirely mocked HTTP. */
export default function headroomChild(pi: ExtensionAPI) {
	const mode = process.env.PI_HEADROOM_TEST_MODE, log = process.env.PI_HEADROOM_TEST_LOG, file = process.env.PI_HEADROOM_TEST_FILE;
	if (!["clip", "refuse", "compact"].includes(mode!) || !log || !file) throw new Error("Missing isolated headroom fixture inputs.");
	let calls = 0;
	const api = openAICompletionsApi();
	pi.registerProvider("headroom-fixture", {
		api: "openai-completions", baseUrl: "https://headroom.invalid/v1", apiKey: "offline-fixture-key",
		models: [{ id: "offline", name: "Offline fixture", reasoning: false, input: ["text"],
			contextWindow: 32768, maxTokens: mode === "compact" ? 24000 : 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple: (model, context, options) => api.streamSimple(model, context, { ...options,
			fetch: async (_url, init) => {
				const body = JSON.parse(String(init?.body));
				appendFileSync(log, `${JSON.stringify(body)}\n`); calls++;
				if (calls > 4) throw new Error("Fixture exceeded bounded mock requests.");
				// Let the parent process correlated closure and steering before the next synthetic reply.
				await delay(40);
				const first = calls === 1;
				const delta = first ? { role: "assistant", content: "Initial findings." + (mode === "compact" ? " Evidence".repeat(11000) : ""), tool_calls: [{ index: 0, id: "read1", type: "function",
					function: { name: "read", arguments: JSON.stringify({ path: file }) } }] }
					: { role: "assistant", content: "Final evidence report." };
				const chunk = (delta: object, finish_reason: string | null) => ({ id: `mock-${calls}`, object: "chat.completion.chunk",
					created: 1, model: "offline", choices: [{ index: 0, delta, finish_reason }],
					...(mode === "compact" && finish_reason ? { usage: { prompt_tokens: 1000, completion_tokens: 24000, total_tokens: 25000 } } : {}) });
				const stream = [chunk(delta, null), chunk({}, first ? "tool_calls" : "stop")].map(part => `data: ${JSON.stringify(part)}\n\n`).join("") + "data: [DONE]\n\n";
				return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
			},
		}),
	});
	pi.on("session_before_compact", () => { appendFileSync(`${log}.compaction`, "entered\n"); });
	pi.on("before_provider_request", event => {
		if (mode !== "refuse" || calls === 0) return;
		const body = event.payload as any;
		return { ...body, messages: [...body.messages, { role: "user", content: "Unsafe task data ".repeat(4000) }] };
	});
	pi.on("before_provider_request", () => {
		if (mode === "refuse" && calls > 0) throw new Error("Ordinary fixture hook error must not veto or bypass the last guard.");
	});
}
