import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compileResponseSchema, readResponseFormat, RESPONSE_FORMAT_ENV, RESPONSE_FORMAT_READY, responseFormatError } from "./response-schema.ts";
import { extractAssistantText, type AssistantSnapshot } from "./spawn.ts";

/** Private child extension: format-only continuations, never a rerun of the task. */
export default function responseGuard(pi: ExtensionAPI): void {
	const startup = JSON.parse(process.env[RESPONSE_FORMAT_ENV] ?? "null");
	if (!startup || typeof startup.path !== "string" || typeof startup.nonce !== "string") throw new Error("Missing response format startup policy.");
	const policy = readResponseFormat(startup.path);
	const validate = compileResponseSchema(policy.schema);
	let latest: AssistantSnapshot = { assistant: false, text: "" };
	let repairs = 0;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "rpc") throw new Error("Response validation requires an RPC child.");
		ctx.ui.notify(JSON.stringify({ type: RESPONSE_FORMAT_READY, version: 1, nonce: startup.nonce }), "info");
	});
	pi.on("message_end", event => {
		const response = extractAssistantText(event);
		if (response.assistant) latest = response;
	});
	pi.on("tool_call", () => {
		if (repairs) return { block: true, terminate: true, reason: "Tools are disabled during response-format repair. Return corrected JSON only." };
	});
	pi.on("agent_before_settle", (event, ctx) => {
		if (ctx.signal?.aborted || ["error", "aborted", "length"].includes(latest.stopReason ?? "")) return;
		const error = responseFormatError(latest.text, validate, policy.maxOutputBytes);
		if (!error || repairs >= policy.repairAttempts) return;
		repairs++;
		pi.setActiveTools([]);
		return {
			entries: [...event.entries, {
				type: "custom_message" as const,
				customType: "delegate-response-repair",
				content: `Response format validation failed (repair ${repairs}/${policy.repairAttempts}):\n${error}\n\nReturn only the corrected JSON matching the configured schema. Use the existing results; do not repeat the task or invent facts. Tools are disabled.`,
				display: false,
			}],
			continue: true,
		};
	});
}
