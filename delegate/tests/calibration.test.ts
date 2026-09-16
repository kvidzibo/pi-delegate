import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { estimateRequest, fingerprint, fitCalibration, keyId, loadSavingsSnapshot, priceTokens, snapshotPricing, validProfile, validSnapshot } from "../calibration.ts";
import { UsageMeter, sessionUsage, validUsage } from "../usage.ts";
import { ArchivedRun, loadRuns } from "../archive.ts";
import { infobar, savingsTotals, statsReport } from "../stats.ts";
import { loadDelegateConfig, mergeDelegateConfig } from "../config.ts";
import { key, pricing, samples, savings, tokens } from "./calibration-fixtures.ts";

function temp(t: any) { const dir = mkdtempSync(join(tmpdir(), "delegate-calibration-test-")); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
const message = (usage = tokens(100, 20, 100), model = key.localModel) => ({ role: "assistant", provider: model.split("/")[0], model: model.split("/").slice(1).join("/"), usage, timestamp: 1 });

test("successful-pair fit retains failures, rejects duplicates/undersampling, separates caches and reasoning", () => {
	const rows = samples(); rows.push({ ...rows[0], taskId: "failed", alternative: { ...rows[0].alternative, passed: false } });
	const p = fitCalibration(key, fingerprint("suite"), rows);
	assert.equal(p.promptRatio, 0.5); assert.equal(p.outputRatio, 0.5); assert.equal(p.cacheReadShare, 0.5);
	assert.equal(p.acceptedPairs, 4); assert.equal(p.pairs, 5); assert.equal(p.alternativeFailures, 1);
	assert.ok(validProfile(p)); assert.equal(keyId({ ...key, tools: [...key.tools].reverse() }), p.id);
	assert.throws(() => fitCalibration(key, fingerprint("suite"), rows.concat(rows[0])), /Duplicate/);
	assert.throws(() => fitCalibration(key, fingerprint("suite"), samples().slice(0, 3)), /four distinct/);
	assert.throws(() => fitCalibration(key, fingerprint("suite"), samples().map((r,i) => ({ ...r, taskId: "same", repeat: i }))), /distinct/);
	assert.equal(validProfile({ ...p, outputRatio: NaN }), false);
	assert.equal(validProfile({ ...p, cacheWriteShare: 0.6 }), false);
	assert.equal(validSnapshot({ ...savings(), pricing: { ...pricing, input: 0 } }), false);
});

test("API valuation uses learned cache mix, per-request tiers, and rejects unknown price metadata", () => {
	const s = savings();
	assert.equal(estimateRequest(tokens(0, 20, 200), key.localModel, s), 0.00021, "local KV hits do not become API cache hits");
	assert.equal(estimateRequest(tokens(200, 20), "ollama/other", s), undefined);
	assert.equal(snapshotPricing({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), undefined);
	assert.equal(snapshotPricing({ ...pricing, secret: "not copied" })?.["secret" as keyof typeof pricing], undefined);
	const tiered = { ...pricing, tiers: [{ ...pricing, inputTokensAbove: 100, input: 4 }] };
	assert.equal(priceTokens(tokens(100, 0), tiered), 0.0002);
	assert.equal(priceTokens(tokens(101, 0), tiered), 0.000404);
	assert.notEqual(priceTokens(tokens(80, 0), tiered) * 2, priceTokens(tokens(160, 0), tiered));
});

test("profile lookup matches model/kind/thinking/tools/prompt and age; snapshots are immutable copies", (t) => {
	const dir = temp(t), file = join(dir, "profile.json"), now = new Date();
	const s = savings(now); writeFileSync(file, JSON.stringify(s.profile));
	const input = { key, files: [file], pricing, now };
	const loaded = loadSavingsSnapshot(input); assert.ok(loaded.snapshot);
	s.profile.promptRatio = 9; assert.equal(loaded.snapshot.profile.promptRatio, 0.5);
	for (const patch of [{ localThinking: "low" }, { alternativeThinking: "high" }, { kind: "review" }, { tools: ["bash"] }, { promptHash: fingerprint("other") }, { alternativeModel: "xai/grok" }]) {
		assert.equal(loadSavingsSnapshot({ ...input, key: { ...key, ...patch } }).snapshot, undefined);
	}
	assert.equal(loadSavingsSnapshot({ ...input, now: new Date(now.getTime() + 91 * 86400000) }).snapshot, undefined);
	assert.equal(loadSavingsSnapshot({ ...input, now: new Date(now.getTime() - 1) }).snapshot, undefined);
	writeFileSync(file, "bad json"); assert.match(loadSavingsSnapshot(input).reason!, /invalid/);
	writeFileSync(file, " ".repeat(300000)); assert.equal(loadSavingsSnapshot(input).snapshot, undefined);
	assert.equal(loadSavingsSnapshot({ ...input, files: [dir] }).snapshot, undefined);
});

test("streaming estimates replace pending usage; finalized turns, retries and model mismatch count once", () => {
	const meter = new UsageMeter(key.localModel, savings());
	const m = message();
	meter.observe({ type: "message_start", message: m });
	meter.observe({ type: "message_update", usage: m.usage });
	meter.observe({ type: "message_update", usage: m.usage });
	assert.equal(meter.snapshot().estimate?.requests, 1);
	meter.observe({ type: "message_end", message: m }); meter.observe({ type: "message_end", message: m });
	meter.observe({ type: "agent_end", messages: [m] });
	assert.equal(meter.snapshot().estimate?.requests, 1);
	meter.observe({ type: "message_start", message: message(tokens(2, 1), "ollama/other") });
	meter.observe({ type: "message_end", message: message(tokens(2, 1), "ollama/other") });
	assert.equal(meter.snapshot().estimate?.unpriced, 1);
	assert.ok(validUsage(meter.snapshot()));
	assert.equal(validUsage({ ...meter.snapshot(), estimate: { usd: -1, requests: 1, unpriced: 0 } }), false);
});

test("missing final usage keeps observed partial estimate but cannot earn completed savings", () => {
	const meter = new UsageMeter(key.localModel, savings()), m = message();
	meter.observe({ type: "message_start", message: m });
	meter.observe({ type: "message_update", usage: m.usage });
	const before = meter.snapshot().estimate!.usd;
	meter.observe({ type: "message_end", message: { ...m, usage: {} } });
	const after = meter.snapshot();
	assert.equal(after.estimate!.usd, before); assert.equal(after.estimate!.requests, 1);
	assert.equal(after.estimate!.unpriced, 1); assert.equal(after.incomplete, true);
});

test("zero prompt/output calibration denominators fail without producing a profile", () => {
	for (const tok of [tokens(0, 1), tokens(1, 0)]) {
		const rows = samples().map(s => ({ ...s, local: { ...s.local, tokens: tok } }));
		assert.throws(() => fitCalibration(key, fingerprint("suite"), rows), /Invalid calibration/);
	}
});

test("native reconstruction and archive reload/rebuild preserve captured prices, never backfill legacy runs", async t => {
	const dir = temp(t), prompt = join(dir, "prompt.md"); writeFileSync(prompt, "prompt");
	const archive = new ArchivedRun(dir, { parentSessionId: "p", toolCallId: "t", kind: "recon", cwd: dir,
		requestedModel: key.localModel, thinking: "off", tools: ["read"], savings: savings() }, "task", prompt);
	archive.start("d1"); const m = message();
	appendFileSync(archive.paths.session, JSON.stringify({ type: "message", id: "m1", message: m }) + "\n");
	archive.observe({ type: "message_end", message: m }); archive.observe({ type: "agent_settled" });
	await archive.finish({ status: "done" });
	assert.equal(archive.data.usage.estimate?.usd, 0.00021);
	const before = infobar([archive.data]); assert.match(before, /saved ~<\$0.001/);
	const runs = (await loadRuns(dir, { rebuild: true })).runs;
	assert.equal(infobar(runs), before); assert.equal(savingsTotals([...runs, ...runs]).priced, 1);
	assert.ok(statsReport(runs, dir, "all").includes("Prompt/output ratios 0.500/0.500"));
	const saved = JSON.parse(readFileSync(archive.paths.metadata, "utf8"));
	delete saved.savings; writeFileSync(archive.paths.metadata, JSON.stringify(saved));
	assert.equal((await loadRuns(dir)).runs[0].usage.estimate, undefined);
	saved.savings = { nonsense: true }; writeFileSync(archive.paths.metadata, JSON.stringify(saved));
	assert.match((await loadRuns(dir)).runs[0].savingsUnavailable!, /Invalid/);
	assert.equal((await sessionUsage(archive.paths.session, key.localModel)).estimate, undefined);
	const pending = { ...archive.data, status: "running" as const };
	assert.equal(savingsTotals([pending]).priced, 0);
	assert.equal(savingsTotals([pending]).eligible, 0);
	assert.equal(infobar([archive.data, { ...pending, runId: "pending" }]).includes("!estimate"), false);
	assert.equal(savingsTotals([{ ...archive.data, status: "failed" }]).priced, 0);
	assert.match(infobar([archive.data, { ...archive.data, runId: "other", savings: undefined }]), /!estimate/);
});

for (const delivery of ["progress", "result"] as const) {
	test(`guarded execution invalidates legacy calibration via ${delivery}, including archive rebuild`, async t => {
		const dir = temp(t), prompt = join(dir, "prompt.md"); writeFileSync(prompt, "prompt");
		const archive = new ArchivedRun(dir, { parentSessionId: "p", toolCallId: "t", kind: "recon", cwd: dir,
			requestedModel: key.localModel, thinking: "off", tools: ["read"], savings: savings() }, "task", prompt);
		archive.start("d1"); const m = message();
		appendFileSync(archive.paths.session, JSON.stringify({ type: "message", id: "m1", message: m }) + "\n");
		archive.observe({ type: "message_end", message: m });
		const finalization = { phase: "running" as const, activeTools: 0 };
		if (delivery === "progress") {
			archive.observe({ type: "delegate_finalization", state: finalization });
			assert.equal(archive.meter.snapshot().estimate, undefined);
		}
		archive.observe({ type: "agent_settled" });
		await archive.finish({ status: "done", ...(delivery === "result" ? { finalization } : {}) });
		assert.equal(archive.data.usage.local.total, 220); assert.equal(archive.data.usage.incomplete, false);
		assert.equal(archive.data.usage.estimate, undefined); assert.equal(archive.data.savings, undefined);
		assert.match(archive.data.savingsUnavailable!, /guarded execution/);
		assert.equal(savingsTotals([archive.data]).priced, 0);
		// Even a stale/hand-edited saved pricing snapshot must not be reused for guarded metadata.
		const saved = JSON.parse(readFileSync(archive.paths.metadata, "utf8")); saved.savings = savings();
		writeFileSync(archive.paths.metadata, JSON.stringify(saved));
		const loaded = (await loadRuns(dir, { rebuild: true })).runs[0];
		assert.deepEqual(loaded.finalization, finalization); assert.equal(loaded.usage.estimate, undefined);
		assert.equal(loaded.savings, undefined); assert.equal(savingsTotals([loaded]).priced, 0);
	});
}

test("alternative config is backwards-compatible and overlays replace maps explicitly", () => {
	const base = loadDelegateConfig({ shippedPath: new URL("../config.json", import.meta.url).pathname });
	const next = mergeDelegateConfig(base, { localAlternatives: { "ollama/qwen": "openai/luna" }, calibrationProfiles: ["/tmp/profile.json"] }, "test");
	assert.deepEqual(next.localAlternatives["ollama/qwen"], { model: "openai/luna", thinking: "low" });
	assert.equal(next.localAlternatives[key.localModel], undefined);
	assert.throws(() => mergeDelegateConfig(base, { calibrationProfiles: ["relative.json"] }, "test"), /absolute/);
	assert.throws(() => mergeDelegateConfig(base, { localAlternatives: { "ollama/qwen": "ollama/other" } }, "test"), /localAlternatives/);
	assert.throws(() => mergeDelegateConfig(base, { localAlternatives: [] }, "test"), /object/);
	assert.deepEqual(mergeDelegateConfig(base, { localAlternatives: {}, calibrationProfiles: [] }, "test").calibrationProfiles, []);
});
