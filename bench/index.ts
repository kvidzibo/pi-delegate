import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { loadDelegateConfig, THINKING_LEVELS } from "../delegate/config.ts";
import { fingerprint, snapshotPricing } from "../delegate/calibration.ts";
import { isLocalModel } from "../delegate/tg.ts";
import { runCalibration, type BenchModel } from "./runner.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Opt-in runner: pi -e ./bench/index.ts. Not listed in the package's auto-loaded extensions. */
export default function benchmark(pi: ExtensionAPI) {
	let active: AbortController | undefined;
	pi.on("session_shutdown", () => { active?.abort(); });
	pi.registerCommand("delegate-calibrate-cancel", {
		description: "Cancel the manually started comparison benchmark; retain evidence and pending budget reservations.",
		handler: async (_args, ctx) => { active?.abort(); ctx.ui.notify(active ? "Benchmark cancellation requested" : "No benchmark running", "info"); },
	});
	pi.registerCommand("delegate-calibrate", {
		description: 'Run NEW paired recon benchmarks. JSON args require absolute "out" and positive "budgetUsd". Explicitly spends hosted API usage.',
		handler: async (args, ctx) => {
			if (active) { ctx.ui.notify("A benchmark is already running", "warning"); return; }
			if (process.env.PI_DELEGATE_CHILD === "1") { ctx.ui.notify("Cannot benchmark inside a delegate child", "error"); return; }
			const control = new AbortController(); active = control;
			try {
				await ctx.waitForIdle();
				control.signal.throwIfAborted();
				const params = JSON.parse(args || "{}");
				if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("Expected JSON object arguments");
				const config = loadDelegateConfig({ shippedPath: join(root, "delegate/config.json"), userPath: join(getAgentDir(), "delegate.json") });
				const localModel = params.localModel ?? config.agents.recon.model;
				const alternative = config.localAlternatives[localModel];
				const alternativeModel = params.alternativeModel ?? alternative?.model;
				if (typeof localModel !== "string" || typeof alternativeModel !== "string" || !isLocalModel(localModel) || isLocalModel(alternativeModel)) throw new Error("Configure a local model and hosted alternative");
				const localThinking = params.localThinking ?? "low", alternativeThinking = params.alternativeThinking ?? alternative?.thinking ?? "low";
				if (![localThinking, alternativeThinking].every(t => THINKING_LEVELS.includes(t))) throw new Error("Unsupported thinking level");
				const model = (id: string): BenchModel => {
					const slash = id.indexOf("/"), m = ctx.modelRegistry.find(id.slice(0, slash), id.slice(slash + 1));
					if (!m) throw new Error(`Unknown model: ${id}`);
					return { id, contextWindow: m.contextWindow, maxTokens: m.maxTokens, pricing: snapshotPricing(m.cost) };
				};
				const promptPath = join(root, "delegate/prompts/recon.md");
				const summary = await runCalibration({ out: params.out, budgetUsd: params.budgetUsd, repeats: params.repeats ?? 2,
					maxRequests: params.maxRequests ?? 12, timeoutMs: params.timeoutMs ?? 120000,
					key: { localModel, alternativeModel, kind: "recon", localThinking, alternativeThinking,
						tools: config.agents.recon.tools, promptHash: fingerprint(readFileSync(promptPath, "utf8")) },
					local: model(localModel), alternative: model(alternativeModel), promptPath, guardPath: join(root, "bench/guard.ts"),
					env: process.env, signal: control.signal, onProgress: text => ctx.ui.setStatus("delegate-calibration", text),
				});
				ctx.ui.notify(summary.stopped ? `Benchmark stopped: ${summary.stopped}. Evidence: ${params.out}`
					: `Calibration ready: ${params.out}/calibration.json. Add its absolute path to calibrationProfiles and /reload.`, summary.stopped ? "warning" : "info");
			} catch (error) { ctx.ui.notify(`Calibration: ${error instanceof Error ? error.message : String(error)}`, "error"); }
			finally { active = undefined; ctx.ui.setStatus("delegate-calibration", undefined); }
		},
	});
}
