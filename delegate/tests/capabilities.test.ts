import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { capabilityContent, copyCapabilities, describeCapabilities, type CapabilityManifest } from "../capabilities.ts";
import { ArchivedRun, loadRuns, type RunIdentity } from "../archive.ts";
import { JobCards, CARD_STATE_TYPE } from "../cards.ts";
import { JobScheduler } from "../jobs.ts";
import type { ChildResult } from "../../child-runtime/spawn.ts";

const recon = ["read", "grep", "find", "ls", "bash"];

test("shipped recon declares a shell, not a filesystem sandbox or verified command availability", () => {
	const config = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8"));
	assert.deepEqual(config.agents.recon.tools, recon);
	assert.deepEqual(describeCapabilities(recon), { source: "configured", tools: recon, omittedTools: 0,
		shellTools: ["bash"], writeTools: [], unknownTools: 0, filesystemSandbox: false });
	const text = capabilityContent(describeCapabilities(recon))[0].text;
	assert.match(text, /not child-verified/); assert.match(text, /No filesystem sandbox/);
	assert.match(text, /Shell access can modify files/); assert.match(text, /read-only intent is not write protection/);
});

test("capabilities match exact CLI comma/whitespace parsing, not wildcard, alias or case assumptions", () => {
	const caps = describeCapabilities([" read, bash, ", "read", "BASH,*,all,none,custom", "powershell,write,edit"]);
	assert.deepEqual(caps.tools, ["read", "bash", "BASH", "*", "all", "none", "custom", "powershell", "write", "edit"]);
	assert.deepEqual(caps.shellTools, ["bash", "powershell"]); assert.deepEqual(caps.writeTools, ["write", "edit"]);
	assert.equal(caps.unknownTools, 5); assert.deepEqual(copyCapabilities(caps), caps);
	assert.deepEqual(describeCapabilities([" , , "]).tools, []);
});

test("absence of listed shell/write tools makes no read-only or test-execution guarantee", () => {
	const caps = describeCapabilities(["read", "grep", "find", "ls"]);
	assert.deepEqual(caps.shellTools, []); assert.deepEqual(caps.writeTools, []);
	assert.equal(caps.filesystemSandbox, false);
	assert.match(capabilityContent(caps)[0].text, /Shell tools: none listed/);
	assert.match(capabilityContent(describeCapabilities(["custom"]))[0].text, /availability and effects unknown/);
});

test("bounded manifests retain positive shell/write declarations even when names are omitted", () => {
	const caps = describeCapabilities([...Array.from({ length: 70 }, (_, i) => `custom${i}`), "x".repeat(129), "bash", "write"]);
	assert.equal(caps.tools.length, 64); assert.equal(caps.omittedTools, 9); assert.equal(caps.unknownTools, 71);
	assert.deepEqual(caps.shellTools, ["bash"]); assert.deepEqual(caps.writeTools, ["write"]);
	assert.deepEqual(copyCapabilities(caps), caps);
	assert.ok(Buffer.byteLength(capabilityContent(caps)[0].text) <= 512);
	for (const name of ["界".repeat(50), "a\u0000".repeat(20)]) {
		assert.deepEqual(describeCapabilities([name]).tools, []); assert.equal(describeCapabilities([name]).omittedTools, 1);
	}
	assert.ok(Buffer.byteLength(JSON.stringify(describeCapabilities(Array.from({ length: 70 }, (_, i) => `${i}${"界".repeat(40)}`)))) < 9000);
});

test("capability data blocks escape terminal controls and stay UTF-8 bounded", () => {
	const caps = describeCapabilities(["read", "\u001b[31mevil", "\u009b31m", "\u202eevil", ...Array(50).fill("界".repeat(120))]);
	const text = capabilityContent(caps)[0].text;
	assert.doesNotMatch(text, /[\u001b\u009b\u202e\ufffd]/); assert.ok(Buffer.byteLength(text) <= 512);
	assert.match(text, /not child-verified/); assert.match(text, /No filesystem sandbox/);
});

test("copiers reject malformed or contradictory capability claims without inventing legacy evidence", () => {
	const caps = describeCapabilities(recon);
	for (const bad of [undefined, null, {}, { ...caps, source: "verified" }, { ...caps, filesystemSandbox: true },
		{ ...caps, tools: "bash" }, { ...caps, tools: ["read,bash"] }, { ...caps, shellTools: [] },
		{ ...caps, writeTools: ["write"] }, { ...caps, omittedTools: -1 }, { ...caps, unknownTools: 1 },
		{ ...caps, omittedTools: 0.5 }, { ...caps, omittedTools: Number.MAX_SAFE_INTEGER }, { ...caps, tools: [...recon, "read"] }]) {
		assert.equal(copyCapabilities(bad), undefined); assert.deepEqual(capabilityContent(bad), []);
	}
	const copied = copyCapabilities(caps)!; copied.tools.push("custom"); copied.shellTools.length = 0;
	assert.deepEqual(caps, describeCapabilities(recon));
});

test("scheduler capabilities are detached at admission and every snapshot, including terminal collection", async () => {
	const scheduler = new JobScheduler({ maxConcurrent: 1, maxLocalConcurrent: 1, maxQueued: 1 });
	let finish!: (result: ChildResult) => void;
	const work = new Promise<ChildResult>(resolve => { finish = resolve; });
	const caps = describeCapabilities(recon);
	try {
		const job = scheduler.enqueue({ kind: "recon", model: "hosted/mock", local: false, task: "mock", timeoutMs: 1000,
			capabilities: caps, run: async () => work });
		caps.tools.length = 0; job.capabilities!.shellTools.length = 0;
		assert.deepEqual(scheduler.get(job.id).capabilities, describeCapabilities(recon));
		finish({ text: "Evidence", exitCode: 0, stderrTail: "" });
		const done = await scheduler.wait(job.id, { timeoutMs: 1000 });
		assert.equal(done.status, "done"); assert.deepEqual(done.capabilities, describeCapabilities(recon));
		done.capabilities!.tools.push("custom"); assert.deepEqual(scheduler.get(job.id).capabilities, describeCapabilities(recon));
	} finally { finish({ text: "cleanup", exitCode: 0, stderrTail: "" }); await scheduler.shutdown(); }
});

test("card history detaches capability arrays and drops unsupported claims", () => {
	const cards = new JobCards(), caps = describeCapabilities(recon);
	cards.update("origin", { status: "done", capabilities: caps }); caps.shellTools.length = 0;
	const row = cards.get("origin")!; (row.capabilities as CapabilityManifest).tools.length = 0;
	assert.deepEqual(cards.get("origin")!.capabilities, describeCapabilities(recon));
	const saved = { status: "done", originToolCallId: "restored", capabilities: describeCapabilities(recon) };
	cards.restore([{ type: "custom", customType: CARD_STATE_TYPE, data: saved }]); saved.capabilities.tools.length = 0;
	assert.deepEqual(cards.get("restored")!.capabilities, describeCapabilities(recon));
	cards.update("bad", { capabilities: { ...describeCapabilities(recon), filesystemSandbox: true } });
	assert.equal(cards.get("bad")!.capabilities, undefined);
});

test("archives and rebuild retain configured capabilities, not inferred legacy or malformed claims", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "delegate-capabilities-")); t.after(() => rmSync(root, { recursive: true, force: true }));
	const prompt = join(root, "source.md"); writeFileSync(prompt, "Offline fixture");
	const caps = describeCapabilities(["read,bash"]);
	const identity: RunIdentity = { parentSessionId: "parent", toolCallId: "call", kind: "recon", cwd: root,
		requestedModel: "mock/model", thinking: "off", tools: ["read,bash"], capabilities: caps };
	const run = new ArchivedRun(root, identity, "Task", prompt); caps.tools.length = 0;
	run.finishQueued("d0001", { status: "failed", exitCode: 1, stopReason: "aborted" });
	const expected = describeCapabilities(["read,bash"]);
	assert.deepEqual(run.data.capabilities, expected); assert.deepEqual(run.data.tools, ["read,bash"]);
	const before = readFileSync(run.paths.metadata, "utf8");
	assert.deepEqual((await loadRuns(root, { rebuild: true })).runs[0].capabilities, expected);
	assert.equal(readFileSync(run.paths.metadata, "utf8"), before);
	assert.deepEqual(JSON.parse(readFileSync(join(root, "usage.jsonl"), "utf8").trim().split("\n").at(-1)!).capabilities, expected);
	for (const capabilities of [undefined, { ...expected, filesystemSandbox: true }]) {
		writeFileSync(run.paths.metadata, JSON.stringify({ ...JSON.parse(before), capabilities }));
		const loaded = await loadRuns(root); assert.equal(loaded.runs[0].capabilities, undefined);
		assert.equal(loaded.runs[0].status, "failed"); assert.equal(loaded.warnings.length, 0);
	}
});
