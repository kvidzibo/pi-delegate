import { createHash } from "node:crypto";

export interface HeadroomPolicy {
	/** JSON payload ceiling before transport framing, not a tokenizer measurement. */
	maxInputBytes: number;
	/** JSON-encoded tool-result content, individually and across each request. */
	maxToolResultBytes: number;
	maxToolBatchBytes: number;
	/** Reserve at least this many declared tokens; larger requested output limits win. */
	reserveTokens: number;
}
export interface HeadroomModel { api: string; contextWindow: number; maxTokens: number; id?: string }
export interface HeadroomPlan {
	payload: Record<string, unknown>;
	inputBytes: number;
	inputLimitBytes: number;
	reservedTokens: number;
	clippedToolResults: number;
	finalize: boolean;
}

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_NODES = 50000;
const MAX_SLOTS = 4096;
const CONTROL_MARGIN = 1024;
const NOTICE = "[Tool result shortened for context.]";
const APIS = new Set(["openai-completions", "openai-responses", "openai-codex-responses", "azure-openai-responses", "anthropic-messages"]);
const integer = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;

export function validateHeadroomPolicy(value: unknown): HeadroomPolicy {
	const raw = value as Partial<HeadroomPolicy> | undefined;
	if (!raw || !integer(raw.maxInputBytes, 2048, MAX_BYTES) || !integer(raw.maxToolResultBytes, 64, MAX_BYTES)
		|| !integer(raw.maxToolBatchBytes, raw.maxToolResultBytes, MAX_BYTES) || raw.maxToolBatchBytes > raw.maxInputBytes
		|| !integer(raw.reserveTokens, 1024, 16 * MAX_BYTES)) throw new Error("Invalid text headroom policy.");
	return { maxInputBytes: raw.maxInputBytes, maxToolResultBytes: raw.maxToolResultBytes,
		maxToolBatchBytes: raw.maxToolBatchBytes, reserveTokens: raw.reserveTokens };
}

export function headroomPolicyId(policy: HeadroomPolicy): string {
	return createHash("sha256").update(JSON.stringify(validateHeadroomPolicy(policy))).digest("hex");
}

export function validateHeadroomModel(model: HeadroomModel): void {
	if (!model || !APIS.has(model.api) || !integer(model.contextWindow, 1, 16 * MAX_BYTES) || !integer(model.maxTokens, 1, 16 * MAX_BYTES)) {
		throw new Error("Text headroom requires supported OpenAI/Anthropic request shapes and known model limits.");
	}
}

/** Exact UTF-8 JSON size for plain data, saturated at limit+1. Never invokes getters/toJSON. */
export function jsonBytes(value: unknown, limit = MAX_BYTES): number {
	let total = 0, nodes = 0;
	const parents = new Set<object>();
	const add = (count: number) => { total = Math.min(limit + 1, total + count); };
	const string = (text: string) => {
		add(2);
		for (let i = 0; i < text.length && total <= limit; i++) {
			const code = text.charCodeAt(i);
			if (code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code)) add(2);
			else if (code < 32) add(6);
			else if (code < 128) add(1);
			else if (code < 2048) add(2);
			else if (code >= 0xd800 && code <= 0xdfff) {
				const next = text.charCodeAt(i + 1);
				if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) { add(4); i++; } else add(6);
			} else add(3);
		}
	};
	const visit = (item: unknown, depth: number) => {
		if (total > limit) return;
		if (++nodes > MAX_NODES || depth > 64) throw new Error("Headroom payload structure exceeds inspection limits.");
		if (item === undefined || item === null) { add(4); return; }
		if (typeof item === "string") { string(item); return; }
		if (typeof item === "boolean") { add(item ? 4 : 5); return; }
		if (typeof item === "number" && Number.isFinite(item)) { add(String(Object.is(item, -0) ? 0 : item).length); return; }
		if (typeof item !== "object") throw new Error("Headroom payload contains non-JSON data.");
		if (parents.has(item)) throw new Error("Headroom payload contains a cycle.");
		const array = Array.isArray(item), proto = Object.getPrototypeOf(item);
		if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw new Error("Headroom payload contains opaque data.");
		const descriptors = Object.getOwnPropertyDescriptors(item);
		if (Object.values(descriptors).some(field => field.get || field.set) || typeof descriptors.toJSON?.value === "function") throw new Error("Headroom payload accessors/serialization hooks are unsupported.");
		const type = descriptors.type?.value;
		if (["image", "image_url", "input_image", "input_audio", "audio", "document", "input_file"].includes(type)) {
			throw new Error("Multimodal input cannot be bounded by the text headroom policy.");
		}
		parents.add(item); add(2);
		try {
			if (array) {
				for (let i = 0; i < item.length && total <= limit; i++) { if (i) add(1); visit(descriptors[String(i)]?.value, depth + 1); }
			} else {
				let count = 0;
				for (const [key, field] of Object.entries(descriptors)) {
					if (!field.enumerable || field.value === undefined) continue;
					if (total > limit) break;
					if (count++) add(1); string(key); add(1); visit(field.value, depth + 1);
				}
			}
		} finally { parents.delete(item); }
	};
	visit(value, 0); return total;
}

type Projection = { id: string; digest: string; value: unknown; clipped: boolean };
type Slot = { value: unknown; bytes: number; baseBytes: number; fixed: boolean; projection?: Projection; set: (value: unknown) => void };
function record(value: unknown): Record<string, any> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("Unsupported headroom request shape.");
	if (Object.values(Object.getOwnPropertyDescriptors(value)).some(field => field.get || field.set)) throw new Error("Headroom payload accessors are unsupported.");
	return value as Record<string, any>;
}
function array(value: unknown): unknown[] {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_NODES) throw new Error("Unsupported headroom message shape.");
	const descriptors = Object.getOwnPropertyDescriptors(value);
	if (Object.values(descriptors).some(field => field.get || field.set)) throw new Error("Headroom payload accessors are unsupported.");
	if (Object.keys(descriptors).some(key => key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key))) throw new Error("Unsupported headroom array properties.");
	return value;
}

function contentDigest(value: unknown): string {
	// Pi may move cache markers and convert a lone text block back to a string on replay.
	const textOnly = Array.isArray(value) && value.every(block => block && typeof block === "object"
		&& ["text", "input_text"].includes(block.type) && typeof block.text === "string"
		&& Object.keys(block).every(key => ["type", "text", "cache_control"].includes(key)));
	const canonical = textOnly ? value.map(block => block.text).join("\n") : value;
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Only protocol positions are tool output; never recursively rewrite arguments/schemas. */
function slotsFor(payload: Record<string, unknown>, api: string, slots: Slot[], prior?: Projection[]): Record<string, unknown> {
	const rows = array(api === "openai-completions" || api === "anthropic-messages" ? payload.messages : payload.input).map(record);
	const lastAssistant = rows.findLastIndex(row => row.role === "assistant" || ["reasoning", "function_call", "custom_tool_call"].includes(row.type));
	const ids = new Set<string>();
	const add = (row: Record<string, unknown>, key: string, idKey: string, position: number) => {
		if (slots.length >= MAX_SLOTS) throw new Error("Too many tool results for text headroom inspection.");
		const value = row[key];
		if (typeof value !== "string" && !Array.isArray(value)) throw new Error("Unsupported tool-result content.");
		const bytes = jsonBytes(value), markerBytes = jsonBytes(NOTICE);
		let fixed = false, projection: Projection | undefined;
		if (prior) {
			const id = row[idKey];
			if (typeof id !== "string" || !id || id.length > 256 || ids.has(id)) throw new Error("Ambiguous tool-result identity for headroom replay.");
			ids.add(id);
			const digest = contentDigest(value);
			const previous = prior[slots.length];
			if (previous && (previous.id !== id || previous.digest !== digest)) throw new Error("Tool-result history changed during protected replay.");
			// Do not rewrite a prefix already used to produce an assistant response/signature.
			fixed = !!previous || position < lastAssistant;
			projection = previous ? { ...previous, value: previous.clipped ? previous.value : value } : { id, digest, value, clipped: false };
		}
		row[key] = fixed ? projection!.value : bytes <= markerBytes ? value : NOTICE;
		slots.push({ value, bytes, fixed, projection, baseBytes: jsonBytes(row[key]), set: next => {
			row[key] = next;
			if (projection) { projection.value = next; projection.clipped = next !== value; }
		} });
	};
	let shaped: Record<string, unknown>;
	if (api === "openai-completions") shaped = { ...payload, messages: rows.map((row, i) => {
		if (row.role !== "tool") return row;
		const copy = { ...row }; add(copy, "content", "tool_call_id", i); return copy;
	}) };
	else if (api === "anthropic-messages") shaped = { ...payload, messages: rows.map((row, i) => {
		if (row.role !== "user" || !Array.isArray(row.content)) return row;
		return { ...row, content: row.content.map(value => {
			const block = record(value); if (block.type !== "tool_result") return block;
			const copy = { ...block }; add(copy, "content", "tool_use_id", i); return copy;
		}) };
	}) };
	else shaped = { ...payload, input: rows.map((row, i) => {
		if (row.type !== "function_call_output" && row.type !== "custom_tool_call_output") return row;
		const copy = { ...row }; add(copy, "output", "call_id", i); return copy;
	}) };
	if (prior && slots.length < prior.length) throw new Error("Tool-result history disappeared during protected replay.");
	return shaped;
}

function shortened(value: unknown, budget: number): string {
	const chunks = typeof value === "string" ? [value] : array(value).map(part => {
		const block = record(part);
		if (!["text", "input_text"].includes(block.type) || typeof block.text !== "string") throw new Error("Unsupported tool-result text block.");
		return block.text as string;
	});
	let text = "";
	for (const chunk of chunks) { text += (text ? "\n" : "") + chunk.slice(0, Math.max(0, budget - text.length)); if (text.length >= budget) break; }
	let low = 0, high = Math.min(text.length, budget), best = NOTICE;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		let end = middle;
		if (end && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
		const candidate = end ? `${text.slice(0, end)}\n${NOTICE}` : NOTICE;
		if (jsonBytes(candidate, budget) <= budget) { best = candidate; low = middle + 1; } else high = middle - 1;
	}
	return best;
}

/** Request-only shaping. Native session messages, model metadata and output parameters are untouched. */
export function planHeadroom(input: unknown, model: HeadroomModel, policyInput: HeadroomPolicy): HeadroomPlan {
	return buildPlan(input, model, policyInput).plan;
}

/** Bounded per-child request projections. Earlier presented results are never re-clipped. */
export class HeadroomSession {
	private readonly policy: HeadroomPolicy;
	private prior: Projection[] = [];
	private api?: string;
	constructor(policy: HeadroomPolicy) { this.policy = validateHeadroomPolicy(policy); }
	plan(input: unknown, model: HeadroomModel): HeadroomPlan {
		if (this.api && model?.api !== this.api) throw new Error("Provider API changed during protected replay.");
		const { plan, projections } = buildPlan(input, model, this.policy, this.prior);
		// Commit only after full validation; neither caller nor transport can mutate retained data.
		this.prior = structuredClone(projections); this.api = model.api;
		return plan;
	}
}

function buildPlan(input: unknown, model: HeadroomModel, policyInput: HeadroomPolicy, prior?: Projection[]): { plan: HeadroomPlan; projections: Projection[] } {
	const policy = validateHeadroomPolicy(policyInput); validateHeadroomModel(model);
	const payload = record(input);
	const sourceBytes = jsonBytes(payload);
	if (prior && sourceBytes > MAX_BYTES) throw new Error("Protected replay source exceeds the inspection byte limit.");
	if (model.id && model.api !== "azure-openai-responses" && payload.model !== model.id) {
		throw new Error("Request model differs from the declared headroom model.");
	}
	if (model.api.includes("responses") && (["previous_response_id", "conversation", "prompt"].some(key => payload[key] != null)
		|| (Array.isArray(payload.input) && array(payload.input).map(record).some(row => row.type === "item_reference")))) {
		throw new Error("Server-retained context cannot be inspected by the text headroom policy.");
	}
	const keys = model.api === "openai-completions" ? ["max_tokens", "max_completion_tokens"]
		: model.api === "anthropic-messages" ? ["max_tokens"] : ["max_output_tokens"];
	const outputs = keys.filter(key => payload[key] !== undefined).map(key => payload[key]);
	if (outputs.some(value => !integer(value, 1, 16 * MAX_BYTES))) throw new Error("Unknown requested output-token limit.");
	const reservedTokens = Math.max(policy.reserveTokens, ...(outputs.length ? outputs as number[] : [model.maxTokens]));
	// At most one input byte per remaining declared token. This is NOT tokenizer-exact,
	// nor a guarantee about hidden server prompts, and deliberately underuses many windows.
	const inputLimitBytes = Math.min(policy.maxInputBytes, model.contextWindow - reservedTokens) - CONTROL_MARGIN;
	if (inputLimitBytes < 1024) throw new Error("No declared context headroom remains after reserving output and control space.");
	const slots: Slot[] = [], shaped = slotsFor(payload, model.api, slots, prior);
	if (slots.some(slot => slot.fixed && slot.baseBytes > policy.maxToolResultBytes)) throw new Error("Previously presented tool output exceeds the per-result budget.");
	const baseline = jsonBytes(shaped, inputLimitBytes);
	if (baseline > inputLimitBytes) throw new Error("Non-tool context exceeds the protected request budget.");
	const baseToolBytes = slots.reduce((sum, slot) => sum + slot.baseBytes, 0);
	if (baseToolBytes > policy.maxToolBatchBytes) throw new Error("Required tool-result markers exceed the batch budget.");
	let available = Math.min(inputLimitBytes - baseline, policy.maxToolBatchBytes - baseToolBytes), clippedToolResults = 0;
	// Newest fresh evidence gets spare space first. Fixed prefixes consume their full budget.
	for (const slot of [...slots].reverse()) {
		if (slot.fixed) { if (slot.projection?.clipped) clippedToolResults++; continue; }
		const budget = Math.min(policy.maxToolResultBytes, slot.baseBytes + available);
		const value = slot.bytes <= budget ? slot.value : shortened(slot.value, budget);
		const used = jsonBytes(value, budget);
		if (used > budget) throw new Error("Tool-result clipping exceeded its reserved budget.");
		available -= used - slot.baseBytes; slot.set(value);
		if (value !== slot.value) clippedToolResults++;
	}
	const inputBytes = jsonBytes(shaped, inputLimitBytes);
	if (inputBytes > inputLimitBytes) throw new Error("Shaped request exceeds the protected budget.");
	return { plan: { payload: structuredClone(shaped), inputBytes, inputLimitBytes, reservedTokens, clippedToolResults,
		finalize: clippedToolResults > 0 || inputBytes >= Math.floor(inputLimitBytes * 0.8) },
		projections: slots.flatMap(slot => slot.projection ? [slot.projection] : []) };
}
