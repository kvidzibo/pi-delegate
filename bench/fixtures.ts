import { fingerprint } from "../delegate/calibration.ts";

export const fixtureFiles: Record<string, string> = {
	"package.json": JSON.stringify({ name: "calibration-fixture", scripts: { test: "node --test tests/*.test.js", check: "node tools/check.js" } }),
	"config/runtime.json": JSON.stringify({ workers: 6, retries: 3, storage: "/var/lib/fixture" }),
	"src/cache.js": 'export const cacheTtl = Number(process.env.CACHE_TTL_SECONDS ?? 90);\n',
	"src/http/routes.js": 'export const routes = [{ method: "PATCH", path: "/v2/widgets/:id", handler: "updateWidget" }];\n',
	"src/auth/token.js": 'export class ExpiredSessionError extends Error {}\nexport function checkToken(t, now) { if (now >= t.expires) throw new ExpiredSessionError(); }\n',
	"src/report.js": 'export class ReportWriter { flush() { return "written"; } }\n',
	"src/catalog.js": 'export function findProduct(code) { return { code }; }\n',
	"src/service.js": 'import { findProduct } from "./catalog.js";\nexport function resolveItem(code) { return findProduct(code); }\n',
	"src/storage.js": 'import config from "../config/runtime.json" with { type: "json" };\nexport const storageDir = process.env.STORAGE_DIR || config.storage;\n',
	"docs/old-config.md": 'Historical notes, not current configuration: workers=2, storage=/tmp/old, retry=7.\n',
};
export type FixtureTask = { id: string; question: string; expected: { path: string; value: string | number } };
export const fixtureTasks: FixtureTask[] = [
	{ id: "workers", question: "Find the configured worker count in the runtime JSON.", expected: { path: "config/runtime.json", value: 6 } },
	{ id: "cache-env", question: "Find the environment variable controlling cache TTL.", expected: { path: "src/cache.js", value: "CACHE_TTL_SECONDS" } },
	{ id: "route", question: "Find the widget-update route. Return its source file path and the HTTP method followed by a space and the route.", expected: { path: "src/http/routes.js", value: "PATCH /v2/widgets/:id" } },
	{ id: "expiry-error", question: "Find the exception class thrown when a session token expires.", expected: { path: "src/auth/token.js", value: "ExpiredSessionError" } },
	{ id: "report-method", question: "Find the class-qualified method that writes a report, formatted Class.method.", expected: { path: "src/report.js", value: "ReportWriter.flush" } },
	{ id: "catalog-trace", question: "Trace resolveItem in service.js to the catalog function it calls. Return the catalog source path and function name.", expected: { path: "src/catalog.js", value: "findProduct" } },
	{ id: "storage-default", question: "Trace storageDir to its default when STORAGE_DIR is unset. Return the configuration file defining that value and the directory string.", expected: { path: "config/runtime.json", value: "/var/lib/fixture" } },
	{ id: "test-command", question: "Find the package's test command.", expected: { path: "package.json", value: "node --test tests/*.test.js" } },
];
export const taskPrompt = (task: FixtureTask): string => `${task.question}\nInspect the files; do not edit anything. Return ONLY a JSON object with exactly two keys: path (repository-relative FILE path, not an HTTP path), and value (the requested value). No markdown or prose.`;
export const suiteHash = fingerprint(JSON.stringify({ version: 1, files: fixtureFiles, tasks: fixtureTasks, contract: taskPrompt(fixtureTasks[0]) }));
export function scoreAnswer(task: FixtureTask, answer: string): boolean {
	try {
		const value = JSON.parse(answer.trim());
		return value && !Array.isArray(value) && Object.keys(value).length === 2 && value.path === task.expected.path && value.value === task.expected.value;
	} catch { return false; }
}
