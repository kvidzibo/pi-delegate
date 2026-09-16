import assert from "node:assert/strict";
import { test } from "node:test";
import { headroomPolicyId, jsonBytes, planHeadroom, validateHeadroomPolicy } from "../headroom.ts";

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

test("multimodal input refuses even if its encoded byte count is small", () => {
	for (const type of ["image", "image_url", "input_image", "audio", "document"]) {
		assert.throws(() => planHeadroom({ ...request(), messages: [{ role: "user", content: [{ type, data: "unknown token footprint" }] }] }, model, policy), /Multimodal/);
	}
});

test("tiny tool results are preserved rather than expanded into omission markers", () => {
	const source = request(Array(100).fill(""));
	const planned = planHeadroom(source, model, policy);
	assert.equal(planned.clippedToolResults, 0); assert.deepEqual(planned.payload, source);
});
