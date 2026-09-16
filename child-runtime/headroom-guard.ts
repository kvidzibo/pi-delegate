import { writeSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FinalizationGate } from "./finalization.ts";
import { HeadroomSession, headroomPolicyId, validateHeadroomModel, type HeadroomModel, type HeadroomPolicy } from "./headroom.ts";
import { HEADROOM_EXIT_CODE, HEADROOM_STDERR_PREFIX, type HeadroomProgress } from "./headroom-protocol.ts";

interface Bindings {
	nonce: string;
	ready: () => boolean;
	gate: FinalizationGate;
	closeTools: () => void;
	notify: (progress: HeadroomProgress) => void;
}

/** Synchronous veto in the dedicated child. Throwing an ordinary Pi hook is NOT a veto. */
export function exitForHeadroom(progress: HeadroomProgress, nonce: string): never {
	// A leading newline separates a partially buffered ordinary diagnostic. This small write is
	// independent of Pi's asynchronous stdout notification queue; it contains no payload evidence.
	try { writeSync(2, `\n${HEADROOM_STDERR_PREFIX}${JSON.stringify({ nonce, headroom: progress })}\n`); } catch { /* Exit-code fallback. */ }
	process.exit(HEADROOM_EXIT_CODE);
}

export function installHeadroomGuard(pi: Pick<ExtensionAPI, "on">, policy: HeadroomPolicy, bindings: Bindings,
	stop: (progress: HeadroomProgress) => never = progress => exitForHeadroom(progress, bindings.nonce)) {
	const session = new HeadroomSession(policy), policyId = headroomPolicyId(policy);
	const refuse = (error: unknown): never => {
		const progress: HeadroomProgress = { policyId, phase: "refused", limited: true,
			detail: (error instanceof Error ? error.message : "Unsafe context payload.").slice(0, 300) };
		try { bindings.notify(progress); } catch { /* Never turn a failed observer into provider dispatch. */ }
		try { bindings.gate.request(); bindings.closeTools(); } catch { /* Exit remains authoritative. */ }
		return stop(progress);
	};
	const close = () => { bindings.gate.request(); bindings.closeTools(); };
	pi.on("before_provider_request", (event, ctx) => {
		try {
			if (!bindings.ready()) throw new Error("Headroom guard is not ready for provider dispatch.");
			const plan = session.plan(event.payload, ctx.model as HeadroomModel);
			bindings.notify({ policyId, phase: plan.finalize ? "limited" : "checked", limited: plan.finalize,
				inputBytes: plan.inputBytes, inputLimitBytes: plan.inputLimitBytes, reservedTokens: plan.reservedTokens,
				clippedToolResults: plan.clippedToolResults });
			// Parent must receive the reason before the unsolicited gate-closure acknowledgement.
			if (plan.finalize) close();
			return plan.payload;
		} catch (error) { return refuse(error); }
	});
	pi.on("session_before_compact", () => {
		try {
			bindings.notify({ policyId, phase: "compaction-blocked", limited: true,
				detail: "Compaction cancelled by the child context policy; no default summary request is allowed." });
			close();
			return { cancel: true };
		} catch (error) { return refuse(error); }
	});
	return { policyId, checkModel: (model: unknown) => {
		try { validateHeadroomModel(model as HeadroomModel); } catch (error) { refuse(error); }
	} };
}
