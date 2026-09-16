import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import delegate from "../../delegate/index.ts";
import { capabilityContent, describeCapabilities } from "../../delegate/capabilities.ts";
import { describeOutcome, outcomeContent } from "../../delegate/outcomes.ts";
import type { RunChildInput } from "../../delegate/spawn.ts";
import type { ChildResult } from "../../child-runtime/spawn.ts";

/** Real factory, overlays, archive and renderer. Mock workers; no model requests. */
export async function capabilitiesProbe(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
	assert.equal(getAgentDir(), join(ctx.cwd, "agent")); assert.equal(process.env.HOME, ctx.cwd);
	const configPath = join(getAgentDir(), "delegate.json"), previous = process.env.PI_DELEGATE_SKIP_USER_CONFIG;
	assert.equal(existsSync(configPath), false, "fixture owns a fresh isolated agent directory");
	const shipped = ["read", "grep", "find", "ls", "bash"];
	const theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	try {
		for (const [index, overlay] of [undefined, ["read"], ["read, bash, BASH", "unknown"]].entries()) {
			if (overlay) { writeFileSync(configPath, JSON.stringify({ agents: { recon: { tools: overlay } } }), { flag: "wx", mode: 0o600 }); process.env.PI_DELEGATE_SKIP_USER_CONFIG = "0"; }
			else process.env.PI_DELEGATE_SKIP_USER_CONFIG = "1";
			const tools = overlay ?? shipped, expected = describeCapabilities(tools);
			let tool: any, seq = 0;
			const handlers = new Map<string, Function>();
			const runs: Array<{ input: RunChildInput; resolve: (result: ChildResult) => void }> = [];
			delegate({ ...pi, registerTool: (next: any) => { tool = next; }, registerCommand() {}, registerMessageRenderer() {},
				on: (event: string, handler: Function) => handlers.set(event, handler), appendEntry() {}, sendMessage() {},
			} as unknown as ExtensionAPI, input => new Promise(resolve => {
				runs.push({ input, resolve });
				input.signal?.addEventListener("abort", () => resolve({ text: "Cancelled", exitCode: 1, stopReason: "aborted", stderrTail: "" }), { once: true });
			}));
			const testCtx: any = { ...ctx, hasUI: false, sessionManager: { getSessionId: () => `capabilities-${index}`, getSessionFile: () => undefined, getBranch: () => [] } };
			const call = (params: object, onUpdate?: (result: any) => void) => tool.execute(`cap-${index}-${++seq}`, params, undefined, onUpdate, testCtx);
			const check = (result: any) => {
				assert.deepEqual(result.details.capabilities, expected);
				assert.deepEqual(result.content.slice(1), [...capabilityContent(expected), ...outcomeContent(result.details.outcome)]);
				assert.ok(Buffer.byteLength(result.content[1].text) <= 512);
				assert.equal(result.details.outcome.taskAssessment, "not-performed");
				assert.ok(result.content.slice(1).every((part: any) => Buffer.byteLength(part.text) <= 512));
			};
			await handlers.get("session_start")?.({}, testCtx);
			try {
				const accepted = await call({ kind: "recon", model: "hosted/mock", task: "Offline capability fixture", background: true }, update => {
					if (update.details.capabilities) update.details.capabilities.tools.length = 0;
					throw new Error("Owned observer failure");
				});
				check(accepted); assert.equal(accepted.details.status, "running");
				assert.deepEqual(runs[0].input.tools, tools); assert.equal(runs[0].input.model, "hosted/mock");
				accepted.details.capabilities.tools.length = 0;
				check(await call({ jobId: accepted.details.jobId, timeoutMs: 0 }));
				runs[0].resolve({ text: "Evidence report.", model: "hosted/observed", exitCode: 0, stderrTail: "",
					evidence: { source: "rpc", taskSent: true, agentSettled: true, finalizedMessages: 2, retainedResponses: 1,
						omittedPhases: 0, unansweredWrap: false, openResponse: false, partialResponseRetained: false } });
				const done = await call({ jobId: accepted.details.jobId }); check(done);
				assert.equal(done.details.model, "hosted/observed"); assert.equal(done.details.answer, "Evidence report.");
				const metadata = JSON.parse(readFileSync(join(dirname(done.details.sessionFile), "metadata.json"), "utf8"));
				assert.deepEqual(metadata.capabilities, expected); assert.deepEqual(metadata.tools, tools);
				assert.deepEqual(metadata.outcome, done.details.outcome); assert.equal(done.details.outcome.responses, "observed");
				assert.doesNotMatch(done.content[0].text, /Worker execution:|Configured capabilities only/);
				for (const result of [done, { ...done, details: { ...done.details, status: undefined, answer: undefined } }]) {
					for (const width of [24, 80]) {
						const lines = tool.renderResult(result, { expanded: true, isPartial: false }, theme,
							{ toolCallId: "preview", state: {}, invalidate() {} }).render(width);
						assert.ok(lines.every((line: string) => visibleWidth(line) <= width));
						if (width === 80) { const text = lines.join("\n"); assert.equal(text.match(/Configured capabilities only/g)?.length, 1); assert.match(text, /No filesystem sandbox/); assert.equal(text.match(/Task correctness: not assessed by delegate/g)?.length, 1); }
					}
				}
				const failedOutcome = describeOutcome({ status: "failed", stopReason: "error" });
				const error = { details: { ok: false, capabilities: expected, outcome: failedOutcome },
					content: [{ type: "text", text: "Failure reason." }, ...capabilityContent(expected), ...outcomeContent(failedOutcome)] };
				for (const width of [24, 80]) {
					const text = tool.renderResult(error, { expanded: false, isPartial: false }, theme,
						{ toolCallId: "error-preview", state: {}, invalidate() {} }).render(width).join("\n");
					assert.match(text, /Failure reason/); assert.doesNotMatch(text, /Configured capabilities|Shell tools|filesystem sandbox|Worker execution:|Response lifecycle:/);
				}
				// A subsequent default-model launch keeps the same configured tools after all observer/result mutations.
				const foreground = call({ kind: "recon", task: "Default-model fixture", timeoutMs: 1000 });
				assert.deepEqual(runs[1].input.tools, tools);
				runs[1].resolve({ text: "Default evidence.", exitCode: 0, stderrTail: "" }); check(await foreground);
				assert.equal(runs.length, 2);
			} finally { await handlers.get("session_shutdown")?.(); if (overlay) unlinkSync(configPath); }
		}
	} finally { if (previous === undefined) delete process.env.PI_DELEGATE_SKIP_USER_CONFIG; else process.env.PI_DELEGATE_SKIP_USER_CONFIG = previous; }
	return { configuredOnly: true, overlays: true, overridesKeepTools: true, detached: true, archived: true, rendered: true, noModelCalls: true };
}
