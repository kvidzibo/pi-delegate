import { DefaultResourceLoader, getAgentDir, ModelRuntime, resolveCliModel, SettingsManager } from "@earendil-works/pi-coding-agent";

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
	const provider = model.slice(0, model.indexOf("/"));
	let owner: string | null = null;
	// A model that `--model` already resolves here needs nothing, whatever extensions do to its provider.
	if (!resolveCliModel({ cliModel: model, modelRuntime: await ModelRuntime.create({ allowModelNetwork: false }) }).model) {
		const cwd = process.cwd(), agentDir = getAgentDir();
		// The parent's trust decision is not visible here, so project extensions never run.
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: false }) });
		await loader.reload();
		// Unbound extensions leave their registrations queued, each with the file that made it.
		const runtime = loader.getExtensions().runtime;
		const files = new Set([
			...runtime.pendingProviderRegistrations.filter(item => item.name === provider).map(item => item.extensionPath),
			...runtime.pendingNativeProviderRegistrations.filter(item => item.provider.id === provider).map(item => item.extensionPath),
		]);
		// Several files shaping one provider depend on each other's order; one alone could differ from the parent.
		if (files.size === 1) [owner] = files;
	}
	process.stdout.write(`\n${mark}${JSON.stringify(owner)}\n`, () => process.exit(0));
	await new Promise(() => { /* never continue into the session */ });
}
