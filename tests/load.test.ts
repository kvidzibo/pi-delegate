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

test("native sessions and real extension infobar/commands work without model calls", async () => {
	assert.deepEqual((await runPiProbe("delegate-accounting-probe")).result, { nativeSession: true, infobar: true, noModelCalls: true, resume: true });
});

test("real tool renderer displays errors and propagates failure to Pi", async () => {
	assert.deepEqual((await runPiProbe("delegate-view-probe")).result, { errorsVisible: true, hostErrorsMarked: true });
});

test("job cards update without collection, restore safely and render compact receipts", async () => {
	assert.deepEqual((await runPiProbe("delegate-card-probe")).result, {
		liveCard: true, receipts: true, previews: true, restoration: true, cancellation: true, emptyFailures: true, noModelCalls: true,
	});
});
