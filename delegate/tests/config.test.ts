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
	saveDelegateModel,
	type DelegateConfig,
} from "../config.ts";

const shippedPath = join(dirname(fileURLToPath(import.meta.url)), "..", "config.json");

function shipped(): DelegateConfig {
	return parseDelegateConfig(JSON.parse(readFileSync(shippedPath, "utf8")), shippedPath);
}

test("kind validation", () => {
	assert.equal(assertKind("recon"), "recon");
	assert.throws(() => assertKind("scout"), /kind must be/);
	assert.throws(() => assertKind("worker"), /kind must be/);
});

test("shipped config parses four agents", () => {
	const config = shipped();
	assert.equal(config.maxTaskChars, 20000);
	assert.equal(config.maxConcurrent, 8);
	assert.equal(config.maxLocalConcurrent, 1);
	assert.equal(config.maxQueued, 16);
	assert.equal(config.checkIntervalMs, 60000);
	assert.equal(config.hardTimeoutMs, 0);
	assert.equal(config.agents.recon.offline, true);
	assert.equal(config.agents.implement.offline, false);
	assert.ok(config.agents.implement.tools.includes("edit"));
	assert.equal(config.agents.review.thinking, "medium");
	assert.equal(config.agents.oracle.thinking, "high");
});

test("model override keeps agent tools and prompt kind", () => {
	const config = shipped();
	const resolved = resolveAgent("implement", "ollama/qwen3", config);
	assert.equal(resolved.model, "ollama/qwen3");
	assert.deepEqual(resolved.agent.tools, config.agents.implement.tools);
	assert.equal(resolved.agent.thinking, "low");
	assert.equal(resolveAgent("recon", "  ", config).model, config.agents.recon.model);
	assert.equal(resolveAgent("review", undefined, config).model, config.agents.review.model);
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
	assert.equal(merged.agents.recon.offline, true);
	assert.equal(merged.agents.implement.model, config.agents.implement.model);
});

test("unknown overlay agent refused", () => {
	assert.throws(
		() => mergeDelegateConfig(shipped(), { agents: { scout: { model: "x" } } }, "overlay.json"),
		/unknown agent/,
	);
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
		const patch = saveDelegateModel(paths, "recon", current, "hosted/first");
		assert.deepEqual(patch, { model: "hosted/first", offline: false });
		assert.deepEqual(JSON.parse(readFileSync(userPath, "utf8")), { agents: { recon: patch } });
		const overlay = { maxConcurrent: 3, note: "keep", agents: {
			recon: { ...patch, thinking: "medium", tools: ["read"], note: "keep role" }, review: { model: "other/review" },
		} };
		writeFileSync(userPath, JSON.stringify(overlay));
		const live = loadDelegateConfig(paths).agents.recon;
		const local = saveDelegateModel(paths, "recon", live, "ollama/team/model");
		assert.deepEqual(local, { model: "ollama/team/model", offline: false });
		assert.deepEqual(JSON.parse(readFileSync(userPath, "utf8")), { ...overlay, agents: {
			...overlay.agents, recon: { ...overlay.agents.recon, ...local },
		} });
		const before = readFileSync(userPath, "utf8");
		assert.throws(() => saveDelegateModel(paths, "recon", live, "hosted/stale"), /changed on disk/);
		assert.equal(readFileSync(userPath, "utf8"), before);
		for (const bad of ["{broken", '{"agents":{"recon":false}}']) {
			writeFileSync(userPath, bad);
			assert.throws(() => saveDelegateModel(paths, "recon", live, "hosted/new"));
			assert.equal(readFileSync(userPath, "utf8"), bad);
		}
		writeFileSync(userPath, before);
		if (process.platform !== "win32") {
			const link = join(dir, "linked.json"); symlinkSync(userPath, link);
			saveDelegateModel({ shippedPath, userPath: link }, "recon", loadDelegateConfig(paths).agents.recon, "hosted/symlink");
			assert.equal(lstatSync(link).isSymbolicLink(), true);
			assert.equal(loadDelegateConfig(paths).agents.recon.model, "hosted/symlink");
			const defaults = join(dir, "defaults.json"), alias = join(dir, "defaults-link.json");
			writeFileSync(defaults, readFileSync(shippedPath, "utf8")); symlinkSync(defaults, alias);
			assert.throws(() => saveDelegateModel({ shippedPath: defaults, userPath: alias }, "recon", current, "hosted/new"), /shipped delegate defaults/);
			assert.equal(readFileSync(defaults, "utf8"), readFileSync(shippedPath, "utf8"));
		}
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("broken shipped invariants refused", () => {
	const valid = shipped() as unknown as Record<string, unknown>;
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
