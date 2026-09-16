import assert from "node:assert/strict";
import { test } from "node:test";
import { FinalizationGate } from "../finalization.ts";

function deferred() {
	let resolve!: () => void;
	return { pending: new Promise<void>(next => { resolve = next; }), resolve: () => resolve() };
}

test("finalization stops fresh execution but lets an already-running tool finish", async () => {
	const gate = new FinalizationGate();
	const work = deferred();
	const running = gate.execute(async () => { await work.pending; return "finished"; });
	assert.deepEqual(gate.request(), { phase: "draining", activeTools: 1 });
	await assert.rejects(gate.execute(async () => { assert.fail("fresh tool body must not execute"); }), /finalization/);
	work.resolve();
	assert.equal(await running, "finished");
	assert.deepEqual(gate.snapshot(), { phase: "answering", activeTools: 0 });
});

test("tools prepared before acknowledgement are checked again at actual execution", async () => {
	const gate = new FinalizationGate();
	const preparedTool = () => gate.execute(async () => { assert.fail("preflight is not execution authority"); });
	assert.deepEqual(gate.request(), { phase: "answering", activeTools: 0 });
	await assert.rejects(preparedTool(), /finalization/);
});

test("repeated finalization is idempotent and does not reopen a drained gate", async () => {
	const gate = new FinalizationGate();
	assert.deepEqual(gate.request(), gate.request());
	assert.deepEqual(gate.snapshot(), { phase: "answering", activeTools: 0 });
	await assert.rejects(gate.execute(async () => "forbidden"), /finalization/);
});

test("failed and overlapping tools release exactly their own execution occupancy", async () => {
	const gate = new FinalizationGate();
	const work = deferred();
	const running = gate.execute(() => work.pending);
	const failed = gate.execute(async () => { throw new Error("tool failed"); });
	assert.deepEqual(gate.request(), { phase: "draining", activeTools: 2 });
	await assert.rejects(failed, /tool failed/);
	assert.deepEqual(gate.snapshot(), { phase: "draining", activeTools: 1 });
	work.resolve(); await running;
	assert.deepEqual(gate.snapshot(), { phase: "answering", activeTools: 0 });
});

test("observer failure cannot reopen the gate or change tool outcomes", async () => {
	const gate = new FinalizationGate(() => { throw new Error("dead observer"); });
	assert.equal(await gate.execute(async () => "result"), "result");
	assert.deepEqual(gate.request(), { phase: "answering", activeTools: 0 });
	await assert.rejects(gate.execute(async () => "forbidden"), /finalization/);
});
