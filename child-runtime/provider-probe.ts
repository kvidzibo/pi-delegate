import { DefaultResourceLoader, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

/** The parent passes a one-off marker so other extensions' output cannot be mistaken for the result. */
export const PROVIDER_PROBE_ENV = "PI_DELEGATE_PROVIDER_PROBE";

/**
 * Runs alone in a throwaway Pi process. Loads the configured extensions without
 * binding them, where Pi still records which file registered each provider, then
 * prints that map and exits before any session starts.
 */
export default async function providerProbe(): Promise<void> {
	const mark = process.env[PROVIDER_PROBE_ENV];
	if (!mark) return;
	const cwd = process.cwd(), agentDir = getAgentDir();
	const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: SettingsManager.create(cwd, agentDir) });
	await loader.reload();
	const runtime = loader.getExtensions().runtime;
	const owners: Record<string, string> = {};
	for (const item of runtime.pendingProviderRegistrations) owners[item.name] = item.extensionPath;
	for (const item of runtime.pendingNativeProviderRegistrations) owners[item.provider.id] = item.extensionPath;
	process.stdout.write(`\n${mark}${JSON.stringify(owners)}\n`, () => process.exit(0));
	await new Promise(() => { /* never continue into the session */ });
}
