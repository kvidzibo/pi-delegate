import { GUARD_COMMAND, GUARD_REQUEST_ID, parseGuardNotice,
	type GuardedExecution, type FinalizationProgress, type FinalizationReason } from "./guard-protocol.ts";

export type FinalizationFailure = "guard-error" | "finalization_timeout";
export interface FinalizerClock {
	set: (callback: () => void, ms: number) => unknown;
	clear: (handle: unknown) => void;
}
const clock: FinalizerClock = { set: (fn, ms) => setTimeout(fn, ms), clear: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) };

interface Bindings {
	send: (command: Record<string, unknown>) => boolean;
	steer: (message: string) => boolean;
	fail: (reason: FinalizationFailure, text: string) => void;
	onState?: (state: FinalizationProgress) => void;
}

/** Parent-side deadlines and acknowledgements. Queue time is outside this object's lifetime. */
export class ChildFinalizer {
	private readonly policy: GuardedExecution;
	private readonly nonce: string;
	private readonly clock: FinalizerClock;
	private bindings?: Bindings;
	private state: FinalizationProgress = { phase: "starting" };
	private ready = false;
	private started = false;
	private taskSent = false;
	private commandSent = false;
	private steerSent = false;
	private ended = false;
	private disposed = false;
	private message?: string;
	private startupTimer?: unknown;
	private softTimer?: unknown;
	private graceTimer?: unknown;
	private waiters = new Set<() => void>();

	constructor(policy: GuardedExecution, nonce: string, bindings: Bindings, timer: FinalizerClock = clock) {
		this.policy = policy; this.nonce = nonce; this.bindings = bindings; this.clock = timer;
	}

	start(defaultWrapMessage: string): void {
		if (this.disposed || this.started) return;
		this.started = true;
		this.startupTimer = this.clock.set(() => this.fail("guard-error", "Child runtime guard did not become ready before its startup deadline."), this.policy.startupTimeoutMs);
		if (this.policy.finalizeAfterMs > 0) this.softTimer = this.clock.set(() => this.request(defaultWrapMessage, "execution_budget"), this.policy.finalizeAfterMs);
		this.notify();
	}

	snapshot(): FinalizationProgress { return { ...this.state }; }

	waitReady(signal: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			const check = () => {
				if (signal.aborted || this.disposed) { cleanup(); reject(new Error("Child startup stopped.")); }
				else if (this.ready && this.state.phase !== "requested") { cleanup(); resolve(); }
			};
			const cleanup = () => { this.waiters.delete(check); signal.removeEventListener("abort", check); };
			this.waiters.add(check); signal.addEventListener("abort", check, { once: true }); check();
		});
	}

	request(message: string, reason: FinalizationReason = "wrap"): boolean {
		if (this.ended || this.disposed || !message.trim() || message.length > 20000) return false;
		if (this.state.reason) return true; // First request, message and grace deadline win.
		this.message = message;
		this.state = { phase: "requested", reason };
		this.graceTimer = this.clock.set(() => this.fail("finalization_timeout", "Child finalization grace expired; available evidence may be incomplete."), this.policy.finalizationGraceMs);
		this.notify(); this.sendRequest();
		return true;
	}

	markTaskSent(): void { this.taskSent = true; this.sendSteer(); }

	accept(event: unknown): void {
		if (this.disposed || this.ended) return;
		const response = event as { type?: unknown; id?: unknown; success?: unknown; error?: unknown } | undefined;
		if (this.commandSent && response?.type === "response" && response.id === GUARD_REQUEST_ID && response.success === false) {
			this.fail("guard-error", `Child runtime guard rejected finalization: ${String(response.error ?? "unknown error")}`); return;
		}
		try {
			const notice = parseGuardNotice(event, this.nonce);
			if (!notice) return;
			if (notice.event === "ready") {
				if (this.ready || notice.state.phase !== "running" || notice.state.activeTools !== 0 || !Array.isArray(notice.tools)
					|| notice.tools.length !== this.policy.tools.length || !this.policy.tools.every(name => notice.tools!.includes(name))) {
					throw new Error("Child runtime guard readiness does not match the requested tool set.");
				}
				this.ready = true;
				this.clear("startupTimer");
				// Running tool counts change independently; only report counts after gate closure.
				if (!this.state.reason) this.state = { phase: "running" };
				this.notify(); this.sendRequest();
			} else {
				if (!this.ready) throw new Error("Child runtime guard sent state before readiness.");
				if (notice.state.phase !== "running") {
					if (!this.commandSent) throw new Error("Child runtime guard finalized without a request.");
					if ((this.state.phase === "draining" || this.state.phase === "answering")
						&& notice.state.activeTools > (this.state.activeTools ?? 0)) {
						throw new Error("Child runtime guard admitted a fresh tool after finalization.");
					}
					this.state = { ...notice.state, reason: this.state.reason };
					this.notify(); this.sendSteer();
				} else if (this.state.phase === "draining" || this.state.phase === "answering") {
					throw new Error("Child runtime guard reopened after finalization.");
				}
			}
			for (const waiter of [...this.waiters]) waiter();
		} catch (error) { this.fail("guard-error", error instanceof Error ? error.message : String(error)); }
	}

	settled(): void {
		if (this.disposed || this.ended) return;
		this.ended = true;
		this.clear("softTimer");
		// An acknowledged answer does not release occupancy until the process exits.
		if (this.graceTimer === undefined) this.graceTimer = this.clock.set(() =>
			this.fail("finalization_timeout", "Child did not exit within its finalization shutdown grace; available evidence may be incomplete."),
			this.policy.finalizationGraceMs);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.clear("startupTimer"); this.clear("softTimer"); this.clear("graceTimer");
		this.message = undefined;
		this.bindings = undefined;
		for (const waiter of [...this.waiters]) waiter();
		this.waiters.clear();
	}

	private sendRequest(): void {
		if (!this.ready || this.disposed || this.commandSent || !this.state.reason) return;
		this.commandSent = true;
		if (!this.bindings?.send({ id: GUARD_REQUEST_ID, type: "prompt", message: `/${GUARD_COMMAND} ${this.nonce}` })) {
			this.fail("guard-error", "Could not send child finalization control.");
		}
	}

	private sendSteer(): void {
		if (!this.taskSent || this.steerSent || this.disposed || !this.message
			|| (this.state.phase !== "draining" && this.state.phase !== "answering")) return;
		this.steerSent = true;
		if (!this.bindings?.steer(this.message)) this.fail("guard-error", "Could not send the child's final-answer steering message.");
		this.message = undefined;
	}

	private fail(reason: FinalizationFailure, text: string): void {
		if (this.disposed) return;
		const fail = this.bindings?.fail;
		this.dispose();
		fail?.(reason, text);
	}

	private clear(name: "startupTimer" | "softTimer" | "graceTimer"): void {
		if (this[name] !== undefined) { this.clock.clear(this[name]); this[name] = undefined; }
	}

	private notify(): void {
		try { this.bindings?.onState?.(this.snapshot()); }
		catch { /* Observers cannot change child outcomes. */ }
	}
}
