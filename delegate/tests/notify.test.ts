import assert from "node:assert/strict";
import { test } from "node:test";
import type { JobSnapshot } from "../jobs.ts";
import {
	NOTIFY_CUSTOM_TYPE,
	NOTIFY_PREVIEW_MAX,
	NotifyGate,
	buildNotifyPayload,
	notifyPreview,
	paintNotify,
	shouldConsume,
} from "../notify.ts";

function snap(over: Partial<JobSnapshot> = {}): JobSnapshot {
	return {
		id: "d0001",
		kind: "recon",
		model: "local-qwen38/qwen38-q4km",
		local: true,
		task: "map",
		status: "done",
		failed: false,
		activity: [],
		background: true,
		answer: "found files",
		...over,
	};
}

function fakeTimers(): {
	api: { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (id: unknown) => void };
	flush: () => void;
	pending: number;
} {
	const queued: Array<{ id: number; fn: () => void }> = [];
	let seq = 0;
	return {
		api: {
			setTimeout: (fn) => {
				seq += 1;
				queued.push({ id: seq, fn });
				return seq;
			},
			clearTimeout: (id) => {
				const idx = queued.findIndex((item) => item.id === id);
				if (idx >= 0) queued.splice(idx, 1);
			},
		},
		flush: () => {
			const next = queued.shift();
			next?.fn();
		},
		get pending() {
			return queued.length;
		},
	};
}

test("shouldConsume only terminal snapshots", () => {
	assert.equal(shouldConsume({ status: "queued" }), false);
	assert.equal(shouldConsume({ status: "running" }), false);
	assert.equal(shouldConsume({ status: "done" }), true);
	assert.equal(shouldConsume({ status: "failed" }), true);
});

test("preview truncates and success display is false", () => {
	const long = "x".repeat(NOTIFY_PREVIEW_MAX + 20);
	const payload = buildNotifyPayload(snap({ answer: long }));
	assert.equal(payload.customType, NOTIFY_CUSTOM_TYPE);
	assert.equal(payload.display, false);
	assert.equal(payload.details.failed, false);
	assert.ok(payload.details.preview.endsWith("…"));
	assert.ok(payload.details.preview.length <= NOTIFY_PREVIEW_MAX);
	assert.match(payload.content, /bg d0001 done/);
	assert.match(payload.content, /Use jobId to collect the full result/);
	assert.equal(notifyPreview({ answer: long }).length <= NOTIFY_PREVIEW_MAX, true);
});

test("failed payload is visible", () => {
	const payload = buildNotifyPayload(
		snap({ status: "failed", failed: true, stopReason: "error", answer: "boom" }),
	);
	assert.equal(payload.display, true);
	assert.equal(payload.details.failed, true);
	assert.match(payload.content, /failed \(error\)/);
});

test("exactly-once terminal notification after hold", () => {
	const sent: ReturnType<typeof buildNotifyPayload>[] = [];
	const timers = fakeTimers();
	const gate = new NotifyGate({
		holdMs: 200,
		send: (payload) => sent.push(payload),
		isLive: () => true,
		timers: timers.api,
	});
	const done = snap();
	gate.schedule(done);
	gate.schedule(done);
	assert.equal(sent.length, 0);
	assert.equal(timers.pending, 1);
	timers.flush();
	assert.equal(sent.length, 1);
	gate.schedule(done);
	assert.equal(timers.pending, 0);
	assert.equal(sent.length, 1);
});

test("terminal wait/peek consume suppresses notice", () => {
	const sent: unknown[] = [];
	const timers = fakeTimers();
	const gate = new NotifyGate({
		send: (payload) => sent.push(payload),
		isLive: () => true,
		timers: timers.api,
	});
	gate.schedule(snap());
	gate.consume("d0001");
	timers.flush();
	assert.equal(sent.length, 0);
	gate.schedule(snap());
	assert.equal(timers.pending, 0);
});

test("pending peek does not consume", () => {
	assert.equal(shouldConsume(snap({ status: "running" })), false);
	const sent: unknown[] = [];
	const timers = fakeTimers();
	const gate = new NotifyGate({
		send: (payload) => sent.push(payload),
		isLive: () => true,
		timers: timers.api,
	});
	gate.schedule(snap({ status: "running" }));
	assert.equal(timers.pending, 0);
	gate.schedule(snap());
	timers.flush();
	assert.equal(sent.length, 1);
});

test("noninteractive and shutdown suppress send", () => {
	const sent: unknown[] = [];
	const timers = fakeTimers();
	let live = false;
	const gate = new NotifyGate({
		send: (payload) => sent.push(payload),
		isLive: () => live,
		timers: timers.api,
	});
	gate.schedule(snap());
	assert.equal(timers.pending, 0);

	live = true;
	gate.schedule(snap({ id: "d0002" }));
	assert.equal(timers.pending, 1);
	live = false;
	gate.shutdown();
	assert.equal(timers.pending, 0);
	timers.flush();
	assert.equal(sent.length, 0);
});

test("send throw is isolated", () => {
	const timers = fakeTimers();
	const gate = new NotifyGate({
		send: () => {
			throw new Error("stale session");
		},
		isLive: () => true,
		timers: timers.api,
	});
	gate.schedule(snap());
	timers.flush();
});

test("paintNotify marks failure", () => {
	const theme = {
		fg: (_key: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
	};
	const line = paintNotify(
		theme,
		{ jobId: "d0001", kind: "recon", model: "m", status: "failed", failed: true, preview: "boom" },
		true,
	);
	assert.match(line, /✗/);
	assert.match(line, /d0001/);
	assert.match(line, /boom/);
});
