import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { JobScheduler } from "../../delegate/jobs.ts";
import { runChild } from "../../delegate/spawn.ts";
import { DEFAULT_WRAP_MESSAGE, encodeRpc, runPiChild, type ChildControl, type RunPiChildInput } from "../spawn.ts";
import { mockChild, runMockPiChild } from "./helpers.ts";

const PROMPT = fileURLToPath(new URL("../../delegate/prompts/recon.md", import.meta.url));
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function start(t: TestContext, overrides: Partial<RunPiChildInput> = {}) {
	const proc = mockChild();
	let control!: ChildControl;
	const pending = runMockPiChild({
		cwd: process.cwd(), model: "test/model", task: "ordinary fixture", hardTimeoutMs: 0,
		maxOutputBytes: 65536, promptSourcePath: PROMPT, env: {}, buildArgs: () => ["--mode", "rpc"],
		spawnFn: () => proc, onControl: value => { control = value; }, ...overrides,
	});
	t.after(async () => { proc.close(1); await pending; });
	const emit = (event: object) => proc.stdout!.write(encodeRpc(event as any));
	return { proc, pending, wrap: () => control.wrap(),
		ready: async () => {
			assert.ok(proc.stdinBytes.includes('"id":"p1"'));
			emit({ type: "message_end", message: { role: "user", content: "Task: ordinary fixture" } });
		},
		answer: (text: string) => emit({ type: "message_end", message: {
			role: "assistant", stopReason: "stop", content: [{ type: "text", text }],
		} }),
		deliverWrap: () => emit({ type: "message_end", message: { role: "user", content: DEFAULT_WRAP_MESSAGE } }),
	};
}

test("retired execution policies fail closed at both runtime entry points", async () => {
	for (const run of [runPiChild, runChild]) {
		await assert.rejects(run({ execution: {} } as any), /guard APIs are retired/);
	}
});

for (const cause of ["hard_timeout", "aborted"] as const) {
	test(`${cause} after delivered wrap preserves partial evidence and wins over later controls`, async t => {
		const signal = new AbortController();
		const child = start(t, { signal: signal.signal, hardTimeoutMs: cause === "hard_timeout" ? 25 : 0 });
		await child.ready(); child.answer("Original report."); child.wrap(); child.deliverWrap();
		if (cause === "aborted") signal.abort();
		const result = await child.pending;
		assert.equal(result.stopReason, cause); assert.match(result.text, /Original report/); assert.equal(child.wrap(), false);
	});
}

test("pre-aborted ordinary startup does not arm late timers or dispatch commands", async t => {
	const signal = new AbortController(); signal.abort();
	const child = start(t, { signal: signal.signal });
	assert.equal((await child.pending).stopReason, "aborted");
	assert.equal(child.proc.stdinBytes.includes('"id":"p1"'), false);
});

test("deadline termination holds the scheduler slot until the child really closes", async t => {
	const child = start(t, { hardTimeoutMs: 20 });
	const close = child.proc.close; child.proc.close = () => {};
	const scheduler = new JobScheduler({ maxConcurrent: 1, maxLocalConcurrent: 1, maxQueued: 1 });
	const base = { kind: "recon" as const, model: "test/model", local: true, task: "hung child", timeoutMs: 1000 };
	const first = scheduler.enqueue({ ...base, run: () => child.pending });
	const second = scheduler.enqueue({ ...base, run: async () => ({ text: "Next", exitCode: 0, stderrTail: "" }) });
	try {
		await child.ready(); child.wrap(); await sleep(35);
		assert.deepEqual(child.proc.signals, ["SIGTERM"]);
		assert.equal(scheduler.get(first.id).status, "running"); assert.equal(scheduler.get(second.id).status, "queued");
		close(1);
		assert.equal((await scheduler.wait(first.id)).stopReason, "hard_timeout");
		assert.equal((await scheduler.wait(second.id)).answer, "Next");
	} finally { child.proc.close = close; close(1); await child.pending; await scheduler.shutdown(); }
});
