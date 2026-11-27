import { DefaultResourceLoader, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

/** JSON `{ mark, extensions, noExtensions }` from the parent; absent in every other Pi process. */
export const PROVIDER_PROBE_ENV = "PI_DELEGATE_PROVIDER_PROBE";

/**
 * Runs alone in a throwaway Pi process. Loads the parent's extensions without binding
 * them, where Pi still records which file registered each provider, then prints the
 * providers that bring their own models and exits before any session starts.
 */
export default async function providerProbe(): Promise<void> {
	const raw = process.env[PROVIDER_PROBE_ENV];
	if (!raw) return;
	const request = JSON.parse(raw) as { mark: string; extensions: string[]; noExtensions: boolean };
	const cwd = process.cwd(), agentDir = getAgentDir();
	const loader = new DefaultResourceLoader({
		cwd, agentDir, additionalExtensionPaths: request.extensions, noExtensions: request.noExtensions,
		// The parent's trust decision is not visible here, so project extensions never run.
		settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: false }),
	});
	await loader.reload();
	const runtime = loader.getExtensions().runtime;
	const owners: Record<string, string> = {};
	// A registration without models only adjusts a built-in provider, which works without it.
	for (const item of runtime.pendingProviderRegistrations) {
		if (item.config.models?.length) owners[item.name] = item.extensionPath;
	}
	for (const item of runtime.pendingNativeProviderRegistrations) owners[item.provider.id] = item.extensionPath;
	process.stdout.write(`\n${request.mark}${JSON.stringify(owners)}\n`, () => process.exit(0));
	await new Promise(() => { /* never continue into the session */ });
}
