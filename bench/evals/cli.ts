import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planHistoricalEval, runHistoricalEval, type HistoricalEvalOptions } from "./runner.ts";

// Only this explicit developer entrypoint can launch a campaign; imports do not run models.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const [mode, path, ...extra] = process.argv.slice(2);
		if (!["--plan", "--run"].includes(mode) || !path || extra.length) throw new Error("Usage: npm run eval:historical -- --plan|--run /absolute/config.json");
		const config = JSON.parse(readFileSync(path, "utf8")) as Omit<HistoricalEvalOptions, "env" | "signal">;
		const abort = new AbortController(), interrupt = () => abort.abort(new Error("Evaluation interrupted"));
		process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
		try {
			const options = { ...config, env: process.env, signal: abort.signal };
			if (mode === "--plan") console.log(JSON.stringify(planHistoricalEval(options), null, 2));
			else {
				const summary = await runHistoricalEval(options);
				console.log(JSON.stringify({ comparisons: summary.comparisons, stopped: summary.stopped, spendIncomplete: summary.spendIncomplete, spentUsd: summary.spentUsd, output: config.out }, null, 2));
				if (summary.stopped) process.exitCode = 1;
			}
		} finally { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); }
	} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
