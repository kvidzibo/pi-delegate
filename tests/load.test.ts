import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO, runPiProbe } from "./pi-cli.ts";

test("package manifest loads only delegate through the installed Pi CLI", () => {
	const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { pi?: { extensions?: string[] } };
	assert.deepEqual(pkg.pi?.extensions, ["./delegate"]);
	assert.deepEqual(runPiProbe("delegate-load-probe").result, { tools: ["delegate"] });
});

test("real tool renderer displays errors and propagates failure to Pi", () => {
	assert.deepEqual(runPiProbe("delegate-view-probe").result, { errorsVisible: true, hostErrorsMarked: true });
});
