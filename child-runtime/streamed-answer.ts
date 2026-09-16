import { truncateOutput, truncateToUtf8Bytes } from "./policy.ts";

/** Bounded, text-only evidence for a guarded child killed before message_end. */
export class StreamedAnswer {
	private readonly maxBytes: number;
	private active = false;
	private phase = 0;
	private blocks = new Map<number, string>();
	private bytes = 0;
	private truncated = new Set<number>();
	private omittedBlocks = false;

	constructor(maxBytes: number) { this.maxBytes = maxBytes; }

	get open(): boolean { return this.active; }
	get originPhase(): number { return this.phase; }

	observe(event: any, phase = 0): void {
		if ((event?.type === "message_start" || event?.type === "message_end") && event.message?.role === "assistant") {
			this.blocks.clear(); this.bytes = 0; this.truncated.clear(); this.omittedBlocks = false;
			this.active = event.type === "message_start";
			if (this.active) this.phase = phase;
			return;
		}
		if (!this.active || event?.type !== "message_update") return;
		const delta = event.assistantMessageEvent;
		if (!delta || !Number.isSafeInteger(delta.contentIndex) || delta.contentIndex < 0) return;
		if (delta.type !== "text_delta" && delta.type !== "text_end") return;
		const value = delta.type === "text_delta" ? delta.delta : delta.content;
		if (typeof value !== "string") return;
		const index = delta.contentIndex;
		if (!this.blocks.has(index) && this.blocks.size >= 32) { this.omittedBlocks = true; return; }
		const previous = this.blocks.get(index) ?? "";
		const previousBytes = Buffer.byteLength(previous);
		const next = delta.type === "text_delta" ? previous + value : value;
		const room = Math.max(0, this.maxBytes - (this.bytes - previousBytes));
		const text = truncateToUtf8Bytes(next, room);
		if (Buffer.byteLength(next) > room) this.truncated.add(index);
		else if (delta.type === "text_end") this.truncated.delete(index);
		this.blocks.set(index, text);
		this.bytes += Buffer.byteLength(text) - previousBytes;
	}

	text(): string | undefined {
		if (!this.active || this.bytes === 0) return;
		const text = [...this.blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text).join("\n");
		return truncateOutput((this.truncated.size || this.omittedBlocks ? "[Streamed evidence truncated]\n" : "") + text, this.maxBytes);
	}
}
