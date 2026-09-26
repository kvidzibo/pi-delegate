import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CHILD_LEASE_FD, verifyLease } from "./lease.ts";
import { LEASE_ENV, LEASE_NOTICE, validateLeaseStartup } from "./lease-startup.ts";

/** Private startup check. The inherited descriptor stays open until child process exit. */
export default function leaseGuard(pi: ExtensionAPI): void {
	const config = validateLeaseStartup(JSON.parse(process.env[LEASE_ENV] ?? "null"));
	let ready = false;
	pi.on("session_start", (_event, ctx) => {
		if (ready || ctx.mode !== "rpc") throw new Error("Lease startup requires a fresh RPC child.");
		verifyLease(CHILD_LEASE_FD, config.lease);
		ready = true;
		ctx.ui.notify(JSON.stringify({ type: LEASE_NOTICE, version: 1, ...config }), "info");
	});
}
