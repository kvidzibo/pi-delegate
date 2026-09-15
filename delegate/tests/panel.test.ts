import assert from "node:assert/strict";
import { test } from "node:test";
import type { JobSnapshot } from "../jobs.ts";
import { projectJobBoard } from "../panel.ts";
import { JobBoard } from "../board.ts";

const job = (extra: Partial<JobSnapshot> = {}): JobSnapshot => ({ id: "d0001", kind: "review", model: "hosted/reviewer", task: "Review card layout",
	status: "running", local: false, failed: false, background: true, activity: [], ...extra });
const limits = { maxLocalConcurrent: 1 };

test("panel projection carries full card identity and task while excluding raw thinking and clocks", () => {
	const initial = job({ thinking: "PRIVATE first", quietForMs: 10,
		activity: [{ name: "thinking", mark: "…", args: "SECRET" }, { name: "read", mark: "✓", args: "file.ts", id: "tool-1" }] });
	const first = projectJobBoard([initial], limits)!;
	assert.equal(first.cards[0].model, "hosted/reviewer"); assert.equal(first.cards[0].task, "Review card layout");
	assert.equal(first.cards[0].phase, "thinking"); assert.equal(first.cards[0].jobId, "d0001");
	assert.doesNotMatch(JSON.stringify(first), /PRIVATE|SECRET|quietForMs|tool-1/);
	assert.deepEqual(projectJobBoard([{ ...initial, thinking: "PRIVATE second", quietForMs: 999 }], limits), first);
	initial.activity[1].args = "mutated";
	assert.equal((first.cards[0].activity as any[])[0].args, "file.ts", "projection owns its tool snapshots");
});

test("panel preserves active acceptance order, queue/wrap/warnings and local rates, excluding terminal jobs", () => {
	const state = projectJobBoard([job(), job({ id: "d0002", status: "queued", reason: "gpu", local: true, wrapped: true }),
		job({ id: "d0003", status: "done" }), job({ id: "d0004", local: true, tg: "tg 40/s", recordingError: "Recording incomplete" })], limits)!;
	assert.deepEqual(state.cards.map((d) => d.jobId), ["d0001", "d0002", "d0004"]);
	assert.equal(state.cards[1].reason, "gpu"); assert.equal(state.cards[1].wrapped, true);
	assert.equal(state.cards[2].tg, "tg 40/s"); assert.equal(state.cards[2].recordingError, "Recording incomplete");
	assert.equal(state.summary, "delegate  2 run  1 wait  local 1/1");
	assert.equal(projectJobBoard([job({ status: "done" })], limits), undefined);
	assert.equal(projectJobBoard([job({ tg: "tg 90/s" })], limits)!.cards[0].tg, undefined);
});

test("equivalent full-card snapshots reuse the mounted component; expansion is read on each render", () => {
	let component: any, expanded = false, paints = 0, mounts = 0;
	const ui: any = { getToolsExpanded: () => expanded, setWidget(_key: string, factory: any) {
		if (factory) { mounts++; component = factory({ terminal: { rows: 24 }, requestRender() { paints++; } }); }
	} };
	const board = new JobBoard((state: NonNullable<ReturnType<typeof projectJobBoard>>, _width, maxRows, _theme, expanded) =>
		[`${state.cards[0].task} · ${expanded} · ${maxRows}`]);
	board.paint(ui, "tui", projectJobBoard([job({ thinking: "one" })], limits));
	board.paint(ui, "tui", projectJobBoard([job({ thinking: "two" })], limits));
	assert.equal(mounts, 1); assert.equal(paints, 0);
	assert.deepEqual(component.render(80), ["Review card layout · false · 12"]);
	expanded = true;
	assert.deepEqual(component.render(80), ["Review card layout · true · 12"]);
	board.paint(ui, "tui", projectJobBoard([job({ wrapped: true })], limits)); assert.equal(paints, 1);
	board.close(ui);
});
