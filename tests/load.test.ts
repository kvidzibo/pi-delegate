import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseProviderOwner } from "../delegate/provider-extension.ts";
import { REPO, runPiProbe } from "./pi-cli.ts";

test("package manifest loads only delegate through the installed Pi CLI", async () => {
	const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { pi?: { extensions?: string[] } };
	assert.deepEqual(pkg.pi?.extensions, ["./delegate"]);
	assert.deepEqual((await runPiProbe("delegate-load-probe")).result, { tools: ["delegate"] });
});

test("configured capabilities survive overlays, observers, collection, archive and rendering", async () => {
	assert.deepEqual((await runPiProbe("delegate-capabilities-probe")).result, {
		configuredOnly: true, overlays: true, roleModelsKeepTools: true, detached: true, archived: true, rendered: true, noModelCalls: true,
	});
});

test("installed Pi CLI tool selection preserves exact names and expands wildcard patterns", async () => {
	for (const [input, expected] of [
		[["read", "grep", "find", "ls", "bash"], ["read", "grep", "find", "ls", "bash"]],
		[["read, bash, BASH", "all", "none", "unknown", "delegate"], ["read", "bash", "delegate"]],
		[["*"], ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls", "delegate"]],
		[[" , , "], []],
	] as Array<[string[], string[]]>) {
		const result = (await runPiProbe("delegate-allowlist-probe", undefined, input)).result as { tools: string[] };
		assert.deepEqual([...result.tools].sort(), [...expected].sort());
	}
});

test("automatic checkpoints deliver saved advice, fail open, cancel and use native settings", async () => {
	assert.deepEqual((await runPiProbe("delegate-checkpoints-probe")).result, {
		automatic: true, savedFeedback: true, failure: true, cancellation: true, menu: true, noModelCalls: true,
	});
});

test("native Roles edits full policy, creates safe roles and preserves accepted snapshots and overlays", async () => {
	assert.deepEqual((await runPiProbe("delegate-roles-probe")).result, {
		editor: true, safeDefaults: true, preservedOverlay: true, acceptedSnapshot: true,
	});
});

test("delegate model UI lists roles, searches available models and saves without changing accepted jobs", async () => {
	assert.deepEqual((await runPiProbe("delegate-models-probe")).result, {
		roleModels: true, availableOnly: true, scopeToggle: true, searchable: true, cancellation: true, persisted: true, live: true, queuedUnchanged: true, noModelCalls: true,
	});
});

test("local factory instances share capacity and real lease-only children retain occupancy without changing execution policy", async () => {
	assert.deepEqual((await runPiProbe("delegate-shared-capacity-probe")).result, {
		sharedFactories: true, hostedBypass: true, leaseOnlyStartup: true, inheritedOccupancy: true, noModelCalls: true,
	});
});

test("package reload restores a single delegate tool through the real session lifecycle", async () => {
	assert.deepEqual((await runPiProbe("delegate-reload-probe")).result, { tools: ["delegate"], reloaded: true });
});

test("calibrated pricing resolves in the real factory and restores snapshots", async () => {
	assert.deepEqual((await runPiProbe("delegate-savings-probe")).result, {
		calibrated: true, snapshot: true, rebuild: true, noModelCalls: true,
	});
});

test("native sessions and real extension infobar/commands work without model calls", async () => {
	assert.deepEqual((await runPiProbe("delegate-accounting-probe")).result, { nativeSession: true, infobar: true, noModelCalls: true, resume: true });
});

test("real tool renderer displays errors and propagates failure to Pi", async () => {
	assert.deepEqual((await runPiProbe("delegate-view-probe")).result, { errorsVisible: true, hostErrorsMarked: true });
});

test("live progress preserves scrollback and bottom-anchors the panel during growing parent output", async () => {
	assert.deepEqual((await runPiProbe("delegate-panel-probe")).result, {
		stableScrollback: true, bottomAnchored: true, fullPinnedCards: true, terminalWithoutCollect: true, queuedAndPromoted: true, singleMount: true, noModelCalls: true,
	});
});

test("delegate card backgrounds fill each row, follow status/theme and leave receipts and RPC plain", async () => {
	assert.deepEqual((await runPiProbe("delegate-background-probe")).result, {
		fullWidth: true, statusColors: true, neutralReceipts: true, themeChanges: true, plainRpc: true,
	});
});

test("all delegate return paths preserve results, promotion, parent interruption and notification contracts", async () => {
	assert.deepEqual((await runPiProbe("delegate-result-probe")).result, {
		terminalContracts: true, pendingContracts: true, promotion: true, notificationConsumption: true, parentInterrupt: true, wrapPreservation: true, finalizationProgress: true, noModelCalls: true,
	});
});

test("jobs and stats overlays browse full details and handle scope loading safely", async () => {
	assert.deepEqual((await runPiProbe("delegate-ux-probe")).result, {
		jobs: true, navigation: true, scopes: true, staleLoads: true, retry: true, disposal: true, noModelCalls: true,
	});
});

test("job cards finalize without collection, restore safely and render compact receipts", async () => {
	assert.deepEqual((await runPiProbe("delegate-card-probe")).result, {
		liveCard: true, receipts: true, previews: true, restoration: true, cancellation: true, emptyFailures: true, noModelCalls: true,
	});
});

test("provider probe names the extension a model needs and never runs project extensions", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-delegate-provider-probe-"));
	try {
		const project = join(dir, "project"), agent = join(dir, "agent"), ran = join(dir, "ran");
		const model = `models: [{ id: "m", name: "m", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }]`;
		const provider = (name: string, extra = "") => `export default function (pi) { pi.registerProvider("${name}", { baseUrl: "http://unused.invalid/v1", api: "openai-completions", apiKey: "unused", ${model}${extra} }); }\n`;
		mkdirSync(join(project, ".pi", "extensions"), { recursive: true });
		mkdirSync(join(agent, "extensions"), { recursive: true });
		writeFileSync(join(project, ".pi", "extensions", "untrusted.ts"),
			`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(ran)}, "1");\n${provider("project-provider")}`);
		const owner = join(agent, "extensions", "owner.ts");
		writeFileSync(owner, provider("probe-owner"));
		// Replaces the catalogue of a provider whose models.json entry already resolves without it.
		writeFileSync(join(agent, "extensions", "replace.ts"), provider("configured"));
		writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { configured: { baseUrl: "http://unused.invalid/v1", api: "openai-completions", apiKey: "unused", models: [{ id: "known-model" }] } } }));
		// Two files shaping one provider: neither alone reproduces the parent.
		for (const name of ["first.ts", "second.ts"]) writeFileSync(join(agent, "extensions", name), provider("shared"));
		const need = (id: string) => {
			const mark = "probe-test=";
			const result = spawnSync("pi", ["--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-session",
				"--extension", join(REPO, "child-runtime", "provider-probe.ts"), "--list-models"], {
				cwd: project, encoding: "utf8", timeout: 20000,
				env: { PATH: process.env.PATH, HOME: dir, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_DELEGATE_CHILD: "1",
					PI_DELEGATE_PROVIDER_PROBE: JSON.stringify({ mark, model: id }) },
			});
			return parseProviderOwner(result.stdout, mark);
		};
		assert.equal(need("probe-owner/m"), owner);
		assert.equal(need("configured/known"), undefined, "A model that --model resolves without extensions keeps its launch");
		assert.equal(need("shared/m"), undefined);
		assert.equal(need("project-provider/m"), undefined);
		assert.equal(existsSync(ran), false, "An untrusted project's extension must not run");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
