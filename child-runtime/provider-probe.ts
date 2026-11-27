import { DefaultResourceLoader, getAgentDir, ModelRegistry, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

/** JSON `{ mark, model }` from the parent; absent in every other Pi process. */
export const PROVIDER_PROBE_ENV = "PI_DELEGATE_PROVIDER_PROBE";

/**
 * Runs alone in a throwaway Pi process started without extensions, like a child with
 * extensions off. Prints the extension file a `provider/model` needs there, or null,
 * then exits before any session starts.
 */
export default async function providerProbe(): Promise<void> {
	const raw = process.env[PROVIDER_PROBE_ENV];
	if (!raw) return;
	const { mark, model } = JSON.parse(raw) as { mark: string; model: string };
	const slash = model.indexOf("/");
	const provider = model.slice(0, slash);
	let owner: string | null = null;
	// A model that already resolves here needs nothing, whatever extensions do to its provider.
	const registry = new ModelRegistry(await ModelRuntime.create({ allowModelNetwork: false }));
	if (!registry.find(provider, model.slice(slash + 1))) {
		const cwd = process.cwd(), agentDir = getAgentDir();
		// The parent's trust decision is not visible here, so project extensions never run.
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: false }) });
		await loader.reload();
		// Unbound extensions leave their registrations queued, each with the file that made it.
		const runtime = loader.getExtensions().runtime;
		owner = runtime.pendingProviderRegistrations.find(item => item.name === provider)?.extensionPath
			?? runtime.pendingNativeProviderRegistrations.find(item => item.provider.id === provider)?.extensionPath ?? null;
	}
	process.stdout.write(`\n${mark}${JSON.stringify(owner)}\n`, () => process.exit(0));
	await new Promise(() => { /* never continue into the session */ });
}
