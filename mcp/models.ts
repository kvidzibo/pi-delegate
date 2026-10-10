import { access, readFile, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { THINKING_LEVELS, type ThinkingLevel } from "../delegate/config.ts";

export interface SettingsModel {
	id: string;
	label: string;
	available: boolean;
	thinking: ThinkingLevel[];
}

export interface SettingsCatalogue {
	models: SettingsModel[];
	warning?: string;
}

export type CatalogueLoader = (signal?: AbortSignal) => Promise<SettingsCatalogue>;

interface RuntimeModules {
	ModelRuntime: { create(options: Record<string, unknown>): Promise<RuntimeInstance> };
	getSupportedThinkingLevels(model: unknown): unknown;
}

interface RuntimeInstance {
	getModels(): readonly unknown[];
	getAvailableSnapshot(): readonly unknown[];
	getError(): string | undefined;
	refresh(options: { allowNetwork: false; signal?: AbortSignal }): Promise<unknown>;
}

const EMPTY_WARNING = "Could not load the configured Pi model catalogue; verify the Pi installation and agent settings.";
const RUNTIME_WARNING = "The configured Pi model catalogue is unavailable; verify the agent settings and try again.";
const moduleCache = new Map<string, Promise<RuntimeModules>>();

async function resolveExecutable(command: string): Promise<string | undefined> {
	if (!command.trim()) return undefined;
	const candidates = isAbsolute(command) || command.includes("/") || command.includes("\\")
		? [resolve(command)]
		: (process.env.PATH ?? "").split(delimiter).filter(Boolean).map(directory => join(directory, command));
	for (const candidate of candidates) {
		try {
			await access(candidate, constants.X_OK);
			if (!(await stat(candidate)).isFile()) continue;
			return await realpath(candidate);
		} catch { /* try the next PATH entry */ }
	}
	return undefined;
}

async function packageAt(directory: string): Promise<{ root: string; main: string } | undefined> {
	try {
		const root = await realpath(directory);
		const manifestPath = join(root, "package.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { name?: unknown; main?: unknown };
		if (manifest.name !== "@earendil-works/pi-coding-agent" || typeof manifest.main !== "string") return undefined;
		const main = await realpath(join(root, manifest.main));
		return { root, main };
	} catch { return undefined; }
}

async function discoverPackage(executable: string, explicitPackageDir?: string): Promise<{ root: string; main: string } | undefined> {
	if (explicitPackageDir) return packageAt(explicitPackageDir);
	let current = dirname(executable);
	for (;;) {
		const found = await packageAt(current);
		if (found) return found;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

async function findPiAiManifest(packageRoot: string): Promise<string | undefined> {
	let current = packageRoot;
	for (;;) {
		const candidate = join(current, "node_modules", "@earendil-works", "pi-ai", "package.json");
		try {
			const manifest = JSON.parse(await readFile(candidate, "utf8")) as { name?: unknown };
			if (manifest.name === "@earendil-works/pi-ai") return await realpath(candidate);
		} catch { /* continue up this installation's dependency tree */ }
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

async function loadModules(packageInfo: { root: string; main: string }): Promise<RuntimeModules> {
	const key = packageInfo.root;
	let pending = moduleCache.get(key);
	if (!pending) {
		pending = (async () => {
			const runtimeModule = await import(pathToFileURL(packageInfo.main).href) as { ModelRuntime?: RuntimeModules["ModelRuntime"] };
			if (!runtimeModule.ModelRuntime) throw new Error("unsupported runtime");
			const aiManifest = await findPiAiManifest(packageInfo.root);
			if (!aiManifest) throw new Error("missing installed model API");
			const aiRequire = createRequire(pathToFileURL(aiManifest));
			const aiPackage = JSON.parse(await readFile(aiManifest, "utf8")) as { main?: unknown };
			if (typeof aiPackage.main !== "string") throw new Error("unsupported model API");
			const aiEntry = aiRequire.resolve(`./${aiPackage.main.replace(/^\.\//u, "")}`);
			const aiModule = await import(pathToFileURL(aiEntry).href) as { getSupportedThinkingLevels?: RuntimeModules["getSupportedThinkingLevels"] };
			if (!aiModule.getSupportedThinkingLevels) throw new Error("unsupported model API");
			return { ModelRuntime: runtimeModule.ModelRuntime, getSupportedThinkingLevels: aiModule.getSupportedThinkingLevels };
		})();
		moduleCache.set(key, pending);
		pending.catch(() => moduleCache.delete(key));
	}
	return pending;
}

function safeText(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const text = value.trim();
	if (!text || text.length > 200 || /(?:https?:\/\/|file:\/\/|[\\/][^\s]*\/)/iu.test(text)) return fallback;
	return text;
}

function modelIdentity(value: unknown): { key: string; id: string; label: string } | undefined {
	if (!value || typeof value !== "object") return undefined;
	const model = value as { provider?: unknown; id?: unknown; name?: unknown };
	if (typeof model.provider !== "string" || typeof model.id !== "string") return undefined;
	const provider = model.provider.trim();
	const id = model.id.trim();
	if (!provider || !id || provider.length > 100 || id.length > 200 || !/^[^/\s\\]+\/[^\s\\]+$/u.test(`${provider}/${id}`)) return undefined;
	const fullId = `${provider}/${id}`;
	return { key: fullId, id: fullId, label: safeText(model.name, safeText(id, fullId)) };
}

export function createCatalogueLoader(input: { command: string; agentDir: string; packageDir?: string }): CatalogueLoader {
	return async (signal?: AbortSignal): Promise<SettingsCatalogue> => {
		try {
			if (signal?.aborted) return { models: [], warning: EMPTY_WARNING };
			const executable = await resolveExecutable(input.command);
			if (!executable) return { models: [], warning: EMPTY_WARNING };
			const packageInfo = await discoverPackage(executable, input.packageDir);
			if (!packageInfo) return { models: [], warning: EMPTY_WARNING };
			const modules = await loadModules(packageInfo);
			const agentDir = resolve(input.agentDir);
			const runtime = await modules.ModelRuntime.create({
				authPath: join(agentDir, "auth.json"),
				modelsPath: join(agentDir, "models.json"),
				modelsStorePath: join(agentDir, "models-store.json"),
				allowModelNetwork: false,
				refreshOnCreate: false,
				signal,
			});
			await runtime.refresh({ allowNetwork: false, signal });
			if (signal?.aborted || runtime.getError()) return { models: [], warning: RUNTIME_WARNING };
			const available = new Set<string>();
			for (const entry of runtime.getAvailableSnapshot()) {
				const identity = modelIdentity(entry);
				if (identity) available.add(identity.key);
			}
			const catalogue = new Map<string, SettingsModel>();
			for (const entry of runtime.getModels()) {
				const identity = modelIdentity(entry);
				if (!identity) continue;
				let supported: unknown;
				try { supported = modules.getSupportedThinkingLevels(entry); } catch { supported = []; }
				const thinking = Array.isArray(supported)
					? THINKING_LEVELS.filter(level => supported.includes(level)) as ThinkingLevel[]
					: [];
				catalogue.set(identity.key, { id: identity.id, label: identity.label, available: available.has(identity.key), thinking });
			}
			return { models: [...catalogue.values()].sort((a, b) => a.id.localeCompare(b.id)) };
		} catch {
			return { models: [], warning: EMPTY_WARNING };
		}
	};
}
