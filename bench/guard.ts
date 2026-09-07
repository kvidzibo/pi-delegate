import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { Budget, type BudgetConfig } from "./budget.ts";
import { snapshotPricing } from "../delegate/calibration.ts";

/** Only explicitly loaded in dedicated benchmark children, never in the normal extension. */
export default function guard(pi: ExtensionAPI) {
	const configPath = process.env.PI_DELEGATE_BENCH_BUDGET;
	if (!configPath) throw new Error("Benchmark guard requires a budget file");
	const budget = new Budget(JSON.parse(readFileSync(configPath, "utf8")) as BudgetConfig);
	const statePath = `${configPath}.state`;
	const persist = () => {
		writeFileSync(`${statePath}.tmp`, JSON.stringify(budget.state), { mode: 0o600 });
		renameSync(`${statePath}.tmp`, statePath);
	};
	const stop = (error: unknown): never => {
		budget.state.stopped = error instanceof Error ? error.message : String(error);
		try { persist(); } catch { /* Parent treats absent state as unknown spend and stops. */ }
		process.stderr.write(`Benchmark guard: ${budget.state.stopped}\n`);
		// Pi catches extension hook exceptions and continues. Exit this dedicated child instead,
		// synchronously before the provider request can leave the process (fail closed).
		process.exit(2);
	};
	pi.on("session_start", () => { try { persist(); } catch (e) { stop(e); } });
	pi.on("before_provider_request", (_event, ctx) => {
		try {
			if (ctx.thinkingLevel !== budget.config.thinking || JSON.stringify([...pi.getActiveTools()].sort()) !== JSON.stringify([...budget.config.tools].sort())) {
				throw new Error("Benchmark thinking/tools differ from the requested calibration profile");
			}
			if (!ctx.model || !Number.isSafeInteger(ctx.model.contextWindow) || !Number.isSafeInteger(ctx.model.maxTokens)
				|| ctx.model.contextWindow > budget.config.contextWindow || ctx.model.maxTokens > budget.config.maxTokens
				|| (!budget.config.local && JSON.stringify(snapshotPricing(ctx.model.cost)) !== JSON.stringify(budget.config.pricing))) {
				throw new Error("Benchmark model limits/prices differ from the budget snapshot");
			}
			budget.approve(`${ctx.model.provider}/${ctx.model.id}`); persist();
		}
		catch (e) { stop(e); }
	});
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		try { budget.settle(event.message.usage); persist(); } catch (e) { stop(e); }
	});
	pi.on("session_before_compact", () => ({ cancel: true }));
}
