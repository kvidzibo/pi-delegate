import assert from "node:assert/strict";
import { test } from "node:test";
import { HeadroomSession, headroomPolicyId, jsonBytes, planHeadroom, validateHeadroomPolicy } from "../headroom.ts";

const policy = { maxInputBytes: 65536, maxToolResultBytes: 512, maxToolBatchBytes: 768, reserveTokens: 4096 };
const model = { api: "openai-completions", contextWindow: 32768, maxTokens: 8192 };
const request = (contents: string[] = []) => ({ model: "fixture", max_tokens: 4096,
	messages: [{ role: "user", content: "Find evidence." }, ...contents.map((content, i) => ({ role: "tool", tool_call_id: `id${i}`, content }))],
	tools: [{ type: "function", function: { name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } } }],
});

test("JSON byte sizing matches serialization for escaping, Unicode, arrays and shared data", () => {
	const shared = { text: "shared" };
	const values = [null, true, false, 0, -0, 1e21, 1e-9, "", String.fromCharCode(34, 92, 0, 8, 9, 10, 12, 13, 31),
		"界🧪\u2028\u2029", "\ud800\udfff\ud800", { a: undefined, b: null, nested: [undefined, 4, "text"] }, { first: shared, second: shared }];
	for (const value of values) {
		const bytes = Buffer.byteLength(JSON.stringify(value));
		assert.equal(jsonBytes(value), bytes);
		for (const limit of [0, 1, 5, 20, 100]) assert.equal(jsonBytes(value, limit), Math.min(bytes, limit + 1));
	}
});

test("inspection rejects unknown data without invoking getters or serialization hooks", () => {
	let calls = 0;
	const getter = { get secret() { calls++; return "unknown"; } };
	const toJSON = Object.defineProperty({}, "toJSON", { value: () => { calls++; return "surprise"; } });
	for (const value of [getter, toJSON, new Date(), new Uint8Array([1]), 1n, NaN, Infinity, () => null]) assert.throws(() => jsonBytes(value));
	const cycle: any = {}; cycle.self = cycle; assert.throws(() => jsonBytes(cycle), /cycle/);
	let nested: any = {}; for (let i = 0; i < 70; i++) nested = { nested };
	assert.throws(() => jsonBytes(nested), /inspection limits/); assert.equal(calls, 0);
});

test("headroom policy is explicit, bounded, copied and stably identified", () => {
	assert.deepEqual(validateHeadroomPolicy(policy), policy); assert.notEqual(validateHeadroomPolicy(policy), policy);
	assert.equal(headroomPolicyId(policy), headroomPolicyId({ ...policy }));
	assert.notEqual(headroomPolicyId(policy), headroomPolicyId({ ...policy, reserveTokens: 4097 }));
	for (const patch of [{ maxInputBytes: 0 }, { maxInputBytes: Infinity }, { maxToolResultBytes: 63 }, { maxToolBatchBytes: 1 }, { reserveTokens: 0 }, { reserveTokens: 1.5 }]) {
		assert.throws(() => validateHeadroomPolicy({ ...policy, ...patch }));
	}
});

test("small requests preserve every field and output limit without retaining mutable source references", () => {
	const source = request(["Small result."]), before = structuredClone(source);
	const planned = planHeadroom(source, model, policy);
	assert.deepEqual(source, before); assert.deepEqual(planned.payload, before);
	assert.equal(planned.clippedToolResults, 0); assert.equal(planned.finalize, false);
	assert.equal(planned.reservedTokens, 4096); assert.equal(planned.inputLimitBytes, 32768 - 4096 - 1024);
	assert.equal(planned.inputBytes, Buffer.byteLength(JSON.stringify(planned.payload)));
	source.messages[0].content = "changed";
	assert.equal((planned.payload.messages as any[])[0].content, "Find evidence.");
});

test("per-result and aggregate budgets prefer newest evidence and mark every shortened result", () => {
	const source = request(["OLD ".repeat(1000), "NEW ".repeat(1000)]), before = structuredClone(source);
	const planned = planHeadroom(source, model, policy), tools = (planned.payload.messages as any[]).filter(row => row.role === "tool");
	assert.equal(planned.clippedToolResults, 2); assert.equal(planned.finalize, true);
	assert.ok(tools.every(row => jsonBytes(row.content) <= policy.maxToolResultBytes));
	assert.ok(tools.reduce((sum, row) => sum + jsonBytes(row.content), 0) <= policy.maxToolBatchBytes);
	assert.ok(jsonBytes(tools[1].content) >= jsonBytes(tools[0].content));
	for (const row of tools) assert.match(row.content, /shortened for context/);
	assert.match(tools[1].content, /NEW/); assert.deepEqual(source, before);
	assert.deepEqual(planned.payload.tools, source.tools);
});

test("Unicode and escaping cannot exceed encoded budgets or split valid surrogate pairs", () => {
	const source = request([("🧪界" + String.fromCharCode(0, 34, 92, 10)).repeat(1000)]);
	for (const maxToolResultBytes of [64, 65, 100, 512]) {
		const planned = planHeadroom(source, model, { ...policy, maxToolResultBytes });
		const text = (planned.payload.messages as any[])[1].content as string;
		assert.ok(jsonBytes(text) <= maxToolResultBytes); assert.equal(text.isWellFormed(), true);
		assert.equal(planned.inputBytes, Buffer.byteLength(JSON.stringify(planned.payload)));
	}
});

for (const api of ["openai-responses", "openai-codex-responses", "azure-openai-responses", "anthropic-messages"]) {
	test(`${api} shapes tool outputs without changing calls, signed thinking or other metadata`, () => {
		const result = "Evidence ".repeat(1000), signed = { type: "thinking", thinking: "retained reasoning", signature: "retained signature" };
		const source = api === "anthropic-messages" ? { model: "fixture", max_tokens: 4096,
			messages: [{ role: "assistant", content: [signed, { type: "tool_use", id: "id1", name: "read", input: { path: "file" } }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "id1", content: [{ type: "text", text: result }], cache_control: { type: "ephemeral" } }] }] }
			: { model: "fixture", max_output_tokens: 4096, input: [{ type: "function_call", call_id: "id1", name: "read", arguments: '{"path":"file"}' },
				{ type: "function_call_output", call_id: "id1", output: result }] };
		const before = structuredClone(source), planned = planHeadroom(source, { ...model, api }, policy);
		assert.equal(planned.clippedToolResults, 1); assert.deepEqual(source, before);
		if (api === "anthropic-messages") {
			const messages = planned.payload.messages as any[];
			assert.deepEqual(messages[0], before.messages![0]);
			assert.deepEqual(messages[1].content[0].cache_control, { type: "ephemeral" });
			assert.match(messages[1].content[0].content, /shortened/);
		} else {
			assert.deepEqual((planned.payload.input as any[])[0], before.input![0]);
			assert.match((planned.payload.input as any[])[1].output, /shortened/);
		}
	});
}

test("tool-result-looking data in an assistant row is never rewritten as an Anthropic user result", () => {
	const source = { max_tokens: 4096, messages: [{ role: "assistant", content: [
		{ type: "tool_result", tool_use_id: "not-a-user-result", content: "Protected assistant data ".repeat(100) },
	] }] };
	const plan = planHeadroom(source, { ...model, api: "anthropic-messages" }, policy);
	assert.deepEqual(plan.payload, source); assert.equal(plan.clippedToolResults, 0);
});

test("Responses grammar-tool outputs receive the same individual and aggregate limits", () => {
	const source = { max_output_tokens: 4096, input: [
		{ type: "custom_tool_call", call_id: "grammar", name: "edit", input: "unchanged grammar input" },
		{ type: "custom_tool_call_output", call_id: "grammar", output: "Large output ".repeat(1000) },
	] };
	const planned = planHeadroom(source, { ...model, api: "openai-responses" }, policy);
	assert.equal(planned.clippedToolResults, 1);
	assert.ok(jsonBytes((planned.payload.input as any[])[1].output) <= policy.maxToolResultBytes);
	assert.deepEqual((planned.payload.input as any[])[0], source.input[0]);
});

test("output reservation uses requested limits and falls back to the declared model maximum", () => {
	const source = request(); source.max_tokens = 16384;
	const planned = planHeadroom(source, model, policy);
	assert.equal(planned.reservedTokens, 16384); assert.equal(planned.payload.max_tokens, 16384);
	assert.equal(planned.inputLimitBytes, 32768 - 16384 - 1024);
	const { max_tokens: _, ...without } = source;
	assert.equal(planHeadroom(without, model, policy).reservedTokens, model.maxTokens);
	assert.throws(() => planHeadroom({ ...source, max_tokens: null }, model, policy), /output-token limit/);
	assert.throws(() => planHeadroom({ ...source, max_tokens: 32000 }, model, policy), /No declared context headroom/);
});

test("unknown limits/shapes and oversized non-tool context refuse instead of trimming the task", () => {
	assert.throws(() => planHeadroom(request(), { ...model, contextWindow: 0 }, policy), /known model limits/);
	assert.throws(() => planHeadroom(request(), { ...model, api: "unknown" }, policy), /supported/);
	assert.throws(() => planHeadroom({ model: "fixture" }, model, policy), /message shape/);
	const source = request(); source.messages[0].content = "Task data ".repeat(10000);
	assert.throws(() => planHeadroom(source, model, policy), /Non-tool context/);
	assert.equal(source.messages[0].content.length, 100000);
});

test("declared model mismatches and server-retained Responses context refuse without guessing", () => {
	assert.throws(() => planHeadroom(request(), { ...model, id: "another-model" }, policy), /Request model differs/);
	assert.equal(planHeadroom(request(), { ...model, id: "fixture" }, policy).finalize, false);
	for (const extra of [{ previous_response_id: "hidden" }, { conversation: "hidden" }, { prompt: { id: "saved" } },
		{ input: [{ type: "item_reference", id: "hidden" }] }]) {
		assert.throws(() => planHeadroom({ max_output_tokens: 4096, input: [], ...extra }, { ...model, api: "openai-responses" }, policy), /Server-retained/);
	}
});

test("custom array prototypes and executable methods cannot be invoked during inspection", () => {
	let invoked = false;
	const messages = [{ role: "user", content: "Task" }];
	Object.defineProperty(messages, "map", { value: () => { invoked = true; return []; } });
	assert.throws(() => planHeadroom({ messages }, model, policy), /array properties/);
	class CustomArray extends Array { toJSON() { invoked = true; return []; } }
	assert.throws(() => jsonBytes(new CustomArray()), /opaque/); assert.equal(invoked, false);
});

test("multimodal input refuses even if its encoded byte count is small", () => {
	for (const type of ["image", "image_url", "input_image", "audio", "document"]) {
		assert.throws(() => planHeadroom({ ...request(), messages: [{ role: "user", content: [{ type, data: "unknown token footprint" }] }] }, model, policy), /Multimodal/);
	}
});

test("protected replay preserves earlier projections while allocating fresh results from remaining space", () => {
	const session = new HeadroomSession(policy), source = request(["OLD ".repeat(1000)]);
	const first = session.plan(source, model), old = (first.payload.messages as any[])[1].content;
	(source.messages as any[]).push({ role: "assistant", content: "Earlier answer", reasoning_content: "unchanged" },
		{ role: "tool", tool_call_id: "new", content: "NEW ".repeat(1000) });
	const before = structuredClone(source), second = session.plan(source, model), rows = second.payload.messages as any[];
	assert.equal(rows[1].content, old); assert.deepEqual(rows[2], source.messages[2]);
	assert.ok(jsonBytes(rows[3].content) < jsonBytes(old)); assert.match(rows[3].content, /NEW/);
	assert.equal(second.clippedToolResults, 2); assert.deepEqual(source, before);
	// Returned data is not the retained projection cache.
	rows[1].content = "MUTATED";
	assert.equal((session.plan(source, model).payload.messages as any[])[1].content, old);
});

test("protected replay refuses changed/disappeared identities and commits no state after refusal", () => {
	const session = new HeadroomSession(policy), source = request(["A".repeat(1000), "B".repeat(1000)]);
	const first = session.plan(source, model);
	for (const bad of [request(["changed", "B".repeat(1000)]), request(["A".repeat(1000)]),
		{ ...source, messages: [...source.messages, { role: "tool", tool_call_id: "id0", content: "duplicate" }] },
		{ ...source, messages: [...source.messages, { role: "tool", tool_call_id: "id2", content: "C".repeat(1000) }] }]) {
		assert.throws(() => session.plan(bad, model));
	}
	assert.deepEqual(session.plan(source, model), first);
	assert.throws(() => session.plan(source, { ...model, api: "anthropic-messages" }), /API changed/);
});

test("protected replay does not rewrite unknown prefixes preceding signed assistant responses", () => {
	const session = new HeadroomSession(policy);
	const source = { max_tokens: 4096, messages: [
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "old", content: "OLD ".repeat(1000) }] },
		{ role: "assistant", content: [{ type: "thinking", thinking: "retained", signature: "signature" }] },
	] };
	assert.throws(() => session.plan(source, { ...model, api: "anthropic-messages" }), /Previously presented/);
	source.messages[0].content[0].content = "Small prior result";
	assert.deepEqual(session.plan(source, { ...model, api: "anthropic-messages" }).payload, source);
});

test("provider cache-marker movement does not change text identity or accumulate obsolete markers", () => {
	for (const text of ["small", "large ".repeat(1000)]) {
		const session = new HeadroomSession(policy), source = request([text]);
		(source.messages[1] as any).content = [{ type: "text", text, cache_control: { type: "ephemeral" } }];
		const first = session.plan(source, model);
		(source.messages[1] as any).content = text;
		(source.messages as any[]).push({ role: "assistant", content: "Report" });
		const second = session.plan(source, model);
		assert.equal((second.payload.messages as any[])[1].content,
			first.clippedToolResults ? (first.payload.messages as any[])[1].content : text);
	}
});

test("protected replay bounds raw inspection as well as retained request data", () => {
	const session = new HeadroomSession(policy);
	assert.throws(() => session.plan(request(["x".repeat(4 * 1024 * 1024)]), model), /inspection byte limit/);
	assert.equal(session.plan(request(), model).finalize, false);
});

test("tiny tool results are preserved rather than expanded into omission markers", () => {
	const source = request(Array(100).fill(""));
	const planned = planHeadroom(source, model, policy);
	assert.equal(planned.clippedToolResults, 0); assert.deepEqual(planned.payload, source);
});
