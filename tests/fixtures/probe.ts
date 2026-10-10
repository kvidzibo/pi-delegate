import assert from "node:assert/strict";
import { getAgentDir, SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { repositoryFor, repositorySnapshotStats } from "../../delegate/snapshots.ts";
import { AUDIT_CHECKS } from "../../delegate/snapshot-audit.ts";
import { ArchivedRun, archiveRoot } from "../../delegate/archive.ts";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import delegate from "../../delegate/index.ts";
import { cardProbe } from "./cards.ts";
import { resultProbe } from "./results.ts";
import { panelProbe } from "./panel.ts";
import { backgroundProbe } from "./background.ts";
import { uxProbe } from "./ux.ts";
import { savingsProbe } from "./savings.ts";
import { finalizationProbe } from "./finalization.ts";
import { headroomProbe } from "./headroom.ts";
import { sharedCapacityProbe } from "./local.ts";
import { capabilitiesProbe } from "./capabilities.ts";
import { createCatalogueLoader } from "../../mcp/models.ts";

export default function probe(pi: ExtensionAPI) {
	pi.registerCommand("delegate-reload-probe", {
		description: "Exercise the /reload lifecycle without model requests",
		handler: async (_args, ctx) => {
			await ctx.reload();
		},
	});
	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "reload") return;
		const tools = pi.getAllTools().filter(tool => tool.sourceInfo.source !== "builtin").map(tool => tool.name);
		assert.ok(!pi.getCommands().some(c => c.name === "delegate-local"));
		ctx.ui.notify(JSON.stringify({ type: "delegate_test_probe", command: "delegate-reload-probe", result: { tools, reloaded: true } }), "info");
	});
	const register = (name: string, run: (ctx: ExtensionCommandContext) => unknown | Promise<unknown>) => {
		pi.registerCommand(name, {
			description: "Offline package test; no model requests",
			handler: async (_args, ctx) => {
				try {
					const result = await run(ctx);
					ctx.ui.notify(JSON.stringify({ type: "delegate_test_probe", command: name, result }), "info");
				} catch (error) {
					ctx.ui.notify(JSON.stringify({ type: "delegate_test_probe", command: name, error: String(error) }), "error");
				}
			},
		});
	};
	register("delegate-capabilities-probe", ctx => capabilitiesProbe(pi, ctx));
	register("delegate-allowlist-probe", () => ({ tools: pi.getActiveTools() }));
	register("delegate-shared-capacity-probe", ctx => sharedCapacityProbe(pi, ctx));
	register("delegate-finalization-probe", ctx => finalizationProbe(pi, ctx));
	register("delegate-headroom-probe", headroomProbe);
	register("delegate-savings-probe", ctx => savingsProbe(pi, ctx));
	register("delegate-card-probe", (ctx) => cardProbe(pi, ctx));
	register("delegate-result-probe", (ctx) => resultProbe(pi, ctx));
	register("delegate-panel-probe", (ctx) => panelProbe(pi, ctx));
	register("delegate-background-probe", backgroundProbe);
	register("delegate-ux-probe", uxProbe);
	register("delegate-load-probe", () => {
		const tools = pi.getAllTools().filter((tool) => tool.sourceInfo.source !== "builtin");
		assert.deepEqual(tools.map((tool) => tool.name), ["delegate"]);
		assert.ok(!pi.getCommands().some(c => c.name === "delegate-local"));
		return { tools: tools.map((tool) => tool.name) };
	});
	register("delegate-snapshots-probe", async (ctx) => {
		const repoPath = join(getAgentDir(), "snapshot-repo"), storage = join(getAgentDir(), "eval-snapshots");
		mkdirSync(repoPath);
		const git = (...args: string[]) => execFileSync("git", args, { cwd: repoPath, encoding: "utf8" });
		git("init", "-q", "-b", "main"); writeFileSync(join(repoPath, "source"), "before\n"); git("add", ".");
		git("-c", "user.name=Test", "-c", "user.email=test@invalid", "commit", "-qm", "base");
		const repo = (await repositoryFor(repoPath))!;
		const userPath = join(getAgentDir(), "delegate.json"), previousSkip = process.env.PI_DELEGATE_SKIP_USER_CONFIG;
		writeFileSync(userPath, JSON.stringify({ maxConcurrent: 1, snapshots: { directory: storage, defaultEnabled: true, repositories: { [repo.configKey]: true } } }));
		delete process.env.PI_DELEGATE_SKIP_USER_CONFIG;
		const handlers = new Map<string, Function>(), commands = new Map<string, any>();
		let tool: any, release!: () => void, auditRelease: (() => void) | undefined, launches = 0, sequence = 0, failNotice = false, noticeThrows = 0, consent = false;
		const notices: string[] = [], auditMessages: string[] = [];
		const testCtx: any = { ...ctx, cwd: repoPath, hasUI: true, isIdle: () => false,
			ui: { ...ctx.ui, setStatus() {}, confirm: async () => consent, notify(text: string) {
				if (failNotice) { noticeThrows++; throw new Error("detached UI"); }
				notices.push(text);
			}, setWidget(key: string) { assert.notEqual(key, "delegate-snapshots", "capture status must never be sticky"); } },
		};
		delegate({ ...pi, registerTool: (next: any) => { tool = next; }, registerCommand: (name: string, next: any) => commands.set(name, next),
			registerMessageRenderer() {}, on: (name: string, handler: Function) => handlers.set(name, handler), sendMessage() {},
			sendUserMessage: (message: string) => auditMessages.push(message),
		} as unknown as ExtensionAPI, async input => {
			launches++;
			const metadata = JSON.parse(readFileSync(join(input.sessionFile!.replace(/\/session\.jsonl$/, ""), "metadata.json"), "utf8"));
			assert.ok(metadata.repositorySnapshot, "capture link is durable before the child runner starts");
			const manifest = JSON.parse(readFileSync(metadata.repositorySnapshot.manifestPath, "utf8"));
			assert.equal(manifest.runId, metadata.runId);
			assert.match(input.task, /Automatic review diff:/);
			if (input.task.startsWith("hold\n\n")) await new Promise<void>(resolve => { release = resolve; });
			return { text: "mock complete", exitCode: 0, stderrTail: "" };
		});
		const call = (params: object) => tool.execute(`snapshot-${++sequence}`, params, undefined, undefined, testCtx);
		const launch = (task: string) => call({ kind: "review", model: "hosted/mock", task, background: true });
		const until = async (ready: () => boolean) => { for (let i = 0; i < 500 && !ready(); i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(ready(), "expected observer/runner progress"); };
		try {
			failNotice = true;
			await handlers.get("session_start")!({ reason: "startup" }, testCtx);
			await until(() => noticeThrows > 0); // Exceptions from observers cannot escape session startup.
			failNotice = false;
			await handlers.get("session_start")!({ reason: "startup" }, testCtx);
			await until(() => notices.length === 1);
			assert.match(notices[0], /capture enabled · 0 snapshots · 0 B\nStorage:/);
			await handlers.get("session_start")!({ reason: "reload" }, testCtx);
			assert.equal(notices.length, 1, "reload must not repeat startup output");
			const held = await launch("hold"); await until(() => !!release);
			const queued = await launch("queued"); assert.equal(queued.details.status, "queued");
			const cancelled = await launch("cancelled"); await call({ jobId: cancelled.details.jobId, cancel: true });
			writeFileSync(join(repoPath, "source"), "queued-start\n"); release();
			await call({ jobId: held.details.jobId });
			const done = await call({ jobId: queued.details.jobId }); assert.equal(done.details.ok, true);
			assert.equal(notices.length, 1, "captures must not repeat startup output");
			assert.equal(launches, 2); assert.equal((await repositorySnapshotStats(repo, storage)).count, 2);
			const metadata = JSON.parse(readFileSync(join(done.details.sessionFile.replace(/\/session\.jsonl$/, ""), "metadata.json"), "utf8"));
			const manifest = JSON.parse(readFileSync(metadata.repositorySnapshot.manifestPath, "utf8"));
			const { gunzipSync } = await import("node:zlib");
			assert.equal(gunzipSync(readFileSync(join(storage, repo.id, "objects", `${manifest.entries.find((entry: any) => entry.path === "source").hash}.gz`))).toString(), "queued-start\n");
			let menu = 0;
			await commands.get("pi-delegate").handler("snapshots", { ...testCtx, ui: { ...testCtx.ui,
				select: async (title: string, options: string[]) => {
					assert.match(title, /2 snapshots/);
					const pick = menu++ === 0 ? "Disable capture for this repository" : "Back";
					assert.ok(options.includes(pick)); return pick;
				},
			} });
			const saved = JSON.parse(readFileSync(userPath, "utf8")).snapshots;
			assert.equal(saved.defaultEnabled, true); assert.equal(saved.repositories[repo.configKey], false);
			assert.equal(notices.length, 1, "settings changes must not repeat startup output");
			// Global enablement in an unknown repository offers consent instead of capturing.
			await handlers.get("session_shutdown")!();
			writeFileSync(userPath, JSON.stringify({ maxConcurrent: 1, snapshots: { directory: storage, defaultEnabled: true, repositories: {} } }));
			delegate({ ...pi, registerTool: (next: any) => { tool = next; }, registerCommand: (name: string, next: any) => commands.set(name, next),
				registerMessageRenderer() {}, on: (name: string, handler: Function) => handlers.set(name, handler), sendMessage() {},
				sendUserMessage: (message: string) => auditMessages.push(message),
			} as unknown as ExtensionAPI, async input => {
				launches++;
				if (input.task.startsWith("audit-hold\n\n")) await new Promise<void>(resolve => { auditRelease = resolve; });
				return { text: "mock complete", exitCode: 0, stderrTail: "" };
			});
			const unknown = await call({ kind: "review", model: "hosted/mock", task: "unknown repository", timeoutMs: 2000 });
			assert.equal(unknown.details.ok, false); assert.match(unknown.content[0].text, /requires a user-approved safety audit/);
			assert.equal(launches, 2); assert.equal((await repositorySnapshotStats(repo, storage)).count, 2);
			await handlers.get("session_start")!({ reason: "startup" }, testCtx);
			await until(() => notices.some(message => /request an audit later/.test(message)));
			assert.equal(auditMessages.length, 0, "decline makes no agent request");
			assert.equal(JSON.parse(readFileSync(userPath, "utf8")).snapshots.repositories[repo.configKey], false);
			consent = true;
			const auditCtx = { ...testCtx, isIdle: () => true };
			await commands.get("pi-delegate").handler("snapshots", { ...auditCtx, ui: { ...testCtx.ui,
				select: async (_title: string, options: string[]) => { assert.ok(options.includes("Audit repository before enabling capture")); return "Audit repository before enabling capture"; },
			} });
			assert.equal(auditMessages.length, 1);
			assert.equal((await repositorySnapshotStats(repo, storage)).count, 2);
			const whileAuditing = await call({ kind: "review", model: "hosted/mock", task: "must not capture audit", timeoutMs: 2000 });
			assert.equal(whileAuditing.details.ok, false); assert.equal(launches, 2);
			const auditId = auditMessages[0].match(/Audit ID: ([a-f0-9-]{36})/)![1];
			const accepted = await call({ auditId, auditResult: { verdict: "passed", checked: [...AUDIT_CHECKS], issues: [] } });
			assert.equal(accepted.details.ok, true); assert.equal(accepted.details.snapshotAudit, true);
			assert.equal(JSON.parse(readFileSync(userPath, "utf8")).snapshots.repositories[repo.configKey], true);
			assert.equal((await repositorySnapshotStats(repo, storage)).count, 2, "the audit itself never captures");
			assert.equal(launches, 2);
			const requestAudit = async () => {
				await commands.get("pi-delegate").handler("snapshots", { ...auditCtx, ui: { ...testCtx.ui,
					select: async (_title: string, options: string[]) => options.includes("Re-audit this repository") ? "Re-audit this repository" : "Audit repository before enabling capture",
				} });
				return auditMessages.at(-1)!.match(/Audit ID: ([a-f0-9-]{36})/)![1];
			};
			// A job queued while enabled must not capture or launch after a re-audit starts.
			auditRelease = undefined;
			const auditHeld = await launch("audit-hold"); await until(() => !!auditRelease);
			const queuedBeforeAudit = await launch("queued-before-audit"); assert.equal(queuedBeforeAudit.details.status, "queued");
			let reAuditId = await requestAudit();
			auditRelease!(); await call({ jobId: auditHeld.details.jobId });
			const blockedQueue = await call({ jobId: queuedBeforeAudit.details.jobId });
			assert.equal(blockedQueue.details.ok, false); assert.match(blockedQueue.content[0].text, /audit is pending/);
			assert.equal(launches, 3); assert.equal((await repositorySnapshotStats(repo, storage)).count, 3);
			await call({ auditId: reAuditId, auditResult: { verdict: "incomplete", checked: [], issues: [] } });
			// Even after the incomplete audit settles, revoked permission beats frozen queue policy.
			reAuditId = await requestAudit();
			await call({ auditId: reAuditId, auditResult: { verdict: "passed", checked: [...AUDIT_CHECKS], issues: [] } });
			auditRelease = undefined;
			const revokedHeld = await launch("audit-hold"); await until(() => !!auditRelease);
			const queuedBeforeDecline = await launch("queued-before-decline"); assert.equal(queuedBeforeDecline.details.status, "queued");
			reAuditId = await requestAudit();
			await call({ auditId: reAuditId, auditResult: { verdict: "incomplete", checked: [], issues: [] } });
			auditRelease!(); await call({ jobId: revokedHeld.details.jobId });
			const revokedQueue = await call({ jobId: queuedBeforeDecline.details.jobId });
			assert.equal(revokedQueue.details.ok, false); assert.match(revokedQueue.content[0].text, /permission was revoked/);
			assert.equal(launches, 4); assert.equal((await repositorySnapshotStats(repo, storage)).count, 4);
			// Expired clean reports are warnings with preserved findings, not tool errors.
			reAuditId = await requestAudit();
			await handlers.get("session_compact")!();
			const stale = await call({ auditId: reAuditId, auditResult: { verdict: "passed", checked: ["source"], issues: [], warnings: ["history: unexamined slice"] } });
			assert.equal(stale.details.ok, true); assert.equal(stale.details.auditWarning, true);
			assert.equal(handlers.get("tool_result")!({ toolName: "delegate", details: stale.details }), undefined);
			assert.match(stale.content[0].text, /session was compacted/);
			assert.match(stale.content[0].text, /No secret leak or hard capture blocker was reported/);
			assert.match(stale.content[0].text, /checked 1\/5 areas/);
			assert.match(stale.content[0].text, /history: unexamined slice/);
			const colors: string[] = [];
			tool.renderResult(stale, { expanded: false, isPartial: false }, { fg: (color: string, text: string) => { colors.push(color); return text; } }, { state: {} });
			assert.deepEqual(colors, ["warning"]);
			assert.equal(JSON.parse(readFileSync(userPath, "utf8")).snapshots.repositories[repo.configKey], false);
			// The same warning contract holds if cancellation interrupts in-flight checks.
			reAuditId = await requestAudit();
			const submitting = call({ auditId: reAuditId, auditResult: { verdict: "passed", checked: ["source"], issues: [], warnings: ["history: unexamined slice"] } });
			await handlers.get("session_compact")!();
			const interrupted = await submitting;
			assert.equal(interrupted.details.ok, true); assert.equal(interrupted.details.auditWarning, true);
			assert.equal(handlers.get("tool_result")!({ toolName: "delegate", details: interrupted.details }), undefined);
			assert.match(interrupted.content[0].text, /session was compacted/);
			assert.match(interrupted.content[0].text, /No secret leak or hard capture blocker was reported/);
			assert.match(interrupted.content[0].text, /history: unexamined slice/);
			assert.equal(JSON.parse(readFileSync(userPath, "utf8")).snapshots.repositories[repo.configKey], false);
			const messageCount = auditMessages.length;
			const manual = async (confirm: boolean) => {
				let picks = 0;
				await commands.get("pi-delegate").handler("snapshots", { ...auditCtx, ui: { ...testCtx.ui,
					select: async (_title: string, options: string[]) => {
						const choice = picks++ === 0 ? "Enable capture anyway (manual approval)" : "Back";
						assert.ok(options.includes(choice)); return choice;
					},
					confirm: async (title: string, message: string) => {
						assert.match(title, /Warning/); assert.match(message, /may contain secrets/);
						assert.match(message, /Hard capture\/storage checks still apply/); return confirm;
					},
				} });
			};
			await manual(false);
			assert.equal(JSON.parse(readFileSync(userPath, "utf8")).snapshots.repositories[repo.configKey], false);
			await manual(true);
			assert.equal(JSON.parse(readFileSync(userPath, "utf8")).snapshots.repositories[repo.configKey], true);
			assert.equal(auditMessages.length, messageCount, "manual approval does not request another model audit");
			assert.equal((await repositorySnapshotStats(repo, storage)).count, 4, "manual approval never creates snapshots");
			const successfulLaunches = launches;
			// Recreate a factory with capture enabled and invalid storage: no child may launch.
			await handlers.get("session_shutdown")!();
			writeFileSync(userPath, JSON.stringify({ snapshots: { directory: join(repoPath, "bad-store"), repositories: { [repo.configKey]: true } } }));
			delegate({ ...pi, registerTool: (next: any) => { tool = next; }, registerCommand() {}, registerMessageRenderer() {},
				on: (name: string, handler: Function) => handlers.set(name, handler), sendMessage() {},
			} as unknown as ExtensionAPI, async () => { launches++; throw new Error("must not start"); });
			const bad = await call({ kind: "review", model: "hosted/mock", task: "bad storage", background: false, timeoutMs: 2000 });
			assert.equal(bad.details.ok, false); assert.match(bad.content[0].text, /outside the repository/); assert.equal(launches, successfulLaunches);
			return { startup: true, configured: true, queuedStartState: true, cancelledNotCaptured: true, linkedArchive: true, failClosed: true, noModelCalls: true };
		} finally {
			await handlers.get("session_shutdown")?.();
			if (previousSkip === undefined) delete process.env.PI_DELEGATE_SKIP_USER_CONFIG; else process.env.PI_DELEGATE_SKIP_USER_CONFIG = previousSkip;
			rmSync(userPath, { force: true });
		}
	});
	register("delegate-models-probe", async (ctx) => {
		assert.ok(pi.getCommands().some(command => command.name === "pi-delegate"));
		assert.ok(!pi.getCommands().some(command => command.name === "delegate"));
		const initial = JSON.parse(readFileSync(new URL("../../delegate/config.json", import.meta.url), "utf8"));
		const oldModel = initial.agents.recon.model;
		const slash = oldModel.indexOf("/");
		const selected = "picker-cloud/team/new";
		writeFileSync(join(getAgentDir(), "models.json"), JSON.stringify({ providers: {
			[oldModel.slice(0, slash)]: { baseUrl: "http://localhost:1/v1", api: "openai-completions", apiKey: "unused",
				models: [{ id: oldModel.slice(slash + 1) }] },
			"picker-cloud": { baseUrl: "https://unused.invalid/v1", api: "openai-completions", apiKey: "unused",
				models: [{ id: "team/new", name: "Fresh Model", reasoning: true,
					thinkingLevelMap: { off: null, minimal: null, low: null, xhigh: "xhigh", max: "max" } }] },
			"picker-extra": { baseUrl: "https://unused.invalid/v1", api: "openai-completions", apiKey: "unused",
				models: [{ id: "other", name: "Unscoped Model" }] },
			"picker-no-auth": { baseUrl: "https://unused.invalid/v1", api: "openai-completions", models: [{ id: "hidden" }] },
		} }));
		const loadCatalogue = createCatalogueLoader({ command: "pi", agentDir: getAgentDir() });
		const catalogue = await loadCatalogue();
		assert.equal(catalogue.warning, undefined);
		assert.ok(catalogue.models.find(model => model.id === selected)?.available);
		const modelsStorePath = join(getAgentDir(), "models-store.json");
		let savedStore: string | undefined;
		try { savedStore = readFileSync(modelsStorePath, "utf8"); } catch { /* absent cache */ }
		try {
			writeFileSync(modelsStorePath, "{broken models store");
			const failedCatalogue = await loadCatalogue();
			assert.deepEqual(failedCatalogue.models, []);
			assert.ok(failedCatalogue.warning, "refresh errors must disable settings, not offer fallback models");
		} finally {
			if (savedStore === undefined) rmSync(modelsStorePath, { force: true });
			else writeFileSync(modelsStorePath, savedStore);
		}
		const userPath = join(getAgentDir(), "delegate.json");
		const overlay = { maxOutputBytes: 12345, note: "preserve", agents: {
			recon: { thinking: "medium", tools: ["read", "bash"] },
			implement: { model: "picker-extra/other" },
		} };
		writeFileSync(userPath, JSON.stringify(overlay));
		const original = readFileSync(userPath, "utf8");
		const skip = process.env.PI_DELEGATE_SKIP_USER_CONFIG;
		delete process.env.PI_DELEGATE_SKIP_USER_CONFIG;
		const handlers = new Map<string, Function>(), commands = new Map<string, any>();
		let tool: any, finish: (() => void) | undefined;
		const launches: any[] = [], notices: string[] = [];
		const factory = () => delegate({ ...pi,
			registerTool: (definition: unknown) => { tool = definition; },
			registerCommand: (name: string, command: unknown) => commands.set(name, command),
			registerMessageRenderer: () => {}, on: (event: string, handler: Function) => { handlers.set(event, handler); },
			setModel: () => { throw new Error("Must not change the parent model"); },
		} as unknown as ExtensionAPI, async input => {
			launches.push(input);
			if (input.task === "hold") await new Promise<void>(resolve => {
				finish = resolve; input.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			return { text: "mock complete", exitCode: 0, stderrTail: "" };
		});
		let rolePicks = 0, modelPicks = 0, confirms = 0, sequence = 0;
		const testCtx: any = { ...ctx, mode: "tui", isIdle: () => false,
			scopedModels: [
				{ model: { provider: oldModel.slice(0, slash), id: oldModel.slice(slash + 1) } },
				{ model: { provider: "picker-cloud", id: "team/new", name: "Fresh Model" } },
			],
			ui: { ...ctx.ui, setWidget: () => {}, setStatus: () => {}, notify: (text: string) => notices.push(text),
				select: async (title: string, options: string[]) => {
					if (title.startsWith("Settings for") || title.startsWith("Model for")) throw new Error(`unexpected ${title}`);
					if (title.startsWith("Reasoning for")) {
						assert.equal(confirms, 2, "reasoning follows an accepted model selection");
						assert.equal(modelPicks, 3);
						assert.match(title, /Saved model: picker-cloud\/team\/new/);
						assert.deepEqual(options, ["medium ✓ current", "high", "xhigh", "max"]);
						return "max";
					}
					assert.match(title, /Delegate models/);
					assert.match(title, /model picker; reasoning follows/);
					assert.equal(options.length, 4);
					for (const kind of ["recon", "implement", "review", "oracle"]) assert.ok(options.some(option => option.startsWith(`${kind} · `)));
					if (rolePicks === 0) {
						assert.doesNotMatch(options[0], /unavailable|not in scope/);
						assert.ok(options.some(option => option.startsWith("implement · picker-extra/other (not in scope)")));
					}
					const pick = ++rolePicks;
					if (pick === 1) {
						assert.equal(readFileSync(userPath, "utf8"), original);
						return options[0];
					}
					if (pick === 2) {
						assert.equal(modelPicks, 1, "esc returns to roles without opening reasoning");
						assert.equal(readFileSync(userPath, "utf8"), original, "cancel does not write");
						return options[0];
					}
					assert.equal(pick, 3);
					assert.match(title, /Saved reasoning: max/);
					assert.match(options[0], /picker-cloud\/team\/new/);
					assert.match(options[0], /reasoning: max/);
					return undefined;
				},
				custom: async (create: Function) => {
					let result: string | undefined;
					const tui = { terminal: { rows: 30 }, requestRender: () => {} };
					const component = await create(tui, ctx.ui.theme, getKeybindings(), (value: string | undefined) => { result = value; });
					try {
						component.focused = true;
						const rendered = component.render(100).join("\n");
						assert.ok(rendered.includes("✓ current"));
						assert.ok(rendered.includes(selected));
						assert.ok(rendered.includes("Same models as /model."));
						assert.ok(!rendered.includes("picker-extra"), rendered);
						assert.ok(!rendered.includes("picker-no-auth"));
							const pick = ++modelPicks;
						if (pick === 1) { component.handleInput("\x1b"); return result; }
						assert.equal(readFileSync(userPath, "utf8"), original, "declined model save does not write");
						assert.equal(confirms, pick === 2 ? 0 : 1);
						for (const char of "Fresh Model") component.handleInput(char);
						assert.match(component.render(100).join("\n"), /1\/2 scoped/);
						for (const width of [12, 40, 100]) assert.ok(component.render(width).every((line: string) => visibleWidth(line) <= width));
						tui.terminal.rows = 15;
						assert.ok(component.render(40).length <= 15);
						component.handleInput("\r");
						assert.equal(result, selected);
						return result;
					} finally { component.dispose(); }
				},
				confirm: async (_title: string, text: string) => {
					confirms++;
					assert.ok(text.includes(userPath));
					assert.match(text, confirms < 3 ? /→ picker-cloud\/team\/new/ : /medium → max/);
					assert.doesNotMatch(text, /offline/);
					if (confirms === 1) return false;
					return true;
				},
			},
		};
		const call = (params: unknown) => tool.execute(`models-${++sequence}`, params, undefined, undefined, testCtx);
		try {
			factory();
			await handlers.get("session_start")?.({}, testCtx);
			const running = await call({ kind: "recon", task: "hold", background: true });
			const queued = await call({ kind: "recon", task: "queued", background: true });
			assert.equal(queued.details.status, "queued");
			let unchangedRoles = 0, unchangedReasoning = 0;
			await commands.get("pi-delegate").handler("models", { ...testCtx, ui: { ...testCtx.ui,
				select: async (title: string, options: string[]) => {
					if (title.startsWith("Reasoning for")) {
						unchangedReasoning++;
						assert.ok(title.includes(oldModel));
						assert.doesNotMatch(title, /Saved model/);
						return undefined;
					}
					if (!title.startsWith("Delegate models")) throw new Error(`unexpected ${title}`);
					assert.ok(options[0].startsWith(`recon · ${oldModel} ·`));
					return ++unchangedRoles === 1 ? options[0] : undefined;
				},
				custom: async (create: Function) => {
					let result: string | undefined;
					const tui = { terminal: { rows: 30 }, requestRender: () => {} };
					const component = await create(tui, ctx.ui.theme, getKeybindings(), (value: string | undefined) => { result = value; });
					try {
						assert.ok(component.render(100).join("\n").includes("✓ current"));
						component.handleInput("\r");
						assert.equal(result, oldModel);
						return result;
					} finally { component.dispose(); }
				},
				confirm: async () => { throw new Error("current model must not confirm or save"); },
			} });
			assert.equal(unchangedReasoning, 1, "enter on the current model opens reasoning");
			assert.equal(unchangedRoles, 2);
			assert.equal(readFileSync(userPath, "utf8"), original, "current model does not write");
			await commands.get("pi-delegate").handler("models", testCtx);
			assert.equal(confirms, 3, notices.join("\n"));
			assert.equal(rolePicks, 3, notices.join("\n"));
			assert.equal(modelPicks, 3, notices.join("\n"));
			assert.ok(!notices.some(text => text.includes("Saved")), "save feedback stays in the dialog");
			assert.deepEqual(JSON.parse(readFileSync(userPath, "utf8")), { ...overlay, agents: {
				recon: { ...overlay.agents.recon, model: selected, thinking: "max" },
				implement: overlay.agents.implement,
			} });
			const fresh = await call({ kind: "recon", task: "fresh" });
			assert.equal(fresh.details.model, selected);
			assert.equal(fresh.details.ok, true);
			finish!();
			await call({ jobId: running.details.jobId }); await call({ jobId: queued.details.jobId });
			assert.deepEqual(launches.map(input => input.model), [oldModel, selected, oldModel]);
			assert.ok(launches.every(input => !("offline" in input)));
			assert.deepEqual(launches.map(input => input.thinking), ["medium", "max", "medium"]);
			assert.ok(launches.every(input => input.tools.join(",") === "read,bash"));
			await handlers.get("session_shutdown")?.();
			factory(); // Reload from the saved overlay, not in-memory selections.
			assert.equal((await call({ kind: "recon", task: "restored" })).details.model, selected);
			assert.equal(launches.at(-1).thinking, "max");
			// Non-reasoning models expose only off; unknown models must not get a guessed list.
			const saved = readFileSync(userPath, "utf8");
			let fallbackRoles = 0, fallbackPickers = 0;
			await commands.get("pi-delegate").handler("models", { ...testCtx, scopedModels: [],
				ui: { ...testCtx.ui,
					select: async (title: string, options: string[]) => {
						if (!title.startsWith("Delegate models")) throw new Error(`unexpected ${title}`);
						if (fallbackRoles === 0) {
							assert.ok(options.some(option => option.startsWith("implement · picker-extra/other ·")));
							assert.ok(!options.some(option => option.includes("not in scope")));
						}
						return ++fallbackRoles === 1 ? options[0] : undefined;
					},
					custom: async (create: Function) => {
						fallbackPickers++;
						let result: string | undefined;
						const tui = { terminal: { rows: 30 }, requestRender: () => {} };
						const component = await create(tui, ctx.ui.theme, getKeybindings(), (value: string | undefined) => { result = value; });
						try {
							const text = component.render(100).join("\n");
							assert.ok(text.includes("picker-extra/other"), text);
							assert.ok(text.includes(selected));
							assert.ok(!text.includes("picker-no-auth"));
							assert.ok(!text.includes("Same models as /model."));
							assert.match(text, /3\/3 available/);
							component.handleInput("\x1b");
							return result;
						} finally { component.dispose(); }
					},
					confirm: async () => { throw new Error("empty scope preview must not save"); },
				},
			});
			assert.equal(fallbackRoles, 2);
			assert.equal(fallbackPickers, 1, "role selection opens the model picker immediately");
			assert.equal(readFileSync(userPath, "utf8"), saved);
			for (const known of [true, false]) {
				let picks = 0, reasoningPicks = 0;
				await commands.get("pi-delegate").handler("models", { ...testCtx,
					modelRegistry: {
						refresh: async () => {}, getError: () => undefined, getAvailable: () => [],
						getAll: () => known ? [{ provider: "picker-cloud", id: "team/new", reasoning: false }] : [],
					},
					ui: { ...testCtx.ui,
						custom: async () => { throw new Error("empty catalogue must not open the model picker"); },
						confirm: async () => { throw new Error("empty catalogue must not save"); },
						select: async (title: string, options: string[]) => {
							if (title.startsWith("Reasoning for")) {
								reasoningPicks++; assert.deepEqual(options, ["off"]);
								assert.match(title, /max \(unsupported for this model\)/);
								return undefined;
							}
							if (!title.startsWith("Delegate models")) throw new Error(`unexpected ${title}`);
							return ++picks === 1 ? options[0] : undefined;
						},
					},
				});
				assert.equal(reasoningPicks, known ? 1 : 0);
				assert.equal(picks, 2);
				assert.equal(readFileSync(userPath, "utf8"), saved);
			}
			assert.ok(notices.some(text => text.includes("Cannot determine reasoning levels")));
			return { roleModels: true, availableOnly: true, scopedOnly: true, searchable: true, cancellation: true, persisted: true, live: true, queuedUnchanged: true, noModelCalls: true };
		} finally {
			finish?.(); await handlers.get("session_shutdown")?.();
			if (skip === undefined) delete process.env.PI_DELEGATE_SKIP_USER_CONFIG; else process.env.PI_DELEGATE_SKIP_USER_CONFIG = skip;
		}
	});
	register("delegate-accounting-probe", async (ctx) => {
		assert.ok(pi.getCommands().some((c) => c.name === "pi-delegate"));
		const prompt = join(ctx.cwd, "probe-prompt.md"); writeFileSync(prompt, "Probe custom prompt");
		const archive = new ArchivedRun(archiveRoot(getAgentDir()), {
			parentSessionId: ctx.sessionManager.getSessionId(), parentSessionFile: ctx.sessionManager.getSessionFile(),
			toolCallId: "probe", kind: "recon", cwd: ctx.cwd, requestedModel: "local-qwen38/qwen38-q4km", thinking: "off", tools: ["read"],
		}, "probe task", prompt);
		archive.start("d0001");
		// Real native Pi session writer, no provider/model call. This verifies the header and CLI --session format.
		const child = SessionManager.open(archive.paths.session);
		assert.equal(child.getSessionId(), archive.data.runId);
		const message: any = { role: "assistant", api: "openai-completions", provider: "local-qwen38", model: "qwen38-q4km", content: [{ type: "text", text: "answer" }], timestamp: 1, stopReason: "stop", usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 5, totalTokens: 155, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		child.appendMessage(message); archive.observe({ type: "message_end", message }); archive.observe({ type: "agent_settled" });
		await archive.finish({ status: "done", stopReason: "stop", exitCode: 0 });
		const handlers = new Map<string, Function>(); const commands = new Map<string, any>();
		delegate({ ...pi, registerTool: () => {}, registerMessageRenderer: () => {}, registerCommand: (name: string, command: any) => commands.set(name, command), on: (event: string, fn: Function) => handlers.set(event, fn) } as unknown as ExtensionAPI);
		const statuses: Array<string | undefined> = []; const notices: string[] = []; const reports: string[] = [];
		const testCtx: any = { ...ctx, hasUI: true, ui: { ...ctx.ui,
			setStatus: (key: string, text: string | undefined) => { statuses.push(text); ctx.ui.setStatus(key, text); },
			notify: (text: string) => notices.push(text),
			select: async (report: string) => { reports.push(report); return undefined; },
		} };
		const entriesBefore = ctx.sessionManager.getEntries().length;
		await handlers.get("session_start")?.({}, testCtx);
		assert.equal(statuses.at(-1), "⑂ 155|100%");
		await commands.get("pi-delegate").handler("stats", testCtx);
		assert.ok(reports.at(-1)?.includes("Delegated: 155 tokens"));
		assert.ok(reports.at(-1)?.includes("Saved: unavailable"));
		assert.equal(notices.length, 0, "stats must not print notifications");
		await commands.get("pi-delegate").handler("stats", { ...testCtx, mode: "tui", ui: { ...testCtx.ui,
			custom: async (create: Function, options: { overlay?: boolean }) => {
				assert.equal(options.overlay, true, "stats must not compete with job boards for editor dock height");
				let closed = false;
				const tui = { terminal: { rows: 18 }, requestRender: () => {} };
				const view = create(tui, ctx.ui.theme, getKeybindings(), () => { closed = true; });
				const first = view.render(60).join("\n");
				assert.match(first, /pi-delegate · stats/);
				assert.match(first, /Delegated: 155 tokens/);
				for (let i = 0; i < 100; i++) view.handleInput("\x1b[B");
				assert.match(view.render(60).join("\n"), /Archive:/);
				for (const width of [20, 60, 100]) {
					const lines = view.render(width);
					assert.ok(lines.length <= tui.terminal.rows);
					assert.ok(lines.every((line: string) => visibleWidth(line) <= width));
				}
				view.handleInput("\x1b"); assert.equal(closed, true);
			},
		} });
		assert.equal(notices.length, 0);
		assert.equal(ctx.sessionManager.getEntries().length, entriesBefore, "stats must not inject model context");
		await handlers.get("session_start")?.({}, { ...testCtx, sessionManager: { getSessionId: () => "another-session" } });
		assert.equal(statuses.at(-1), undefined);
		await handlers.get("session_start")?.({}, testCtx);
		assert.equal(statuses.at(-1), "⑂ 155|100%");
		await handlers.get("session_shutdown")?.(); assert.equal(statuses.at(-1), undefined);
		return { nativeSession: true, infobar: true, noModelCalls: true, resume: true };
	});
	register("delegate-view-probe", async () => {
		// Capture the real factory's tool and event handlers. Never spawn a delegate.
		let tool: any;
		const handlers = new Map<string, Function>();
		delegate({
			...pi,
			registerTool: (definition: unknown) => { tool = definition; },
			on: (event: string, handler: Function) => { handlers.set(event, handler); },
			registerMessageRenderer: () => {},
			registerCommand: () => {},
		} as ExtensionAPI);
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text, italic: (text: string) => text };
		const result = await tool.execute("invalid", { jobId: "missing" }, undefined, undefined, { cwd: process.cwd(), hasUI: false });
		assert.equal(result.details.ok, false);
		const message = "delegate refused: unknown jobId missing.";
		const outputs = [
			result,
			{ content: [{ type: "text", text: message }] }, // schema/host error without details
			{ content: [{ type: "text", text: message }], details: {} },
		];
		for (const output of outputs) {
			for (const expanded of [false, true]) {
				const panel = tool.renderResult(output, { expanded, isPartial: false }, theme, { state: {}, isError: true });
				assert.ok(panel.render(100).join("\n").includes(message), "error must be visible");
				assert.ok(panel.render(16).every((line: string) => visibleWidth(line) <= 16), "narrow rendering must fit");
			}
		}
		const success = { content: [{ type: "text", text: "answer" }], details: { ok: true, answer: "answer" } };
		const panel = tool.renderResult(success, { expanded: false, isPartial: false }, theme, { state: {}, isError: false });
		assert.equal(panel.render(100).join("\n").includes("answer"), true, "collapsed success must show an answer preview");
		const expanded = tool.renderResult(success, { expanded: true, isPartial: false }, theme, { state: {}, lastComponent: panel, isError: false });
		assert.ok(expanded.render(100).join("\n").includes("answer"));
		const archived = tool.renderResult({ details: { ok: true, sessionFile: "/private/session.jsonl", recordingError: "Recording incomplete" } }, { expanded: true, isPartial: false }, theme, { state: {}, isError: false });
		assert.ok(archived.render(100).join("\n").includes("Session: /private/session.jsonl"));
		assert.ok(archived.render(100).join("\n").includes("Recording incomplete"));
		assert.ok(archived.render(16).every((line: string) => visibleWidth(line) <= 16));
		const toolResult = handlers.get("tool_result");
		assert.deepEqual(toolResult?.({ toolName: "delegate", details: { ok: false } }), { isError: true });
		assert.equal(toolResult?.({ toolName: "delegate", details: { ok: true } }), undefined);
		assert.equal(toolResult?.({ toolName: "other", details: { ok: false } }), undefined);
		assert.equal(toolResult?.({ toolName: "delegate" }), undefined);
		await handlers.get("session_shutdown")?.();
		return { errorsVisible: true, hostErrorsMarked: true };
	});
}
