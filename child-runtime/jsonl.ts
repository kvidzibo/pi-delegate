import { truncateToUtf8Bytes } from "./policy.ts";

// Transport budget, deliberately independent of the returned-answer budget.
export const RPC_RECORD_LIMIT_BYTES = 8 * 1024 * 1024;

/** Strict LF framing with bounded per-record storage, including unterminated records. */
export class JsonlReader {
	private parts: string[] = [];
	private bytes = 0;
	private discarding = false;
	private readonly maxBytes: number;
	private readonly onLine: (line: string) => void;
	private readonly onOversized: (prefix: string) => void;

	constructor(input: { maxBytes: number; onLine: (line: string) => void; onOversized: (prefix: string) => void }) {
		if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1) throw new Error("Invalid JSONL byte limit");
		this.maxBytes = input.maxBytes;
		this.onLine = input.onLine;
		this.onOversized = input.onOversized;
	}

	write(chunk: string): void {
		let start = 0;
		while (start < chunk.length) {
			const newline = chunk.indexOf("\n", start);
			const end = newline < 0 ? chunk.length : newline;
			if (!this.discarding && end > start) {
				const part = chunk.slice(start, end);
				const bytes = Buffer.byteLength(part, "utf8");
				if (this.bytes + bytes > this.maxBytes) {
					const prefix = this.parts.join("") + truncateToUtf8Bytes(part, this.maxBytes - this.bytes);
					this.parts = [];
					this.bytes = 0;
					this.discarding = true;
					this.onOversized(prefix);
				} else {
					this.parts.push(part);
					this.bytes += bytes;
				}
			}
			if (newline < 0) break;
			this.end();
			start = newline + 1;
		}
	}

	end(): void {
		const line = this.discarding ? undefined : this.parts.join("");
		this.parts = [];
		this.bytes = 0;
		this.discarding = false;
		if (line?.trim()) this.onLine(line);
	}
}

/**
 * Pi writes type first, and message.role first inside message events. Discard
 * only known non-answer frames. Unknown layouts and oversized assistant/control
 * frames must fail explicitly, never silently return an earlier answer.
 */
export function canDiscardOversizedEvent(prefix: string): boolean {
	const match = /^\s*\{\s*"type"\s*:\s*"([a-z_]+)"\s*,/.exec(prefix);
	if (!match) return false;
	if (["agent_end", "turn_end", "message_start", "tool_execution_update", "tool_execution_end"].includes(match[1])) {
		return true;
	}
	if (match[1] !== "message_end") return false;
	return /^\s*"message"\s*:\s*\{\s*"role"\s*:\s*"(?:toolResult|user)"\s*[,}]/.test(prefix.slice(match[0].length));
}
