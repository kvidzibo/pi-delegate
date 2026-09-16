import { truncateOutput } from "./policy.ts";

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
	private previous: PhaseAnswer[] = [];
	private omitted = 0;

	constructor(maxBytes: number) { this.maxBytes = maxBytes; }

	observe(answer: Answer): void {
		this.current = {
			phase: this.phase, message: ++this.sequence,
			text: truncateOutput(answer.text, this.maxBytes), stopReason: answer.stopReason,
			errorMessage: answer.errorMessage === undefined ? undefined : truncateOutput(answer.errorMessage, this.maxBytes),
		};
	}

	/** A killed guarded stream is evidence, not a finalized assistant message. */
	observePartial(text: string): void {
		this.current = { phase: this.phase, partial: true, text: truncateOutput(text, this.maxBytes) };
	}

	beginWrap(): void {
		if (this.current || this.phase > 0) {
			this.previous.push(this.current ?? { phase: this.phase, text: "" });
			// At most eight phases including current: keep the first and six most recent sealed phases.
			if (this.previous.length > 7) { this.previous.splice(1, 1); this.omitted++; }
		}
		this.current = undefined;
		this.phase++;
	}

	get awaitingResponse(): boolean { return this.phase > 0 && !this.current; }

	format(unwrappedText: string, cause?: string): string {
		if (this.phase === 0) return unwrappedText;
		const latest = this.current ?? { phase: this.phase, text: "" };
		const answers = [...this.previous, latest];
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
			return room > 0
				? notice + truncateOutput(`${headers.at(-1)}${bodies.at(-1)}`, room)
				: truncateOutput(notice, this.maxBytes);
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
