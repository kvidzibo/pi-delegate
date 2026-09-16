import type { FinalizationState } from "./finalization.ts";

export const GUARD_ENV = "PI_DELEGATE_RUNTIME_GUARD";
export const GUARD_COMMAND = "delegate-runtime-finalize";
export const GUARD_REQUEST_ID = "delegate-runtime-finalize";
export const GUARD_NOTICE = "delegate-runtime-guard";
export const GUARDED_TOOLS = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"] as const;

/** Explicit runtime API opt-in. No package/user defaults are selected here. */
export interface GuardedExecution {
	tools: string[];
	finalizeAfterMs: number;
	finalizationGraceMs: number;
	startupTimeoutMs: number;
}

export interface GuardConfig { nonce: string; tools: string[] }
export type FinalizationReason = "wrap" | "execution_budget";
export type FinalizationProgress = {
	phase: "starting" | "requested" | FinalizationState["phase"];
	reason?: FinalizationReason;
	activeTools?: number;
};
export type GuardNotice = {
	type: typeof GUARD_NOTICE;
	version: 1;
	nonce: string;
	event: "ready" | "state";
	state: FinalizationState;
	tools?: string[];
};

export function validateGuardConfig(value: unknown): GuardConfig {
	const raw = value as Partial<GuardConfig> | undefined;
	if (!raw || typeof raw.nonce !== "string" || !/^[a-zA-Z0-9-]{16,64}$/.test(raw.nonce)
		|| !Array.isArray(raw.tools) || raw.tools.length === 0 || raw.tools.length > GUARDED_TOOLS.length
		|| !raw.tools.every(tool => (GUARDED_TOOLS as readonly unknown[]).includes(tool))
		|| new Set(raw.tools).size !== raw.tools.length) {
		throw new Error("Runtime guard requires a nonce and a distinct supported builtin tool list.");
	}
	return { nonce: raw.nonce, tools: [...raw.tools] };
}

export function validateGuardedExecution(value: GuardedExecution): GuardedExecution {
	validateGuardConfig({ nonce: "validation-only-guard", tools: value?.tools });
	for (const key of ["finalizeAfterMs", "finalizationGraceMs", "startupTimeoutMs"] as const) {
		const number = value[key];
		if (!Number.isSafeInteger(number) || number > 2_147_483_647 || number < (key === "finalizeAfterMs" ? 0 : 1)) {
			throw new Error(`Invalid guarded execution ${key}: must be a supported timer duration.`);
		}
	}
	return { tools: [...value.tools], finalizeAfterMs: value.finalizeAfterMs,
		finalizationGraceMs: value.finalizationGraceMs, startupTimeoutMs: value.startupTimeoutMs };
}

export function copyFinalizationProgress(value: unknown): FinalizationProgress | undefined {
	const raw = value as Partial<FinalizationProgress> | undefined;
	if (!raw || !["starting", "running", "requested", "draining", "answering"].includes(raw.phase as string)
		|| (raw.reason !== undefined && raw.reason !== "wrap" && raw.reason !== "execution_budget")
		|| (raw.activeTools !== undefined && (!Number.isSafeInteger(raw.activeTools) || raw.activeTools < 0))) return;
	return { phase: raw.phase!, ...(raw.reason ? { reason: raw.reason } : {}),
		...(raw.activeTools !== undefined ? { activeTools: raw.activeTools } : {}) };
}

/** Only transport notifications from the private guard, never model prose/tool results. */
export function parseGuardNotice(event: unknown, nonce: string): GuardNotice | undefined {
	const raw = event as { type?: unknown; method?: unknown; message?: unknown } | undefined;
	if (raw?.type !== "extension_ui_request" || raw.method !== "notify" || typeof raw.message !== "string") return;
	let notice: any;
	try { notice = JSON.parse(raw.message); } catch { return; }
	if (notice?.type !== GUARD_NOTICE || notice.nonce !== nonce) return;
	const state = notice.state;
	if (notice.version !== 1 || !["ready", "state"].includes(notice.event)
		|| !state || !["running", "draining", "answering"].includes(state.phase)
		|| !Number.isSafeInteger(state.activeTools) || state.activeTools < 0
		|| (state.phase === "answering" && state.activeTools !== 0)
		|| (state.phase === "draining" && state.activeTools === 0)) {
		throw new Error("Invalid runtime guard acknowledgement.");
	}
	return notice as GuardNotice;
}
