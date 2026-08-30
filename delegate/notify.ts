import { aliasForModel, type ThemeFg } from "./display.ts";
import type { JobSnapshot } from "./jobs.ts";

export const NOTIFY_HOLD_MS = 200;
export const NOTIFY_PREVIEW_MAX = 400;
export const NOTIFY_CUSTOM_TYPE = "delegate-notify";

export type NotifyDetails = {
	jobId: string;
	kind: string;
	model: string;
	status: string;
	failed: boolean;
	preview: string;
};

export type NotifyPayload = {
	customType: typeof NOTIFY_CUSTOM_TYPE;
	content: string;
	display: boolean;
	details: NotifyDetails;
};

export type NotifySend = (payload: NotifyPayload) => void;

export type NotifyTimers = {
	setTimeout: (fn: () => void, ms: number) => unknown;
	clearTimeout: (id: unknown) => void;
};

function clipNotifyPreview(raw: string, max = NOTIFY_PREVIEW_MAX): string {
	const compact = raw.replace(/\s+/g, " ").trim() || "(no output)";
	if (compact.length <= max) return compact;
	return `${compact.slice(0, Math.max(1, max - 1))}…`;
}

export function notifyPreview(
	snap: Pick<JobSnapshot, "answer" | "stderrTail" | "stopReason">,
	max = NOTIFY_PREVIEW_MAX,
): string {
	return clipNotifyPreview(snap.answer || snap.stderrTail || snap.stopReason || "(no output)", max);
}

export function shouldConsume(snap: Pick<JobSnapshot, "status">): boolean {
	return snap.status === "done" || snap.status === "failed";
}

export function buildNotifyPayload(snap: JobSnapshot, max = NOTIFY_PREVIEW_MAX): NotifyPayload {
	const preview = notifyPreview(snap, max);
	const status =
		snap.failed && snap.stopReason && snap.status === "failed"
			? `failed (${snap.stopReason})`
			: snap.status;
	const details: NotifyDetails = {
		jobId: snap.id,
		kind: snap.kind,
		model: snap.model,
		status,
		failed: snap.failed,
		preview,
	};
	const lines = [
		`bg ${snap.id} ${status}`,
		`${snap.kind} → ${aliasForModel(snap.model)} (${snap.model})`,
		preview,
		"",
		"Use jobId to collect the full result.",
	];
	return {
		customType: NOTIFY_CUSTOM_TYPE,
		content: lines.join("\n"),
		display: snap.failed,
		details,
	};
}

export function paintNotify(theme: ThemeFg, details: NotifyDetails, expanded = false): string {
	const icon = details.failed ? "✗" : "✓";
	const color = details.failed ? "error" : "success";
	let line = `${theme.fg(color, icon)} ${theme.bold("delegate")} ${theme.fg("dim", details.status)}`;
	line += `  ${theme.fg("accent", details.jobId)}`;
	if (details.kind) line += `  ${theme.fg("dim", details.kind)}`;
	if (expanded) {
		line += `\n  ${theme.fg("dim", details.preview)}`;
	} else {
		const one = details.preview.split(" ").slice(0, 12).join(" ");
		line += `\n  ${theme.fg("dim", `⎿  ${one}`)}`;
	}
	return line;
}

export class NotifyGate {
	private readonly consumed = new Set<string>();
	private readonly sent = new Set<string>();
	private readonly timers = new Map<string, unknown>();
	private readonly holdMs: number;
	private readonly send: NotifySend;
	private readonly isLive: () => boolean;
	private readonly isBusy: () => boolean;
	private readonly timersApi: NotifyTimers;

	constructor(input: {
		send: NotifySend;
		isLive: () => boolean;
		isBusy?: () => boolean;
		holdMs?: number;
		timers?: NotifyTimers;
	}) {
		this.send = input.send;
		this.isLive = input.isLive;
		this.isBusy = input.isBusy ?? (() => false);
		this.holdMs = input.holdMs ?? NOTIFY_HOLD_MS;
		this.timersApi = input.timers ?? {
			setTimeout: (fn, ms) => setTimeout(fn, ms),
			clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
		};
	}

	schedule(snap: JobSnapshot): void {
		if (!snap.background) return;
		if (!shouldConsume(snap)) return;
		if (this.consumed.has(snap.id) || this.sent.has(snap.id)) return;
		if (!this.isLive()) return;
		this.arm(snap);
	}

	consume(id: string): void {
		this.consumed.add(id);
		this.clearTimer(id);
	}

	shutdown(): void {
		for (const id of [...this.timers.keys()]) this.clearTimer(id);
	}

	private flush(snap: JobSnapshot): void {
		if (this.consumed.has(snap.id) || this.sent.has(snap.id)) return;
		if (!this.isLive()) return;
		if (this.busy()) {
			this.arm(snap);
			return;
		}
		this.sent.add(snap.id);
		try {
			this.send(buildNotifyPayload(snap));
		} catch {
			/* stale session or sendMessage failure must not break the scheduler */
		}
	}

	private arm(snap: JobSnapshot): void {
		this.clearTimer(snap.id);
		this.timers.set(
			snap.id,
			this.timersApi.setTimeout(() => {
				this.timers.delete(snap.id);
				this.flush(snap);
			}, this.holdMs),
		);
	}

	private busy(): boolean {
		try {
			return this.isBusy();
		} catch {
			return false;
		}
	}

	private clearTimer(id: string): void {
		const timer = this.timers.get(id);
		if (timer === undefined) return;
		this.timers.delete(id);
		this.timersApi.clearTimeout(timer);
	}
}
