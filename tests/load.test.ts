import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(REPO, "package.json");

type LoadResult = {
	errors: Array<{ path: string; error: string }>;
	extensions: Array<{
		path: string;
		tools: Map<string, unknown>;
		handlers: Map<string, unknown>;
	}>;
};

function resolvePiLoader(): string {
	const piBin = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
	const dir = dirname(piBin);
	const candidates = [
		join(dir, "core", "extensions", "loader.js"),
		join(dir, "..", "core", "extensions", "loader.js"),
	];
	const loader = candidates.find((path) => existsSync(path));
	if (!loader) throw new Error(`Pi extension loader not found from ${piBin}`);
	return loader;
}

async function loadWithPi(paths: string[]): Promise<LoadResult> {
	const { loadExtensions } = await import(pathToFileURL(resolvePiLoader()).href);
	return loadExtensions(paths, REPO);
}

function toolsFor(result: LoadResult, suffix: string): string[] {
	const ext = result.extensions.find((item) => item.path.endsWith(suffix));
	assert.ok(ext, `missing loaded extension ending ${suffix}`);
	return [...ext.tools.keys()];
}

test("package manifest factory-loads only delegate", async () => {
	process.env.PI_DELEGATE_SKIP_USER_CONFIG = "1";
	delete process.env.PI_DELEGATE_CHILD;
	delete process.env.PI_DELEGATE_CHILD_DEPTH;
	const pkg = JSON.parse(readFileSync(MANIFEST, "utf8")) as { pi?: { extensions?: string[] } };
	assert.deepEqual(pkg.pi?.extensions, ["./delegate"]);
	const paths = (pkg.pi?.extensions ?? []).map((rel) => join(REPO, rel));
	const result = await loadWithPi(paths);
	assert.deepEqual(
		result.errors,
		[],
		result.errors.map((item) => `${item.path}: ${item.error}`).join("\n"),
	);
	assert.equal(result.extensions.length, 1);
	assert.deepEqual(toolsFor(result, "/delegate"), ["delegate"]);
});
