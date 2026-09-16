import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { FileCapacityBroker } from "../../delegate/capacity.ts";
import { validateLeaseIdentity, sameLease, readLeaseIdentity } from "../lease.ts";
import { GUARD_ENV, GUARD_NOTICE } from "../guard-protocol.ts";
import { encodeRpc, type RunPiChildInput } from "../spawn.ts";
import { mockChild, runMockPiChild } from "./helpers.ts";

const linux = { skip: process.platform !== "linux" };
function fixture(t: TestContext) {
	const root = mkdtempSync("/tmp/pi-delegate-lease-runtime-");
	const lease = new FileCapacityBroker(root).tryAcquire({ key: "runtime-test", capacity: 1 })!;
	t.after(() => { lease.release(); rmSync(root, { recursive: true, force: true }); });
	const proc = mockChild(); let options: any;
	const input: RunPiChildInput = { cwd: root, model: "test/model", task: "must wait for lease acknowledgement", hardTimeoutMs: 0,
		maxOutputBytes: 1000, env: {}, buildArgs: () => [], resourceLease: lease.inherited,
		promptSourcePath: fileURLToPath(new URL("../../delegate/prompts/recon.md", import.meta.url)),
		execution: { tools: ["read"], finalizeAfterMs: 0, finalizationGraceMs: 1000, startupTimeoutMs: 1000 },
		spawnFn: (_command, _args, value) => { options = value; return proc; },
	};
	return { input, proc, lease, options: () => options };
}

test("lease identities reject malformed values and reserve fd 3+ for non-stdio files", linux, () => {
	assert.deepEqual(validateLeaseIdentity({ dev: "12", ino: "34" }), { dev: "12", ino: "34" });
	for (const value of [null, {}, { dev: 1, ino: "2" }, { dev: "-1", ino: "2" }, { dev: "1", ino: "x" }]) assert.throws(() => validateLeaseIdentity(value));
	assert.equal(sameLease(undefined, undefined), true); assert.equal(sameLease({ dev: "1", ino: "2" }, undefined), false);
	for (const fd of [0, 1, 2, -1, 1.5, NaN]) assert.throws(() => readLeaseIdentity(fd), /descriptor/);
});

test("leased child startup inherits the descriptor and requires its correlated acknowledgement", linux, async t => {
	const f = fixture(t), pending = runMockPiChild(f.input);
	try {
		const options = f.options(); assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe", f.lease.inherited.fd]);
		const config = JSON.parse(options.env[GUARD_ENV]);
		assert.deepEqual(config.lease, { dev: f.lease.inherited.dev, ino: f.lease.inherited.ino });
		assert.equal(f.proc.stdinBytes, "");
		f.proc.stdout!.write(encodeRpc({ type: "extension_ui_request", method: "notify", message: JSON.stringify({
			type: GUARD_NOTICE, nonce: config.nonce, version: 1, event: "ready", tools: ["read"], lease: config.lease,
			state: { phase: "running", activeTools: 0 },
		}) }));
		for (let i = 0; i < 20 && !f.proc.stdinBytes.includes('"id":"p1"'); i++) await Promise.resolve();
		assert.ok(f.proc.stdinBytes.includes('"id":"p1"'));
		f.proc.stdout!.write(encodeRpc({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done." }] } }));
		f.proc.stdout!.write(encodeRpc({ type: "agent_settled" }));
		assert.equal((await pending).stopReason, "stop");
		assert.doesNotThrow(() => readLeaseIdentity(f.lease.inherited.fd), "runtime must not close the scheduler's borrowed descriptor");
	} finally { f.proc.close(1); await pending; }
});

for (const acknowledgement of ["missing", "wrong"] as const) {
	test(`${acknowledgement} inherited-lease acknowledgement refuses the task`, linux, async t => {
		const f = fixture(t), pending = runMockPiChild(f.input);
		try {
			const config = JSON.parse(f.options().env[GUARD_ENV]);
			const lease = acknowledgement === "wrong" ? { dev: config.lease.dev, ino: config.lease.ino === "0" ? "1" : "0" } : undefined;
			f.proc.stdout!.write(encodeRpc({ type: "extension_ui_request", method: "notify", message: JSON.stringify({
				type: GUARD_NOTICE, nonce: config.nonce, version: 1, event: "ready", tools: ["read"], lease,
				state: { phase: "running", activeTools: 0 },
			}) }));
			const result = await pending;
			assert.equal(result.stopReason, "guard-error"); assert.match(result.text, /expected inherited resource lease/);
			assert.equal(f.proc.stdinBytes.includes('"id":"p1"'), false);
		} finally { f.proc.close(1); await pending; }
	});
}

test("missing guard or changed parent descriptor fails before spawning, never uncoordinated", linux, async t => {
	const f = fixture(t); let spawns = 0;
	const spawnFn = () => { spawns++; return f.proc; };
	await assert.rejects(runMockPiChild({ ...f.input, execution: undefined, spawnFn }), /require guarded/);
	await assert.rejects(runMockPiChild({ ...f.input, resourceLease: { ...f.lease.inherited, ino: "0" }, spawnFn }), /identity changed/);
	await assert.rejects(runMockPiChild({ ...f.input, resourceLease: null as any, spawnFn }), /descriptor/);
	assert.equal(spawns, 0);
});
