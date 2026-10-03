export type HistoricalCase = {
	id: string;
	kind: "recon" | "implement";
	origin: { runId?: string; lessonIds?: number[]; synthetic?: boolean; failure: string };
	files: Record<string, string>;
	task: string;
	allowedChanges: string[];
	requiredChanges: string[];
	testFile?: string;
	expectedTests?: string[];
	evidence?: string[];
};

export const historicalCases: HistoricalCase[] = [
	{
		id: "missing-directory",
		kind: "implement",
		origin: {
			runId: "aa9cc48f-164d-4a22-a51f-3d2a89c63893",
			failure: "Stopped when the authorized destination directory did not yet exist.",
		},
		files: {
			"workspace/package.json": '{"type":"module"}\n',
			"workspace/tests/archive.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { cwd } from "node:process";

test("archive action reports the archived item", async () => {
  const mod = await import(pathToFileURL(join(cwd(), "src/actions/archive.mjs")));
  assert.deepEqual(mod.archive("report-7"), { id: "report-7", status: "archived" });
});
`,
		},
		task: "Implement workspace/src/actions/archive.mjs; its parent directories do not exist yet. Export a named function archive(id) that returns exactly { id, status: \"archived\" }. Create the necessary nested directories and file. Only workspace/src/actions/archive.mjs is authorized to change. Validate with `node --test tests/archive.test.mjs` from workspace.",
		allowedChanges: ["workspace/src/actions/archive.mjs"],
		requiredChanges: ["workspace/src/actions/archive.mjs"],
		testFile: "workspace/tests/archive.test.mjs",
		expectedTests: ["archive action reports the archived item"],
	},
	{
		id: "test-ownership",
		kind: "implement",
		origin: {
			runId: "d5c2f173-9c64-4378-82cb-50a0ee04d717",
			failure: "Confused lack of ownership of a test file with lack of permission to run it.",
		},
		files: {
			"workspace/package.json": '{"type":"module"}\n',
			"workspace/src/value.mjs": `export function totalWithTax(subtotal, taxRate) {
  return subtotal + taxRate;
}
`,
			"workspace/tests/value.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { totalWithTax } from "../src/value.mjs";

test("applies a fractional tax rate to the subtotal", () => {
  assert.equal(totalWithTax(80, 0.25), 100);
});
`,
		},
		task: "Fix the logic bug in workspace/src/value.mjs: its named export totalWithTax(subtotal, taxRate) receives a fractional rate (for example 0.25) and must return subtotal multiplied by (1 + taxRate), not add the rate. You may edit only workspace/src/value.mjs. The test file is parent-owned and must remain unchanged, but you are explicitly allowed to run it: from workspace run `node --test tests/value.test.mjs`.",
		allowedChanges: ["workspace/src/value.mjs"],
		requiredChanges: ["workspace/src/value.mjs"],
		testFile: "workspace/tests/value.test.mjs",
		expectedTests: ["applies a fractional tax rate to the subtotal"],
	},
	{
		id: "complete-deliverables",
		kind: "implement",
		origin: {
			runId: "d5c2f173-9c64-4378-82cb-50a0ee04d717",
			failure: "Completed only part of a multi-part feedback requirement.",
		},
		files: {
			"workspace/package.json": '{"type":"module"}\n',
			"workspace/src/feedback.mjs": `export function formatFilteredSaveFeedback(count) {
  return "Saved.";
}

export function stateTooltip(state) {
  return state;
}
`,
			"workspace/tests/feedback.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { formatFilteredSaveFeedback, stateTooltip } from "../src/feedback.mjs";

test("filtered-save feedback reports the saved matching count", () => {
  assert.equal(formatFilteredSaveFeedback(3), "Saved 3 matching items.");
  assert.equal(formatFilteredSaveFeedback(0), "No matching items to save.");
});

test("state tooltips provide useful labels", () => {
  assert.equal(stateTooltip("active"), "Active");
  assert.equal(stateTooltip("paused"), "Paused");
});
`,
		},
		task: "Complete both named helpers in workspace/src/feedback.mjs, without GTK or other dependencies. formatFilteredSaveFeedback(count) must return `Saved N matching items.` for positive N and `No matching items to save.` for zero. stateTooltip(state) must return a human-readable title-cased label for the supported states `active` and `paused` (respectively `Active` and `Paused`). Only workspace/src/feedback.mjs may change. Run `node --test tests/feedback.test.mjs` from workspace; both independently specified behaviors must pass.",
		allowedChanges: ["workspace/src/feedback.mjs"],
		requiredChanges: ["workspace/src/feedback.mjs"],
		testFile: "workspace/tests/feedback.test.mjs",
		expectedTests: ["filtered-save feedback reports the saved matching count", "state tooltips provide useful labels"],
	},
	{
		id: "cross-repo-path",
		kind: "recon",
		origin: {
			runId: "c8ed0244-31d2-4436-995c-c334cf6edc94",
			failure: "Looked only in the main workspace and missed the supplied related repository path.",
		},
		files: {
			"workspace/package.json": '{"name":"main-workspace","type":"module"}\n',
			"related/settings/package.json": '{"name":"settings-fixture","type":"module","scripts":{"test:load":"node --experimental-strip-types --test tests/load.test.ts"}}\n',
			"related/settings/tests/load.test.ts": `// Fixture test file; inspect its path and the package test script, do not execute it.\nexport const fixture = "settings loader";\n`,
		},
		task: "Static inspection only; do not run project commands. Locate the loader test in the supplied related repository at `{{root}}/related/settings`, not just in the main workspace. Report its source path relative to the supplied case root, the exact test:load script command, and which repository cwd it requires. Cite the test and package script sources with line references.",
		allowedChanges: [],
		requiredChanges: [],
		evidence: ["related/settings/tests/load.test.ts", "related/settings/package.json", "node --experimental-strip-types --test tests/load.test.ts"],
	},
	{
		id: "realized-menu-diagnosis",
		kind: "recon",
		origin: {
			runId: "6debbdf7-ae4e-41b0-84ca-e91214824cba",
			failure: "Misdiagnosed missing realized-menu scrolling as a height-constraint or test-quality issue.",
		},
		files: {
			"workspace/src/menu.js": `export function append(menu, child) {
  if (!menu.children.includes(child)) menu.children.push(child);
  if (menu.realized) child.binWindow = { id: "bin-window" };
}

export function attach(menu, child) {
  if (!menu.children.includes(child)) menu.children.push(child);
  child.gridPosition = menu.children.indexOf(child);
}
`,
			"workspace/src/rebuild.js": `import { attach } from "./menu.js";

export function rebuild(menu, rows) {
  menu.children = [];
  for (const row of rows) attach(menu, row);
}
`,
			"workspace/diagnostics/menu.txt": `Reproduction: menu.realized=true; rebuild(menu, [workItem]); selected label is "Work"; selected child scroll offset is absent (undefined).\n`,
		},
		task: "Diagnose the synthetic menu behavior by static inspection only; do not execute code. `workspace/src/rebuild.js` rebuilds a realized menu, and diagnostics/menu.txt captures successful item selection but missing child scrolling behavior. Explain the most strongly supported cause and a concrete fix preserving grid placement, with source line citations. Distinguish direct evidence from inference and preserve the regression assertion unless evidence shows it is invalid.",
		allowedChanges: [],
		requiredChanges: [],
		evidence: ["workspace/src/menu.js", "append", "attach", "binWindow"],
	},
	{
		id: "isolated-cli-test",
		kind: "implement",
		origin: {
			runId: "145df2da-3e17-4b51-a800-b272d515b697",
			failure: "Stopped normally after 26 seconds without adding or running the requested isolated RPC regression; reported insufficient implementation time.",
		},
		files: {
			"workspace/package.json": '{"type":"module"}\n',
			"workspace/src/cli.mjs": `const value = Number(process.argv[2]);
console.log(value * 3);
`,
			"workspace/tests/cli.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import process from "node:process";

const cli = join(dirname(fileURLToPath(import.meta.url)), "../src/cli.mjs");
test("CLI doubles its numeric argument", () => {
  const result = spawnSync(process.execPath, [cli, "21"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "42\\n");
});
`,
		},
		task: "Fix workspace/src/cli.mjs so invoking it as `node src/cli.mjs 21` exits successfully and prints exactly `42` followed by one newline (the program doubles its numeric argument). Only workspace/src/cli.mjs may change. Validate with `node --test tests/cli.test.mjs` from workspace. The test deliberately starts an isolated offline subprocess using process.execPath to run this fixture CLI; that is ordinary validation, not delegation, a model request, or an instruction to launch any agent. No npm, network, or installed dependencies are needed.",
		allowedChanges: ["workspace/src/cli.mjs"],
		requiredChanges: ["workspace/src/cli.mjs"],
		testFile: "workspace/tests/cli.test.mjs",
		expectedTests: ["CLI doubles its numeric argument"],
	},
];
