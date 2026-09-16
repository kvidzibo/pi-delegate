import assert from "node:assert/strict";
import { test } from "node:test";
import { FinalizationGate } from "../finalization.ts";
import { installHeadroomGuard } from "../headroom-guard.ts";
import { headroomPolicyId, jsonBytes } from "../headroom.ts";

const policy = { maxInputBytes: 65536, maxToolResultBytes: 512, maxToolBatchBytes: 768, reserveTokens: 4096 };
const model = { api: "openai-completions", contextWindow: 32768, maxTokens: 8192 };
const payload = (text = "Evidence") => ({ max_tokens: 4096,
	messages: [{ role: "user", content: "Task" }, { role: "tool", tool_call_id: "read1", content: text }] });

function setup(options: { ready?: boolean; notifyThrows?: boolean; closeThrows?: boolean } = {}) {
	const hooks = new Map<string, Function>(), order: string[] = [], progress: any[] = [], stops: any[] = [];
	const stopped = new Error("test-only exit sentinel");
	const gate = new FinalizationGate(() => order.push(`gate:${gate.snapshot().phase}`));
	const installed = installHeadroomGuard({ on: (name: string, fn: Function) => { hooks.set(name, fn); } } as any, policy, {
		nonce: "headroom-fixture-nonce", ready: () => options.ready !== false, gate,
		closeTools: () => { order.push("tools:closed"); if (options.closeThrows) throw new Error("tools failed"); },
		notify: state => { progress.push(state); order.push(`headroom:${state.phase}`); if (options.notifyThrows) throw new Error("observer failed"); },
	}, state => { stops.push(state); throw stopped; });
	return { hooks, gate, order, progress, stops, stopped, installed,
		request: (value: unknown) => hooks.get("before_provider_request")!({ payload: value }, { model }) };
}

test("headroom hook returns detached safe payloads with explicit byte observations", () => {
	const child = setup(), source = payload(), before = structuredClone(source);
	assert.deepEqual(child.request(source), source); assert.deepEqual(source, before);
	assert.equal(child.gate.snapshot().phase, "running");
	assert.equal(child.progress[0].phase, "checked"); assert.equal(child.progress[0].policyId, headroomPolicyId(policy));
	assert.equal(child.progress[0].inputBytes, jsonBytes(source)); assert.equal(child.stops.length, 0);
});

test("pressure receipt precedes gate closure; active bodies drain while prepared bodies are blocked", async () => {
	const child = setup(); let finish!: () => void;
	const active = child.gate.execute(() => new Promise<void>(resolve => { finish = resolve; }));
	const prepared = () => child.gate.execute(() => assert.fail("must not enter a fresh tool"));
	child.order.length = 0;
	const source = payload("Evidence ".repeat(1000)), before = structuredClone(source), shaped = child.request(source);
	assert.deepEqual(source, before); assert.ok(jsonBytes(shaped.messages[1].content) <= policy.maxToolResultBytes);
	assert.equal(child.progress.at(-1).phase, "limited");
	assert.deepEqual(child.order, ["headroom:limited", "gate:draining", "tools:closed"]);
	await assert.rejects(prepared(), /finalization blocks/);
	finish(); await active; assert.equal(child.gate.snapshot().phase, "answering");
});

test("unsupported or unsafe requests invoke the dedicated-child stop, not a swallowed ordinary error", () => {
	for (const options of [{}, { ready: false }, { notifyThrows: true }, { closeThrows: true }]) {
		const child = setup(options), unsafe = { ...payload(), messages: [{ role: "user", content: "x".repeat(40000) }] };
		assert.throws(() => child.request(unsafe), error => error === child.stopped);
		assert.equal(child.stops.length, 1); assert.equal(child.stops[0].phase, "refused");
		assert.equal(child.gate.snapshot().phase, "answering");
	}
});

test("a failed pressure notification cannot leave provider dispatch enabled", () => {
	const child = setup({ notifyThrows: true });
	assert.throws(() => child.request(payload("x".repeat(1000))), error => error === child.stopped);
	assert.equal(child.stops.length, 1);
});

test("implicit and manual compaction are cancelled and request finalization without model work", () => {
	for (const reason of ["threshold", "overflow", "manual"]) {
		const child = setup();
		assert.deepEqual(child.hooks.get("session_before_compact")!({ reason }, {}), { cancel: true });
		assert.equal(child.progress[0].phase, "compaction-blocked");
		assert.equal(child.gate.snapshot().phase, "answering"); assert.equal(child.stops.length, 0);
	}
});

test("unsupported model metadata refuses before readiness", () => {
	const child = setup();
	assert.throws(() => child.installed.checkModel({ ...model, contextWindow: 0 }), error => error === child.stopped);
	assert.equal(child.progress[0].phase, "refused");
});
