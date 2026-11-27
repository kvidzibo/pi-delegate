import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { getPiInvocation } from "../child-runtime/spawn.ts";

const PROBE = fileURLToPath(new URL("../child-runtime/provider-probe.ts", import.meta.url));

/** Resolves to the extension file a `provider/model` needs when extensions are off, if any. */
export type ProviderProbe = (model: string) => Promise<string | undefined>;

const runProbe: ProviderProbe = model => new Promise((done, reject) => {
	const mark = `${randomUUID()}=`;
	const pi = getPiInvocation(["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-session", "--extension", PROBE, "--list-models"]);
	const request = JSON.stringify({ mark, model });
	execFile(pi.command, pi.args, { env: { ...process.env, PI_DELEGATE_CHILD: "1", PI_DELEGATE_PROVIDER_PROBE: request }, timeout: 15000, maxBuffer: 4 << 20 },
		(error, stdout) => {
			try { if (error) throw error; done(parseProviderOwner(stdout, mark)); }
			catch (failure) { reject(failure); }
		});
});

/** Reads the marked line; extensions loaded by the probe may print around it. */
export function parseProviderOwner(stdout: string, mark: string): string | undefined {
	const line = stdout.split("\n").findLast(item => item.startsWith(mark));
	if (!line) throw new Error("Provider probe returned no result.");
	const path: unknown = JSON.parse(line.slice(mark.length));
	return typeof path === "string" && isAbsolute(path) ? path : undefined;
}

const owners = new Map<string, Promise<string | undefined>>();

/**
 * Extension file that registers this model's provider, when the model does not resolve
 * without it. Undefined when it does, and when the probe fails: the child then reports
 * the missing model itself. Bare model ids are left alone: adding an extension could
 * change which provider Pi resolves them to.
 */
export async function providerExtension(model: string, probe: ProviderProbe = runProbe): Promise<string | undefined> {
	if (model.indexOf("/") < 1) return undefined;
	let pending = owners.get(model);
	if (!pending) owners.set(model, pending = probe(model));
	try { return await pending; }
	catch {
		if (owners.get(model) === pending) owners.delete(model);
		return undefined;
	}
}

export function resetProviderExtensions(): void { owners.clear(); }
