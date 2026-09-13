import { mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync } from "node:fs";
import { isAbsolute, join, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runPiChild, type RunPiChildInput, type ChildResult } from "../child-runtime/spawn.ts";
import { isFailedChildResult } from "../child-runtime/policy.ts";
import { buildChildArgs, buildChildEnv } from "../delegate/spawn.ts";
import { emptyTokens, jsonlLines, reportedTokens, addTokens } from "../delegate/usage.ts";
import { fingerprint, fitCalibration, snapshotPricing, priceTokens, type CalibrationKey, type CalibrationSample, type Pricing } from "../delegate/calibration.ts";
import { Budget, requestReservation, validBudgetState, type BudgetConfig } from "./budget.ts";
import { fixtureFiles, fixtureTasks, suiteHash, taskPrompt, scoreAnswer } from "./fixtures.ts";

export type BenchModel = { id: string; contextWindow: number; maxTokens: number; pricing?: Pricing };
export type BenchOptions = {
	out: string; budgetUsd: number; repeats: number; maxRequests: number; timeoutMs: number;
	key: CalibrationKey; local: BenchModel; alternative: BenchModel; promptPath: string; guardPath: string;
	env: NodeJS.Dict<string>; signal?: AbortSignal; onProgress?: (text: string) => void;
};
const save = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
function unchanged(dir: string): boolean {
	const actual: Record<string, string> = {};
	const visit = (relative: string) => {
		for (const file of readdirSync(join(dir, relative))) {
			const name = relative ? `${relative}/${file}` : file, stat = lstatSync(join(dir, name));
			if (stat.isSymbolicLink()) throw new Error("Fixture symlink");
			if (stat.isDirectory()) visit(name);
			else if (stat.isFile() && stat.size <= 1024 * 1024) actual[name] = readFileSync(join(dir, name), "utf8");
			else throw new Error("Unexpected fixture entry");
		}
	};
	try { visit(""); } catch { return false; }
	return Object.keys(actual).length === Object.keys(fixtureFiles).length && Object.entries(fixtureFiles).every(([p, text]) => actual[p] === text);
}

/** Offline extraction: finalized inference only; agent_end/streaming copies are not new requests. */
export async function transcriptUsage(path: string, expectedModel: string, pricing?: Pricing) {
	const tokens = emptyTokens();
	let complete = true, settled = false, requests = 0, apiCostUsd = 0;
	const seen = new Set<string>();
	for await (const line of jsonlLines(path)) {
		if (!line.trim()) continue;
		let e: any; try { e = JSON.parse(line); } catch { complete = false; continue; }
		if (e.type === "agent_settled") settled = true;
		if (e.type === "oversized_event_skipped" || e.type === "compaction_end") complete = false;
		if (e.type !== "message_end" || e.message?.role !== "assistant") continue;
		if (seen.has(line)) continue;
		seen.add(line); requests++;
		const m = e.message, usage = reportedTokens(m.usage);
		if (!usage || `${m.provider}/${m.model}` !== expectedModel) complete = false;
		if (usage) { addTokens(tokens, usage); if (pricing) apiCostUsd += priceTokens(usage, pricing); }
	}
	return { tokens, requests, apiCostUsd, accounted: complete && requests > 0, complete: complete && settled && requests > 0 };
}

export async function runCalibration(options: BenchOptions, execute: (input: RunPiChildInput) => Promise<ChildResult> = runPiChild) {
	if (!isAbsolute(options.out) || !Number.isFinite(options.budgetUsd) || options.budgetUsd <= 0
		|| !Number.isInteger(options.repeats) || options.repeats < 1 || options.repeats > 10
		|| !Number.isInteger(options.maxRequests) || options.maxRequests < 1 || options.maxRequests > 100
		|| !Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 900000) throw new Error("Invalid benchmark options");
	if (options.local.id !== options.key.localModel || options.alternative.id !== options.key.alternativeModel || options.key.kind !== "recon") throw new Error("Benchmark model/key mismatch (initial suite is recon only)");
	const prompt = readFileSync(options.promptPath, "utf8");
	if (fingerprint(prompt) !== options.key.promptHash) throw new Error("Benchmark prompt fingerprint mismatch");
	const pricing = snapshotPricing(options.alternative.pricing);
	if (!pricing) throw new Error("Alternative model needs known API prices");
	const baseBudget: BudgetConfig = { model: options.alternative.id, thinking: options.key.alternativeThinking, tools: options.key.tools, local: false, budgetUsd: options.budgetUsd,
		maxRequests: options.maxRequests, contextWindow: options.alternative.contextWindow, maxTokens: options.alternative.maxTokens, pricing };
	const minimumReservation = requestReservation(baseBudget);
	if (minimumReservation > options.budgetUsd) throw new Error(`Budget must cover at least one conservative request reservation ($${minimumReservation.toFixed(4)})`);
	mkdirSync(options.out, { mode: 0o700 }); // Deliberately refuses an existing directory; never overwrite prior evidence.
	const promptPath = join(options.out, "system-prompt.md"); writeFileSync(promptPath, prompt, { flag: "wx", mode: 0o600 });
	save(join(options.out, "manifest.json"), { version: 1, createdAt: new Date().toISOString(), key: options.key, suiteHash,
		repeats: options.repeats, budgetUsd: options.budgetUsd, maxRequests: options.maxRequests, timeoutMs: options.timeoutMs, pricing,
		note: "API-metadata budget, not a provider billing cap. No automatic server/GPU management. Synthetic recon fixture; no sandbox." });
	const samples: CalibrationSample[] = [];
	let chargedUsd = 0, spendIncomplete = false, stopped: string | undefined;
	try {
		for (let repeat = 1; repeat <= options.repeats; repeat++) {
			for (const [taskIndex, task] of fixtureTasks.entries()) {
				options.signal?.throwIfAborted();
				const pair: Partial<CalibrationSample> = { taskId: task.id, repeat };
				const arms = (taskIndex + repeat) % 2 ? ["local", "alternative"] as const : ["alternative", "local"] as const;
				for (const arm of arms) {
					options.signal?.throwIfAborted();
					const local = arm === "local", model = options[arm];
					if (!local && chargedUsd + minimumReservation > options.budgetUsd) throw new Error("Remaining budget cannot reserve another hosted request");
					const prefix = `${task.id}-r${repeat}-${arm}`, dir = join(options.out, prefix);
					mkdirSync(dir, { mode: 0o700 });
					for (const [file, content] of Object.entries(fixtureFiles)) {
						const target = join(dir, file); mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); writeFileSync(target, content, { mode: 0o600 });
					}
					const config: BudgetConfig = { ...baseBudget, model: model.id, thinking: local ? options.key.localThinking : options.key.alternativeThinking, local, budgetUsd: local ? 0 : options.budgetUsd - chargedUsd,
						contextWindow: model.contextWindow, maxTokens: model.maxTokens };
					new Budget(config); // Validate local limits too, before spawning.
					const budgetPath = join(options.out, `${prefix}.budget.json`); save(budgetPath, config);
					const eventsPath = join(options.out, `${prefix}.jsonl`); writeFileSync(eventsPath, "", { flag: "wx", mode: 0o600 });
					let recordingError = false;
					const recordingAbort = new AbortController();
					const runSignal = options.signal ? AbortSignal.any([options.signal, recordingAbort.signal]) : recordingAbort.signal;
					if (!local) spendIncomplete = true;
					try { options.onProgress?.(`${task.id} r${repeat}: ${arm}`); } catch { /* UI observer only */ }
					const result = await execute({ cwd: dir, model: model.id, task: taskPrompt(task), hardTimeoutMs: options.timeoutMs,
						maxOutputBytes: 65536, promptSourcePath: promptPath, signal: runSignal,
						env: buildChildEnv({ ...options.env, PI_DELEGATE_LOG: "0", PI_DELEGATE_BENCH_BUDGET: budgetPath }),
						buildArgs: (p) => [...buildChildArgs({ model: model.id, thinking: local ? options.key.localThinking : options.key.alternativeThinking,
							tools: options.key.tools, promptPath: p, sessionFile: join(options.out, `${prefix}.session.jsonl`), offline: local }), "-e", options.guardPath],
						beforePrompt: async (signal) => {
							const deadline = Date.now() + 15000;
							while (true) {
								signal.throwIfAborted();
								try {
									const state = JSON.parse(readFileSync(`${budgetPath}.state`, "utf8"));
									if (state.requests === 0 && state.pending === false && state.spentUsd === 0 && state.reservedUsd === 0 && !state.stopped) return;
								} catch { /* Guard has not started yet. */ }
								if (Date.now() >= deadline) throw new Error("Budget guard did not acknowledge startup; no task sent");
								await delay(25, undefined, { signal });
							}
						},
						onEvent: event => {
							try { writeFileSync(eventsPath, JSON.stringify(event) + "\n", { flag: "a", mode: 0o600 }); }
							catch { recordingError = true; recordingAbort.abort(); }
						},
					});
					const state: unknown = JSON.parse(readFileSync(`${budgetPath}.state`, "utf8"));
					if (!validBudgetState(state, config.maxRequests)) throw new Error("Invalid budget receipt; spend unknown, stopped");
					const usage = await transcriptUsage(eventsPath, model.id, local ? undefined : pricing);
					const reconciled = !state.pending && usage.accounted && state.requests === usage.requests
						&& Math.abs(state.spentUsd - usage.apiCostUsd) <= 1e-9;
					if (!local) { chargedUsd += state.spentUsd + state.reservedUsd; spendIncomplete = !reconciled; }
					const sample = { passed: !isFailedChildResult(result) && scoreAnswer(task, result.text) && unchanged(dir),
						complete: usage.complete && !recordingError && !state.pending && !state.stopped && state.requests === usage.requests, tokens: usage.tokens };
					pair[arm] = sample;
					save(join(options.out, `${prefix}.result.json`), { ...sample, taskId: task.id, repeat, model: model.id, answer: result.text,
						stopReason: result.stopReason, exitCode: result.exitCode, budget: state, stderr: result.stderrTail });
					if (state.pending || state.stopped || !reconciled || recordingError || chargedUsd > options.budgetUsd) throw new Error(state.stopped ?? "Unresolved receipt/usage/recording or budget exhausted; stopped");
					options.signal?.throwIfAborted();
				}
				samples.push(pair as CalibrationSample);
			}
		}
		options.signal?.throwIfAborted();
	} catch (error) { stopped = error instanceof Error ? error.message : String(error); }
	// Interrupted/unpaired arms remain in their result/log files; do not publish a partial campaign as a fresh calibration.
	let profile;
	if (!stopped) {
		try { profile = fitCalibration(options.key, suiteHash, samples); save(join(options.out, "calibration.json"), profile); }
		catch (error) { stopped = error instanceof Error ? error.message : String(error); }
	}
	const summary = { version: 1, pairs: samples, chargedUsd, spendIncomplete, stopped, profile: profile ? "calibration.json" : undefined };
	save(join(options.out, "summary.json"), summary);
	return summary;
}
