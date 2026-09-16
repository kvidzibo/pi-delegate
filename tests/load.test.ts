import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO, runPiProbe } from "./pi-cli.ts";

test("package manifest loads only delegate through the installed Pi CLI", async () => {
	const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { pi?: { extensions?: string[] } };
	assert.deepEqual(pkg.pi?.extensions, ["./delegate"]);
	assert.deepEqual((await runPiProbe("delegate-load-probe")).result, { tools: ["delegate"] });
});

test("local delegation picker uses native dialogs, drains work and gates model overrides without fallback", async () => {
	let selects = 0;
	const result = await runPiProbe("delegate-local-probe", ({ title, options }) => {
		selects++;
		assert.match(title, /All Pi sessions/);
		if (selects === 1) {
			assert.match(title, /ON · 1 job active/);
			assert.deepEqual(options, ["On ✓ current", "Off"]);
			return "Off";
		}
		assert.match(title, /OFF · idle/);
		assert.deepEqual(options, ["Off ✓ current", "On"]);
		return selects === 2 ? undefined : "On";
	});
	assert.equal(selects, 3);
	assert.deepEqual(result.result, { picker: true, shared: true, draining: true, overridesBlocked: true, hostedUnchanged: true, noModelCalls: true });
});

test("package reload restores a single delegate tool through the real session lifecycle", async () => {
	assert.deepEqual((await runPiProbe("delegate-reload-probe")).result, { tools: ["delegate"], reloaded: true, localOffPersists: true });
});

test("real isolated Pi child loads the explicit budget guard before any task is dispatched", async () => {
	assert.deepEqual((await runPiProbe("delegate-guard-startup-probe")).result, { guardLoaded: true, promptWithheld: true, noModelCalls: true });
});

test("explicit runtime guard preserves builtins, drains current tools and blocks prepared execution", async () => {
	assert.deepEqual((await runPiProbe("delegate-finalization-probe")).result, {
		realGuardHandshake: true, currentToolDrained: true, preparedToolBlocked: true,
		metadataPreserved: true, promptWithheld: true, noModelCalls: true,
	});
});

test("calibrated pricing resolves in the real factory, restores snapshots and loads opt-in benchmarking", async () => {
	assert.deepEqual((await runPiProbe("delegate-savings-probe")).result, {
		calibrated: true, snapshot: true, rebuild: true, noModelCalls: true, benchLoads: true,
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

test("all delegate return paths preserve result, promotion and notification contracts", async () => {
	assert.deepEqual((await runPiProbe("delegate-result-probe")).result, {
		terminalContracts: true, pendingContracts: true, promotion: true, notificationConsumption: true, wrapPreservation: true, finalizationProgress: true, noModelCalls: true,
	});
});

test("job cards finalize without collection, restore safely and render compact receipts", async () => {
	assert.deepEqual((await runPiProbe("delegate-card-probe")).result, {
		liveCard: true, receipts: true, previews: true, restoration: true, cancellation: true, emptyFailures: true, noModelCalls: true,
	});
});
