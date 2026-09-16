import { truncateOutput, truncateToUtf8Bytes } from "./policy.ts";
import { MAX_RETAINED_RESPONSES, type ResponseEvidence } from "./evidence.ts";

interface Answer {
	text: string;
	stopReason?: string;
	errorMessage?: string;
}

interface PhaseAnswer extends Answer {
	phase: number;
	/** Ordinal of message_end assistant events, not a native session entry ID. */
	message?: number;
	partial?: boolean;
}

export function answerExplanation(answer: Answer): string | undefined {
	if (answer.stopReason === "length") return "Child response reached the model output token limit; the answer is incomplete.";
	if (answer.stopReason === "error") return answer.errorMessage || "Child provider response failed.";
	return undefined;
}

/** Last answer per delivered steering phase. Native sessions retain the full history. */
export class AnswerHistory {
	private readonly maxBytes: number;
	private phase = 0;
	private sequence = 0;
	private current?: PhaseAnswer;
	private partial?: PhaseAnswer;
	private previous: PhaseAnswer[] = [];
	private omitted = 0;

	constructor(maxBytes: number) { this.maxBytes = maxBytes; }

	observe(answer: Answer): void {
		this.partial = undefined;
		this.current = {
			phase: this.phase, message: ++this.sequence,
			text: truncateOutput(answer.text, this.maxBytes), stopReason: answer.stopReason,
			errorMessage: answer.errorMessage === undefined ? undefined : truncateOutput(answer.errorMessage, this.maxBytes),
		};
	}

	get currentPhase(): number { return this.phase; }

	/** Record a stopped open stream for terminal formatting, not as a finalized message. */
	observePartial(text: string, phase = this.phase): void {
		if (!Number.isSafeInteger(phase) || phase < 0 || phase > this.phase) throw new Error("Unknown partial response phase.");
		this.partial = { phase, partial: true, text: truncateOutput(text, this.maxBytes) };
	}

	beginWrap(): void {
		if (this.current || this.phase > 0) {
			this.previous.push(this.current ?? { phase: this.phase, text: "" });
			// At most eight phases including current: keep the first and six most recent sealed phases.
			if (this.previous.length > MAX_RETAINED_RESPONSES - 1) { this.previous.splice(1, 1); this.omitted++; }
		}
		this.current = undefined;
		this.partial = undefined;
		this.phase++;
	}

	get awaitingResponse(): boolean { return this.phase > 0 && !this.current; }

	/** Counts message_end observations, not model requests, useful reports or verified work. */
	evidence(taskSent: boolean, openResponse: boolean, agentSettled: boolean): ResponseEvidence {
		return { source: "rpc", taskSent, agentSettled, finalizedMessages: this.sequence,
			retainedResponses: this.previous.filter(answer => answer.message !== undefined).length + (this.current ? 1 : 0),
			omittedPhases: this.omitted, unansweredWrap: this.awaitingResponse,
			openResponse: openResponse || !!this.partial, partialResponseRetained: !!this.partial };
	}

	format(unwrappedText: string, cause?: string): string {
		if (this.phase === 0 && !this.partial) return unwrappedText;
		const completed = this.current ?? { phase: this.phase, text: "" };
		// An open stream is extra evidence, never a replacement for finalized text in its phase.
		const answers = [...this.previous, ...(this.current || !this.partial || this.partial.phase !== this.phase ? [completed] : [])];
		if (this.partial) {
			const later = answers.findIndex(answer => answer.phase > this.partial!.phase);
			answers.splice(later < 0 ? answers.length : later, 0, this.partial);
		}
		const latest = answers.at(-1);
		const headers = answers.map(answer => {
			const phase = answer.phase === 0 ? "Task response" : `Wrap-up ${answer.phase}`;
			if (answer.partial) return `${phase} (incomplete streamed response):\n`;
			return answer.message === undefined ? `${phase}: ` : `${phase} (assistant ${answer.message}):\n`;
		});
		const bodies = answers.map(answer => {
			if (answer.message === undefined && !answer.partial) return "[No assistant message received]";
			const text = answer.text || "[No assistant text]";
			const explanation = answerExplanation(answer);
			return explanation && answer !== latest ? `${explanation}\n\n${text}` : text;
		});
		const prefix = cause ? `${cause}\n\n` : "";
		const omission = this.omitted ? `[${this.omitted} wrap-up phases omitted; see archived session.]\n\n` : "";
		const overhead = Buffer.byteLength(prefix + omission + headers.join("\n\n"));
		const available = this.maxBytes - overhead;
		if (available < answers.length * 32) {
			// Very small caps cannot fit every label/body. Say so instead of silently hiding a correction.
			const notice = `${prefix}[Responses truncated; see archived session.]\n`;
			const room = this.maxBytes - Buffer.byteLength(notice);
			if (room > 0) return notice + truncateOutput(`${headers.at(-1)}${bodies.at(-1)}`, room);
			// A verbose truncation counter must not crowd out a cause that fits by itself.
			const suffix = Buffer.byteLength(prefix + "[truncated]") <= this.maxBytes ? "[truncated]" : "…";
			return truncateToUtf8Bytes(prefix ? prefix + suffix : notice, this.maxBytes);
		}
		// Share the budget, redistributing unused space from short replies to longer reports.
		const lengths = bodies.map(text => Buffer.byteLength(text));
		const budgets = new Array<number>(bodies.length).fill(0);
		let remaining = available;
		const order = lengths.map((_, index) => index).sort((a, b) => lengths[a] - lengths[b]);
		for (let i = 0; i < order.length; i++) {
			const index = order[i];
			budgets[index] = Math.min(lengths[index], Math.floor(remaining / (order.length - i)));
			remaining -= budgets[index];
		}
		const sections = bodies.map((body, index) => headers[index] + truncateOutput(body, budgets[index]));
		return truncateOutput(prefix + omission + sections.join("\n\n"), this.maxBytes);
	}
}
