import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { getPiInvocation } from "../child-runtime/spawn.ts";

const PROBE = fileURLToPath(new URL("../child-runtime/provider-probe.ts", import.meta.url));

/** Resolves to provider id → registering extension file. */
export type ProviderProbe = () => Promise<Map<string, string>>;

const runProbe: ProviderProbe = () => new Promise((resolve, reject) => {
	const mark = `${randomUUID()}=`;
	const pi = getPiInvocation(["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-session", "--extension", PROBE, "--list-models"]);
	execFile(pi.command, pi.args, { env: { ...process.env, PI_DELEGATE_CHILD: "1", PI_DELEGATE_PROVIDER_PROBE: mark }, timeout: 15000, maxBuffer: 4 << 20 },
		(error, stdout) => {
			try { if (error) throw error; resolve(parseProviderOwners(stdout, mark)); }
			catch (failure) { reject(failure); }
		});
});

/** Reads the marked line; extensions loaded by the probe may print around it. */
export function parseProviderOwners(stdout: string, mark: string): Map<string, string> {
	const line = stdout.split("\n").findLast(item => item.startsWith(mark));
	if (!line) throw new Error("Provider probe returned no result.");
	const owners = new Map<string, string>();
	for (const [provider, path] of Object.entries(JSON.parse(line.slice(mark.length)) as Record<string, unknown>)) {
		if (typeof path === "string" && isAbsolute(path)) owners.set(provider, path);
	}
	return owners;
}

let owners: Promise<Map<string, string>> | undefined;

/**
 * Extension file that registers this model's provider in the parent's configuration.
 * Undefined for built-in and models.json providers, and when the probe fails: the
 * child then reports the missing model itself.
 */
export async function providerExtension(model: string, probe: ProviderProbe = runProbe): Promise<string | undefined> {
	const slash = model.indexOf("/");
	if (slash < 1) return undefined;
	const pending = owners ??= probe();
	try { return (await pending).get(model.slice(0, slash)); }
	catch {
		if (owners === pending) owners = undefined;
		return undefined;
	}
}

export function resetProviderExtensions(): void { owners = undefined; }
