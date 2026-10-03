import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, dirname, resolve, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { runPiChild, type RunPiChildInput, type ChildResult } from "../../child-runtime/spawn.ts";
import { isFailedChildResult } from "../../child-runtime/policy.ts";
import { buildChildArgs, buildChildEnv } from "../../delegate/spawn.ts";
import { isLocalModel } from "../../delegate/tg.ts";
import { fingerprint, snapshotPricing, type Pricing } from "../../delegate/calibration.ts";
import { Budget, requestReservation, validBudgetState, type BudgetConfig } from "../budget.ts";
import { transcriptUsage } from "../runner.ts";
import { historicalCases, type HistoricalCase } from "./cases.ts";

export type EvalArm = {
	id: string; model: string; thinking: string; contextWindow: number; maxTokens: number;
	prompts: { recon: string; implement: string }; pricing?: Pricing;
};
export type HistoricalEvalOptions = {
	out: string; arms: EvalArm[]; budgetUsd: number; repeats?: number; timeoutMs?: number; maxRequests?: number;
	caseIds?: string[]; env: NodeJS.Dict<string>; signal?: AbortSignal;
};
const rubric = "Manual review required: evidence matches do not establish factual accuracy; tests cover only fixture behavior. Check citations, contradictions, scope, unmet requirements, claimed checks and blockers. Worker completion is not task correctness. These sanitized proxies are not real GTK or Pi integration benchmarks.";
const save = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const repo = fileURLToPath(new URL("../../", import.meta.url));

function prepare(options: HistoricalEvalOptions) {
	const repeats = options.repeats ?? 1, timeoutMs = options.timeoutMs ?? 120000, maxRequests = options.maxRequests ?? 12;
	if (!isAbsolute(options.out) || !Number.isFinite(options.budgetUsd) || options.budgetUsd < 0
		|| !Number.isInteger(repeats) || repeats < 1 || repeats > 5
		|| !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900000
		|| !Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 32
		|| !Array.isArray(options.arms) || options.arms.length < 2 || options.arms.length > 8) throw new Error("Invalid historical evaluation options");
	const normalized = resolve(options.out), out = join(realpathSync(dirname(normalized)), basename(normalized));
	const withinRepo = relative(realpathSync(repo), out);
	if (!withinRepo || (!withinRepo.startsWith("..") && !isAbsolute(withinRepo))) throw new Error("Keep evaluation output outside the source checkout");
	const ids = new Set<string>();
	const arms = options.arms.map(arm => {
		if (!/^[a-z][a-z0-9-]{0,31}$/.test(arm.id) || ids.has(arm.id)
			|| typeof arm.model !== "string" || !/^[^\s/]+\/[^\s]+$/.test(arm.model)
			|| !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(arm.thinking)) throw new Error("Invalid or duplicate evaluation arm");
		ids.add(arm.id);
		const local = isLocalModel(arm.model), pricing = local ? undefined : snapshotPricing(arm.pricing);
		const budget: BudgetConfig = { model: arm.model, thinking: arm.thinking, tools: [], local, budgetUsd: local ? 0 : options.budgetUsd,
			maxRequests, contextWindow: arm.contextWindow, maxTokens: arm.maxTokens, pricing };
		new Budget(budget);
		if (!local && requestReservation(budget) > options.budgetUsd) throw new Error("Hosted budget must cover one conservative provider request reservation");
		const prompts = {} as Record<HistoricalCase["kind"], string>;
		for (const kind of ["recon", "implement"] as const) {
			if (!isAbsolute(arm.prompts?.[kind])) throw new Error("Prompt paths must be absolute");
			prompts[kind] = readFileSync(arm.prompts[kind], "utf8");
			if (!prompts[kind].trim() || Buffer.byteLength(prompts[kind]) > 65536) throw new Error("Prompts must be nonempty and at most 64 KiB");
		}
		return { ...arm, pricing, local, budget, promptText: prompts };
	});
	if (options.caseIds !== undefined && (!Array.isArray(options.caseIds) || !options.caseIds.length
		|| new Set(options.caseIds).size !== options.caseIds.length || options.caseIds.some(id => !historicalCases.some(c => c.id === id)))) throw new Error("Unknown or duplicate historical case selection");
	const cases = historicalCases.filter(c => !options.caseIds || options.caseIds.includes(c.id));
	return { out, arms, cases, repeats, timeoutMs, maxRequests };
}

function describePlan(p: ReturnType<typeof prepare>, budgetUsd: number) {
	return { cases: p.cases.map(c => ({ id: c.id, kind: c.kind, origin: c.origin })), repeats: p.repeats,
		runs: p.cases.length * p.repeats * p.arms.length, timeoutMs: p.timeoutMs, maxRequestsPerRun: p.maxRequests,
		budgetUsd, arms: p.arms.map(a => ({ id: a.id, model: a.model, thinking: a.thinking, local: a.local,
			promptHashes: { recon: fingerprint(a.promptText.recon), implement: fingerprint(a.promptText.implement) } })), rubric };
}

/** Read-only configuration validation. No artifact writes, model calls or server probes. */
export function planHistoricalEval(options: HistoricalEvalOptions) {
	return describePlan(prepare(options), options.budgetUsd);
}

function snapshot(root: string) {
	const stat = lstatSync(root);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Fixture root is not a real directory");
	const files: Record<string, string> = {}, dirs: string[] = [];
	let entries = 0, bytes = 0;
	const visit = (part: string) => {
		for (const name of readdirSync(join(root, part))) {
			if (++entries > 256) throw new Error("Fixture entry limit exceeded");
			const path = part ? `${part}/${name}` : name, stat = lstatSync(join(root, path));
			if (stat.isSymbolicLink()) throw new Error(`Fixture symlink: ${path}`);
			if (stat.isDirectory()) { dirs.push(path); visit(path); }
			else if (stat.isFile() && stat.size <= 1024 * 1024 && (bytes += stat.size) <= 2 * 1024 * 1024) files[path] = fingerprint(readFileSync(join(root, path)).toString("base64"));
			else throw new Error(`Unexpected or oversized fixture entry: ${path}`);
		}
	};
	visit(""); return { files, dirs };
}

export function inspectChanges(root: string, task: HistoricalCase) {
	try {
		const actual = snapshot(root), before = Object.fromEntries(Object.entries(task.files).map(([p, text]) => [p, fingerprint(Buffer.from(text).toString("base64"))]));
		const changed = [...new Set([...Object.keys(before), ...Object.keys(actual.files)])].filter(p => before[p] !== actual.files[p]);
		const allowedDirs = new Set<string>();
		for (const path of [...Object.keys(task.files), ...task.allowedChanges]) {
			let parent = dirname(path); while (parent !== ".") { allowedDirs.add(parent); parent = dirname(parent); }
		}
		const unexpected = [...changed.filter(p => !task.allowedChanges.includes(p)), ...actual.dirs.filter(p => !allowedDirs.has(p)).map(p => `${p}/`)];
		const missing = task.requiredChanges.filter(p => !changed.includes(p) || !Object.hasOwn(actual.files, p));
		return { changed, unexpected, missing, error: undefined as string | undefined };
	} catch (error) { return { changed: [], unexpected: [], missing: [...task.requiredChanges], error: String(error) }; }
}

type Validation = { ran: boolean; passed: boolean | null; exitCode?: number | string; output?: string };
function validateFixture(root: string, task: HistoricalCase, home: string): Promise<Validation> {
	if (!task.testFile) return Promise.resolve({ ran: false, passed: null });
	mkdirSync(home, { mode: 0o700 });
	return new Promise(resolve => {
		execFile(process.execPath, ["--test", join(root, task.testFile!)], {
			cwd: join(root, "workspace"), timeout: 5000, killSignal: "SIGKILL", maxBuffer: 65536,
			// Validation code must not receive model credentials or personal application paths.
			env: { PATH: dirname(process.execPath), HOME: home, USERPROFILE: home, TMPDIR: home, TEMP: home, TMP: home, LANG: "C.UTF-8", TZ: "UTC", SystemRoot: process.env.SystemRoot },
		}, (error, stdout, stderr) => resolve({ ran: true, passed: !error, exitCode: error?.code ?? 0, output: `${stdout}\n${stderr}`.slice(-65536) }));
	});
}

/** Explicit developer-only model calls, using fresh sanitized fixtures and the existing dispatch-time budget guard. */
export async function runHistoricalEval(options: HistoricalEvalOptions, execute: (input: RunPiChildInput) => Promise<ChildResult> = runPiChild) {
	const p = prepare(options);
	options.signal?.throwIfAborted();
	mkdirSync(p.out, { mode: 0o700 }); // Never reuse a run or overwrite prior evidence.
	mkdirSync(join(p.out, "prompts"), { mode: 0o700 });
	for (const arm of p.arms) {
		mkdirSync(join(p.out, "prompts", arm.id), { mode: 0o700 });
		for (const kind of ["recon", "implement"] as const) writeFileSync(join(p.out, "prompts", arm.id, `${kind}.md`), arm.promptText[kind], { flag: "wx", mode: 0o600 });
	}
	save(join(p.out, "manifest.json"), { version: 1, createdAt: new Date().toISOString(), ...describePlan(p, options.budgetUsd),
		models: p.arms.map(({ id, model, thinking, contextWindow, maxTokens, pricing }) => ({ id, model, thinking, contextWindow, maxTokens, pricing })),
		suiteHash: fingerprint(JSON.stringify(p.cases)), note: "No sandbox or shared-capacity coordination. API-metadata budget, not actual charges or a provider billing cap. No history replay or production prompt/config changes." });
	const results: Array<Record<string, any>> = [];
	let spentUsd = 0, spendIncomplete = false, stopped: string | undefined;
	try {
		for (let repeat = 1; repeat <= p.repeats; repeat++) for (const [index, task] of p.cases.entries()) {
			// Rotate the first arm to reduce fixed-order/cache effects; each arm has fresh files.
			const offset = (index + repeat - 1) % p.arms.length, arms = [...p.arms.slice(offset), ...p.arms.slice(0, offset)];
			for (const arm of arms) {
				options.signal?.throwIfAborted();
				const tools = ["read", "grep", "find", "ls", "bash", ...(task.kind === "implement" ? ["write", "edit"] : [])];
				const config = { ...arm.budget, tools, budgetUsd: arm.local ? 0 : Math.max(0, options.budgetUsd - spentUsd) };
				if (!arm.local && requestReservation(config) > config.budgetUsd) throw new Error("Remaining hosted budget cannot reserve another provider request");
				const prefix = `${task.id}-r${repeat}-${arm.id}`, root = join(p.out, prefix), cwd = join(root, "workspace");
				mkdirSync(root, { mode: 0o700 });
				for (const [path, text] of Object.entries(task.files)) {
					const target = join(root, path); mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); writeFileSync(target, text, { flag: "wx", mode: 0o600 });
				}
				const budgetPath = join(p.out, `${prefix}.budget.json`), eventsPath = join(p.out, `${prefix}.jsonl`), sessionFile = join(p.out, `${prefix}.session.jsonl`);
				const promptSourcePath = join(p.out, "prompts", arm.id, `${task.kind}.md`), question = task.task.replaceAll("{{root}}", root);
				save(budgetPath, config); writeFileSync(eventsPath, "", { flag: "wx", mode: 0o600 });
				const calls: Array<{ name: string; args: unknown }> = [];
				const recordingAbort = new AbortController(), signal = options.signal ? AbortSignal.any([options.signal, recordingAbort.signal]) : recordingAbort.signal;
				let recordingError: string | undefined;
				const started = Date.now();
				if (!arm.local) spendIncomplete = true;
				const result = await execute({ cwd, model: arm.model, task: question, hardTimeoutMs: p.timeoutMs, maxOutputBytes: 65536, promptSourcePath, signal,
					env: buildChildEnv({ ...options.env, PI_DELEGATE_LOG: "0", PI_DELEGATE_BENCH_BUDGET: budgetPath }),
					buildArgs: path => [...buildChildArgs({ model: arm.model, thinking: arm.thinking, tools, promptPath: path, sessionFile, offline: arm.local }),
						"--no-approve", "--no-themes", "--extension", fileURLToPath(new URL("../guard.ts", import.meta.url))],
					beforePrompt: async startupSignal => {
						const deadline = Date.now() + 15000;
						while (true) {
							startupSignal.throwIfAborted();
							try {
								const state = JSON.parse(readFileSync(`${budgetPath}.state`, "utf8"));
								if (validBudgetState(state, p.maxRequests) && !state.requests && !state.pending && !state.stopped && !state.spentUsd && !state.reservedUsd) return;
							} catch { /* Wait for guard startup acknowledgement. */ }
							if (Date.now() >= deadline) throw new Error("Evaluation guard did not acknowledge startup; no task sent");
							await delay(25, undefined, { signal: startupSignal });
						}
					},
					onEvent: (event: any) => {
						try { writeFileSync(eventsPath, JSON.stringify(event) + "\n", { flag: "a", mode: 0o600 }); }
						catch (error) { recordingError = String(error); recordingAbort.abort(); }
						if (event?.type === "tool_execution_start") calls.push({ name: event.toolName, args: event.args });
					},
				});
				const elapsedMs = Date.now() - started;
				let receipt: unknown;
				try { receipt = JSON.parse(readFileSync(`${budgetPath}.state`, "utf8")); } catch { /* Missing receipt is untrusted. */ }
				const usage = await transcriptUsage(eventsPath, arm.model, arm.pricing);
				const valid = validBudgetState(receipt, p.maxRequests);
				const reconciled = valid && !receipt.pending && usage.accounted && receipt.requests === usage.requests && Math.abs(receipt.spentUsd - usage.apiCostUsd) <= 1e-9;
				if (!arm.local && valid) spentUsd += receipt.spentUsd + receipt.reservedUsd;
				if (!arm.local) spendIncomplete = !reconciled;
				let changes = inspectChanges(root, task);
				const validation = !changes.error && !changes.unexpected.length ? await validateFixture(root, task, join(p.out, `${prefix}.validation-home`)) : { ran: false, passed: null };
				if (validation.ran) changes = inspectChanges(root, task);
				const scopeIntact = !changes.error && !changes.unexpected.length;
				const evidenceMatched = task.evidence ? task.evidence.every(fact => result.text.includes(fact)) : null;
				const workerCompleted = !isFailedChildResult(result), receiptComplete = reconciled && usage.complete && valid && !receipt.stopped && !recordingError;
				const checksPassed = workerCompleted && receiptComplete && scopeIntact && !changes.missing.length && (task.testFile ? validation.passed === true : evidenceMatched === true);
				const record = { taskId: task.id, kind: task.kind, origin: task.origin, repeat, arm: arm.id, model: arm.model, thinking: arm.thinking,
					answer: result.text, workerCompleted, assessment: "manual-review-required", checksPassed, changes, validation, evidenceMatched,
					receiptComplete, receipt, tokens: usage.tokens, apiMetadataUsd: usage.apiCostUsd, toolCalls: calls.length, calls,
					elapsedMs, stopReason: result.stopReason, exitCode: result.exitCode, stderr: result.stderrTail, recordingError, eventsPath, sessionFile };
				save(join(p.out, `${prefix}.result.json`), record); results.push(record);
				if (recordingError || !reconciled || (valid && receipt.stopped) || spentUsd > options.budgetUsd) throw new Error(recordingError ?? (valid ? receipt.stopped : undefined) ?? "Unresolved receipt/usage or budget exhausted; stopped");
				options.signal?.throwIfAborted();
			}
		}
	} catch (error) { stopped = error instanceof Error ? error.message : String(error); }
	const comparisons = p.arms.map(arm => {
		const rows = results.filter(r => r.arm === arm.id), times = rows.map(r => r.elapsedMs).sort((a, b) => a - b), n = times.length;
		return { arm: arm.id, model: arm.model, thinking: arm.thinking, runs: n, checksPassed: rows.filter(r => r.checksPassed).length,
			workerCompleted: rows.filter(r => r.workerCompleted).length, medianMs: n ? (times[Math.floor(n / 2)] + times[Math.floor((n - 1) / 2)]) / 2 : null,
			toolCalls: rows.reduce((sum, r) => sum + r.toolCalls, 0), tokens: rows.reduce((sum, r) => sum + r.tokens.total, 0),
			apiMetadataUsd: rows.reduce((sum, r) => sum + r.apiMetadataUsd, 0) };
	});
	const summary = { version: 1, results, comparisons, spentUsd, spendIncomplete, stopped, rubric };
	save(join(p.out, "summary.json"), summary); return summary;
}
