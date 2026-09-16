import {
	createBashToolDefinition, createEditToolDefinition, createFindToolDefinition, createGrepToolDefinition,
	createLsToolDefinition, createPowerShellToolDefinition, createReadToolDefinition, createWriteToolDefinition,
	type ExtensionAPI, type ExtensionContext, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { FinalizationGate } from "./finalization.ts";
import { installHeadroomGuard } from "./headroom-guard.ts";
import type { HeadroomProgress } from "./headroom-protocol.ts";
import { GUARD_COMMAND, GUARD_ENV, GUARD_NOTICE, validateGuardConfig, type GuardConfig } from "./guard-protocol.ts";

const factories: Record<string, (cwd: string) => ToolDefinition<any, any>> = {
	read: createReadToolDefinition, bash: createBashToolDefinition, powershell: createPowerShellToolDefinition,
	edit: createEditToolDefinition, write: createWriteToolDefinition, grep: createGrepToolDefinition,
	find: createFindToolDefinition, ls: createLsToolDefinition,
};

/** Private, explicit child extension. Ambient discovery remains disabled. Not a sandbox. */
export function installRuntimeGuard(pi: ExtensionAPI, config: GuardConfig): void {
	config = validateGuardConfig(config);
	let ctx: ExtensionContext | undefined;
	let ready = false;
	const notify = (event: "ready" | "state" | "headroom", progress?: HeadroomProgress) => {
		ctx?.ui.notify(JSON.stringify({ type: GUARD_NOTICE, version: 1, nonce: config.nonce, event,
			state: gate.snapshot(), ...(event === "ready" ? { tools: [...config.tools] } : {}),
			...(progress ? { headroom: progress } : {}) }), "info");
	};
	const gate = new FinalizationGate(() => { if (ready) notify("state"); });
	const headroom = config.headroom ? installHeadroomGuard(pi, config.headroom, {
		nonce: config.nonce, ready: () => ready, gate, closeTools: () => pi.setActiveTools([]), notify: progress => notify("headroom", progress),
	}) : undefined;

	pi.registerCommand(GUARD_COMMAND, {
		description: "Private delegate runtime control.",
		handler: (args) => {
			if (!ready || args !== config.nonce) throw new Error("Runtime guard control rejected.");
			// Synchronous gate closure before any acknowledgement; wrappers check at actual execution.
			gate.request();
			pi.setActiveTools([]);
			notify("state");
		},
	});
	pi.on("session_start", (_event, next) => {
		if (ready || next.mode !== "rpc") throw new Error("Runtime guard requires a fresh RPC child.");
		ctx = next;
		headroom?.checkModel(next.model);
		for (const name of config.tools) {
			const tool = factories[name](next.cwd);
			pi.registerTool({ ...tool, execute: (...args) => gate.execute(() => tool.execute(...args)) });
		}
		pi.setActiveTools(config.tools);
		const active = pi.getActiveTools();
		if (active.length !== config.tools.length || !config.tools.every(name => active.includes(name))) {
			throw new Error("Runtime guard could not establish the requested tool set.");
		}
		ready = true;
		notify("ready", headroom ? { policyId: headroom.policyId, phase: "ready", limited: false } : undefined);
	});
	pi.on("session_shutdown", () => { ready = false; gate.request(); ctx = undefined; });
}

export default function runtimeGuard(pi: ExtensionAPI): void {
	const source = process.env[GUARD_ENV];
	if (!source) throw new Error("Private runtime guard is missing its launch configuration.");
	installRuntimeGuard(pi, validateGuardConfig(JSON.parse(source)));
}
