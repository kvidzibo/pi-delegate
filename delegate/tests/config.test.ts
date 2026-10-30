import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
	assertKind,
	loadDelegateConfig,
	mergeDelegateConfig,
	parseDelegateConfig,
	resolveAgent,
	saveDelegatePatch,
	type DelegateConfig,
} from "../config.ts";

const shippedPath = join(dirname(fileURLToPath(import.meta.url)), "..", "config.json");

function shipped(): DelegateConfig {
	return parseDelegateConfig(JSON.parse(readFileSync(shippedPath, "utf8")), shippedPath);
}

test("kind validation", () => {
	assert.equal(assertKind("recon"), "recon");
	assert.equal(assertKind("scout"), "scout");
	assert.equal(assertKind("docs"), "docs");
	for (const kind of ["", "../role", "__proto__", "a".repeat(65), 1]) assert.throws(() => assertKind(kind), /kind must/);
});

test("shipped config parses four agents", () => {
	const config = shipped();
	assert.deepEqual(Object.keys(config.agents), ["recon", "implement", "review", "oracle"]);
	assert.equal(config.maxTaskChars, 20000);
	assert.equal(config.maxConcurrent, 8);
	assert.equal(config.maxLocalConcurrent, 1);
	assert.equal(config.maxQueued, 16);
	assert.equal(config.checkIntervalMs, 60000);
	assert.equal(config.hardTimeoutMs, 0);
	assert.equal("offline" in config.agents.recon, false);
	assert.equal("offline" in config.agents.implement, false);
	assert.ok(config.agents.implement.tools.includes("edit"));
	assert.equal(config.agents.implement.model, "openai-codex/gpt-6.1-sol");
	assert.equal(config.agents.implement.thinking, "medium");
	assert.equal(config.agents.review.model, "openai-codex/gpt-6.1-sol");
	assert.equal(config.agents.review.thinking, "high");
	assert.equal(config.agents.oracle.thinking, "high");
});

test("model override keeps agent tools and prompt kind", () => {
	const config = shipped();
	const resolved = resolveAgent("implement", "ollama/qwen3", config);
	assert.equal(resolved.model, "ollama/qwen3");
	assert.deepEqual(resolved.agent.tools, config.agents.implement.tools);
	assert.equal(resolved.agent.prompt, config.agents.implement.prompt);
	assert.equal(resolved.agent.thinking, "medium");
	assert.equal(resolveAgent("recon", "  ", config).model, config.agents.recon.model);
	assert.equal(resolveAgent("review", undefined, config).model, config.agents.review.model);
});

test("disabled roles reject launches and overrides while other roles and explicit re-enabling work", () => {
	const base = shipped();
	assert.equal(base.agents.implement.enabled, true);
	assert.deepEqual(base.agents.review.tools, ["read", "grep", "find", "ls", "bash"]);
	const disabled = mergeDelegateConfig(base, { agents: { implement: { enabled: false } } }, "overlay.json");
	for (const model of [undefined, "hosted/override"]) {
		assert.throws(() => resolveAgent("implement", model, disabled), /implement is disabled/);
	}
	assert.equal(resolveAgent("review", undefined, disabled).model, base.agents.review.model);
	const enabled = mergeDelegateConfig(disabled, { agents: { implement: { enabled: true } } }, "overlay.json");
	assert.equal(resolveAgent("implement", undefined, enabled).agent.enabled, true);
	for (const enabled of [null, "false", 0]) {
		assert.throws(() => mergeDelegateConfig(base, { agents: { implement: { enabled } } }, "bad"), /enabled.*boolean/);
	}
});

test("any model id is allowed", () => {
	const config = shipped();
	assert.equal(resolveAgent("oracle", "local-qwen38/qwen38-q4km", config).model, "local-qwen38/qwen38-q4km");
	assert.equal(resolveAgent("recon", "openai-codex/gpt-5.6-luna", config).model, "openai-codex/gpt-5.6-luna");
});

test("user overlay overrides one model", () => {
	const config = shipped();
	const merged = mergeDelegateConfig(
		config,
		{ maxLocalConcurrent: 1, agents: { recon: { model: "ollama/qwen3" } } },
		"overlay.json",
	);
	assert.equal(merged.maxLocalConcurrent, 1);
	assert.equal(merged.maxQueued, config.maxQueued);
	assert.equal(merged.agents.recon.model, "ollama/qwen3");
	assert.deepEqual(merged.agents.recon.tools, config.agents.recon.tools);
	assert.equal("offline" in merged.agents.recon, false);
	assert.equal(merged.agents.implement.model, config.agents.implement.model);
});

test("legacy context settings are accepted but ignored in defaults and overlays", () => {
	const base = shipped();
	for (const context of [[], ["git-diff"], [{ source: "git-changed-files" }], "obsolete", null]) {
		const legacy = { ...base, agents: { ...base.agents, review: { ...base.agents.review, context } } };
		assert.deepEqual(parseDelegateConfig(legacy, "legacy.json"), base);
		assert.deepEqual(mergeDelegateConfig(base, { agents: { review: { context } } }, "overlay.json"), base);
	}
	for (const offline of [true, false, "obsolete"]) {
		const legacy = { ...base, agents: { ...base.agents, recon: { ...base.agents.recon, offline } } };
		assert.deepEqual(parseDelegateConfig(legacy, "legacy.json"), base);
		assert.deepEqual(mergeDelegateConfig(base, { agents: { recon: { offline } } }, "overlay.json"), base);
	}
});

test("new overlay agents require a model and prompt", () => {
	assert.throws(
		() => mergeDelegateConfig(shipped(), { agents: { scout: { model: "x" } } }, "overlay.json"),
		/prompt/,
	);
	assert.throws(() => resolveAgent("missing", undefined, shipped()), /unknown role/);
	assert.throws(() => resolveAgent("constructor", undefined, shipped()), /unknown role/);
});

test("load uses shipped when user file missing", () => {
	const loaded = loadDelegateConfig({
		shippedPath,
		userPath: join(tmpdir(), "pi-delegate-missing-user.json"),
	});
	assert.deepEqual(loaded, shipped());
});

test("load merges user overlay file", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-delegate-config-"));
	const userPath = join(dir, "delegate.json");
	writeFileSync(userPath, JSON.stringify({ agents: { implement: { model: "llama.cpp/qwen" } } }));
	const loaded = loadDelegateConfig({ shippedPath, userPath });
	assert.equal(loaded.agents.implement.model, "llama.cpp/qwen");
	assert.equal(loaded.agents.recon.model, shipped().agents.recon.model);
});

test("model saves preserve overlays, reject stale/invalid config, and keep symlink targets", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-delegate-model-config-"));
	const userPath = join(dir, "delegate.json");
	const paths = { shippedPath, userPath };
	try {
		const current = shipped().agents.recon;
		const patch = { model: "hosted/first" };
		saveDelegatePatch(paths, "recon", current, patch);
		assert.deepEqual(JSON.parse(readFileSync(userPath, "utf8")), { agents: { recon: patch } });
		const overlay = { maxConcurrent: 3, note: "keep", agents: {
			recon: { ...patch, prompt: "Custom recon prompt\nPreserve this text.", thinking: "medium", tools: ["read"], context: ["git-diff"], note: "keep role", offline: true }, review: { model: "other/review" },
			docs: { model: "hosted/docs", prompt: "Write documentation.", context: [{ source: "git-changed-files" }] },
		} };
		writeFileSync(userPath, JSON.stringify(overlay));
		const live = loadDelegateConfig(paths).agents.recon;
		const local = { model: "ollama/team/model" };
		saveDelegatePatch(paths, "recon", live, local);
		assert.deepEqual(JSON.parse(readFileSync(userPath, "utf8")), { ...overlay, agents: {
			...overlay.agents, recon: { ...overlay.agents.recon, ...local },
		} });
		const before = readFileSync(userPath, "utf8");
		assert.throws(() => saveDelegatePatch(paths, "recon", live, { model: "hosted/stale" }), /changed on disk/);
		assert.equal(readFileSync(userPath, "utf8"), before);
		for (const bad of ["{broken", '{"agents":{"recon":false}}']) {
			writeFileSync(userPath, bad);
			assert.throws(() => saveDelegatePatch(paths, "recon", live, { model: "hosted/new" }));
			assert.equal(readFileSync(userPath, "utf8"), bad);
		}
		writeFileSync(userPath, before);
		if (process.platform !== "win32") {
			const link = join(dir, "linked.json"); symlinkSync(userPath, link);
			saveDelegatePatch({ shippedPath, userPath: link }, "recon", loadDelegateConfig(paths).agents.recon, { model: "hosted/symlink" });
			assert.equal(lstatSync(link).isSymbolicLink(), true);
			assert.equal(loadDelegateConfig(paths).agents.recon.model, "hosted/symlink");
			const defaults = join(dir, "defaults.json"), alias = join(dir, "defaults-link.json");
			writeFileSync(defaults, readFileSync(shippedPath, "utf8")); symlinkSync(defaults, alias);
			assert.throws(() => saveDelegatePatch({ shippedPath: defaults, userPath: alias }, "recon", current, { model: "hosted/new" }), /shipped delegate defaults/);
			assert.equal(readFileSync(defaults, "utf8"), readFileSync(shippedPath, "utf8"));
		}
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("reasoning saves only thinking and refuses stale reasoning without writing", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-delegate-thinking-"));
	const paths = { shippedPath, userPath: join(dir, "delegate.json") };
	try {
		const overlay = { note: "keep", agents: { recon: { model: "hosted/unchanged", thinking: "low", prompt: "Custom prompt", offline: false, tools: ["read"], context: ["git-diff"] } } };
		writeFileSync(paths.userPath, JSON.stringify(overlay));
		const current = loadDelegateConfig(paths).agents.recon;
		saveDelegatePatch(paths, "recon", current, { thinking: "xhigh" });
		assert.equal(loadDelegateConfig(paths).agents.recon.thinking, "xhigh");
		assert.deepEqual(JSON.parse(readFileSync(paths.userPath, "utf8")), {
			...overlay, agents: { recon: { ...overlay.agents.recon, thinking: "xhigh" } },
		});
		assert.equal(current.thinking, "low");
		const before = readFileSync(paths.userPath, "utf8");
		assert.throws(() => saveDelegatePatch(paths, "recon", current, { thinking: "off" }), /changed on disk/);
		assert.equal(readFileSync(paths.userPath, "utf8"), before);
		const changedModel = JSON.stringify({ ...overlay, agents: { recon: { ...overlay.agents.recon, model: "hosted/changed" } } });
		writeFileSync(paths.userPath, changedModel);
		assert.throws(() => saveDelegatePatch(paths, "recon", current, { thinking: "max" }), /changed on disk/);
		assert.equal(readFileSync(paths.userPath, "utf8"), changedModel);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("broken shipped invariants refused", () => {
	const config = shipped();
	for (const prompt of [null, "", " \n\t", 42, [], {}]) {
		assert.throws(() => mergeDelegateConfig(config, { agents: { recon: { prompt } } }, "bad"), /prompt.*non-empty string/);
	}
	for (const extensions of [null, "true", 1, []]) {
		assert.throws(() => mergeDelegateConfig(config, { agents: { recon: { extensions } } }, "bad"), /extensions.*boolean/);
	}
	const { prompt: _prompt, ...withoutPrompt } = config.agents.recon;
	assert.throws(() => parseDelegateConfig({ ...config, agents: { ...config.agents, recon: withoutPrompt } }, "bad"), /prompt.*non-empty string/);
	const valid = config as unknown as Record<string, unknown>;
	assert.throws(
		() => parseDelegateConfig({ ...valid, maxTaskChars: 0 }, "x"),
		/maxTaskChars/,
	);
	assert.throws(
		() => parseDelegateConfig({ ...valid, maxLocalConcurrent: 0 }, "x"),
		/maxLocalConcurrent/,
	);
	assert.throws(
		() =>
			parseDelegateConfig(
				{ ...valid, agents: { ...(valid.agents as object), recon: { model: "", tools: ["read"], thinking: "off" } } },
				"x",
			),
		/model/,
	);
});
