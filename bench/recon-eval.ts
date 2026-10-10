import { mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync } from "node:fs";
import { isAbsolute, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { runPiChild, type RunPiChildInput, type ChildResult } from "../child-runtime/spawn.ts";
import { isFailedChildResult } from "../child-runtime/policy.ts";
import { buildChildArgs, buildChildEnv } from "../delegate/spawn.ts";
import { isLocalModel } from "../delegate/tg.ts";
import { fingerprint } from "../delegate/calibration.ts";
import { Budget, validBudgetState, type BudgetConfig } from "./budget.ts";

const tools = ["read", "grep", "find", "ls", "bash"];
const files: Record<string, string> = {
	"src/cache.js": 'export const cacheTtl = Number(process.env.CACHE_TTL_SECONDS ?? 90);\n',
	"config/runtime.json": '{"workers":6}\n',
	"docs/old-config.md": "Historical configuration (superseded): workers=2\n",
	"evidence/lookup.txt": "Captured shell lookup: PATH=/usr/bin:/bin\n$ command -v modinfo\nexit 1; no stdout\n",
	"evidence/package.txt": "Captured installed package inventory:\nkmod: install ok installed\n/usr/sbin/modinfo\n",
};
export const reconTasks = [
	{ id: "lookup", question: "Inspect src/cache.js. Which environment variable controls cache TTL and what is its default? Cite evidence; do not edit or execute project code.",
		facts: [/CACHE_TTL_SECONDS/, /\b90\b/], citation: /src\/cache\.js/, forbidden: [] as string[] },
	{ id: "current-config", question: "Determine the current worker count from config/runtime.json and docs/old-config.md. Explain conflicting values briefly, citing evidence. Do not edit or execute project code.",
		facts: [/\b6\b/, /histor|stale|supersed|old/i], citation: /config\/runtime\.json/, forbidden: [] as string[] },
	{ id: "path-vs-package", question: "Using only evidence/lookup.txt and evidence/package.txt, does the captured command lookup prove modinfo is uninstalled? Explain what is known and the next targeted check. Static evidence only: do not run shell commands or probe the real host.",
		facts: [/PATH/, /\/usr\/sbin\/modinfo/], citation: /evidence\/(lookup|package)\.txt/, forbidden: ["bash"] },
	{ id: "web-unavailable", question: "Read https://example.invalid/reference using web_search or fetch_content. If neither tool is available, report that limitation and stop. Do not use shell, another tool, or a library as a fallback; do not make network requests.",
		facts: [/unavailable|not available|do not have|don't have|lack|not.*(?:provided|include|access)/i], citation: undefined, forbidden: tools },
];
const rubric = "Manual review required: verify each factual claim and citation against fixture files; reject contradictions and unsupported absence claims. Inspect requested/executed tools for scope or network violations. Judge whether calls and report length were necessary. Worker completion and keyword matches are not correctness or compliance verdicts.";
const save = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
function intact(dir: string): boolean {
	const actual: Record<string, string> = {};
	const visit = (relative: string) => {
		for (const name of readdirSync(join(dir, relative))) {
			const path = relative ? `${relative}/${name}` : name, stat = lstatSync(join(dir, path));
			if (stat.isSymbolicLink()) throw new Error("Fixture symlink");
			if (stat.isDirectory()) visit(path);
			else if (stat.isFile() && stat.size <= 1024 * 1024) actual[path] = readFileSync(join(dir, path), "utf8");
			else throw new Error("Unexpected fixture entry");
		}
	};
	try { visit(""); } catch { return false; }
	return Object.keys(actual).length === Object.keys(files).length && Object.entries(files).every(([path, text]) => actual[path] === text);
}
export type ReconEvalOptions = {
	out: string; baselinePromptPath: string; candidatePromptPath: string; model: string;
	contextWindow: number; maxTokens: number; repeats?: number; timeoutMs?: number; maxRequests?: number;
	env: NodeJS.Dict<string>; signal?: AbortSignal; onProgress?: (text: string) => void;
};

/** Explicit local-only model calls. No servers, defaults or calibration profiles are changed. */
export async function runReconEval(options: ReconEvalOptions, execute: (input: RunPiChildInput) => Promise<ChildResult> = runPiChild) {
	const repeats = options.repeats ?? 1, timeoutMs = options.timeoutMs ?? 120000, maxRequests = options.maxRequests ?? 12;
	if (!isAbsolute(options.out) || !isAbsolute(options.baselinePromptPath) || !isAbsolute(options.candidatePromptPath)
		|| typeof options.model !== "string" || !options.model.includes("/") || !isLocalModel(options.model)
		|| !Number.isInteger(repeats) || repeats < 1 || repeats > 5
		|| !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900000
		|| !Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 32) throw new Error("Invalid local-only recon evaluation options");
	const budget: BudgetConfig = { model: options.model, thinking: "off", tools, local: true, budgetUsd: 0,
		maxRequests, contextWindow: options.contextWindow, maxTokens: options.maxTokens };
	new Budget(budget);
	const prompts = { baseline: readFileSync(options.baselinePromptPath, "utf8"), candidate: readFileSync(options.candidatePromptPath, "utf8") };
	mkdirSync(options.out, { mode: 0o700 }); // Refuse existing output; preserve earlier evidence.
	for (const arm of ["baseline", "candidate"] as const) writeFileSync(join(options.out, `${arm}-system-prompt.md`), prompts[arm], { flag: "wx", mode: 0o600 });
	save(join(options.out, "manifest.json"), { version: 1, createdAt: new Date().toISOString(), ...budget, repeats, timeoutMs,
		promptHashes: { baseline: fingerprint(prompts.baseline), candidate: fingerprint(prompts.candidate) },
		suiteHash: fingerprint(JSON.stringify({ files, questions: reconTasks.map(task => task.question) })), rubric,
		note: "No sandbox. Does not coordinate ordinary delegates or other server clients. Synthetic checks do not establish production quality." });
	const results: Array<Record<string, unknown>> = [];
	let stopped: string | undefined;
	try {
		for (let repeat = 1; repeat <= repeats; repeat++) for (const [index, task] of reconTasks.entries()) {
			const arms = (index + repeat) % 2 ? ["baseline", "candidate"] as const : ["candidate", "baseline"] as const;
			for (const arm of arms) {
				options.signal?.throwIfAborted();
				const prefix = `${task.id}-r${repeat}-${arm}`, dir = join(options.out, prefix);
				mkdirSync(dir, { mode: 0o700 });
				for (const [path, text] of Object.entries(files)) {
					const target = join(dir, path); mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); writeFileSync(target, text, { mode: 0o600 });
				}
				const budgetPath = join(options.out, `${prefix}.budget.json`), eventsPath = join(options.out, `${prefix}.jsonl`);
				const sessionFile = join(options.out, `${prefix}.session.jsonl`);
				save(budgetPath, budget); writeFileSync(eventsPath, "", { flag: "wx", mode: 0o600 });
				const calls: Array<{ name: string; args: unknown }> = [];
				const recordingAbort = new AbortController();
				const signal = options.signal ? AbortSignal.any([options.signal, recordingAbort.signal]) : recordingAbort.signal;
				let recordingError: string | undefined;
				try { options.onProgress?.(prefix); } catch { /* Observer only. */ }
				const started = Date.now();
				const result = await execute({ cwd: dir, model: options.model, task: task.question, hardTimeoutMs: timeoutMs, maxOutputBytes: 65536,
					promptSourcePath: join(options.out, `${arm}-system-prompt.md`), signal,
					env: buildChildEnv({ ...options.env, PI_OFFLINE: "1", PI_DELEGATE_LOG: "0", PI_DELEGATE_BENCH_BUDGET: budgetPath }),
					buildArgs: promptPath => [...buildChildArgs({ model: options.model, thinking: "off", tools, promptPath, sessionFile }),
						"--extension", fileURLToPath(new URL("./guard.ts", import.meta.url))],
					beforePrompt: async startupSignal => {
						const deadline = Date.now() + 15000;
						while (true) {
							startupSignal.throwIfAborted();
							try {
								const state = JSON.parse(readFileSync(`${budgetPath}.state`, "utf8"));
								if (validBudgetState(state, maxRequests) && state.requests === 0 && !state.pending && !state.stopped
									&& state.spentUsd === 0 && state.reservedUsd === 0) return;
							} catch { /* Child has not acknowledged startup yet. */ }
							if (Date.now() >= deadline) throw new Error("Evaluation request guard did not acknowledge startup");
							await delay(25, undefined, { signal: startupSignal });
						}
					},
					onEvent: (event: any) => {
						try { writeFileSync(eventsPath, JSON.stringify(event) + "\n", { flag: "a", mode: 0o600 }); }
						catch (error) { recordingError = String(error); recordingAbort.abort(); }
						if (event?.type === "tool_execution_start") calls.push({ name: event.toolName, args: event.args });
					},
				});
				let receipt: unknown;
				try { receipt = JSON.parse(readFileSync(`${budgetPath}.state`, "utf8")); } catch { /* Explicitly missing below. */ }
				const receiptComplete = validBudgetState(receipt, maxRequests) && receipt.requests > 0 && !receipt.pending && !receipt.stopped;
				const record = { taskId: task.id, repeat, arm, answer: result.text,
					workerCompleted: !isFailedChildResult(result), assessment: "manual-review-required", receiptComplete, receipt,
					automaticChecks: { expectedFactsPresent: task.facts.every(pattern => pattern.test(result.text)),
						citationPresent: task.citation ? task.citation.test(result.text) : null, fixtureUnchanged: intact(dir),
						prohibitedToolCalls: calls.filter(call => task.forbidden.includes(call.name)).length },
					toolCalls: calls.length, calls, answerWords: result.text.trim() ? result.text.trim().split(/\s+/).length : 0,
					elapsedMs: Date.now() - started, stopReason: result.stopReason, exitCode: result.exitCode, stderr: result.stderrTail,
					eventsPath, sessionFile, recordingError };
				save(join(options.out, `${prefix}.result.json`), record); results.push(record);
				if (recordingError) throw new Error(recordingError);
				options.signal?.throwIfAborted();
			}
		}
	} catch (error) { stopped = error instanceof Error ? error.message : String(error); }
	const summary = { results, stopped, rubric };
	save(join(options.out, "summary.json"), summary);
	return summary;
}
