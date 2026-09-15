import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { plainBoardTheme } from "../../delegate/board.ts";
import { renderChildCall, renderChildResult, renderJobBoard, type RowState } from "../../delegate/view.ts";

type Background = "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";

// Explicit ANSI is intentional: the offline CLI harness disables automatic colors.
function colorTheme() {
	return {
		palette: { toolPendingBg: 236, toolSuccessBg: 22, toolErrorBg: 52 },
		fg: (_color: string, text: string) => `\x1b[38;5;250m${text}\x1b[39m`,
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
		italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
		bg(color: Background, text: string) { return `\x1b[48;5;${this.palette[color]}m${text}\x1b[49m`; },
	};
}

/** Check every visible span, including blank padding and text after ANSI resets. */
function assertBackground(lines: string[], width: number, expected: number): void {
	assert.ok(lines.length);
	for (const line of lines) {
		assert.equal(visibleWidth(line), width, "card background must fill the available width");
		let background: number | undefined;
		for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
			if (part.startsWith("\x1b[")) {
				const codes = part.slice(2, -1).split(";").map(Number);
				for (let i = 0; i < codes.length; i++) {
					if (codes[i] === 48 && codes[i + 1] === 5) { background = codes[i + 2]; i += 2; }
					else if (codes[i] === 38 && codes[i + 1] === 5) i += 2;
					else if (codes[i] === 38 && codes[i + 1] === 2) i += 4;
					else if (codes[i] === 0 || codes[i] === 49) background = undefined;
				}
			} else if (visibleWidth(part)) {
				assert.equal(background, expected, `missing background on ${JSON.stringify(part)}`);
			}
		}
		assert.equal(background, undefined, "card background must not leak into adjacent UI");
	}
}

export function backgroundProbe() {
	const theme = colorTheme();
	const base: RowState = {
		details: { jobId: "d0001", kind: "review", model: "hosted/reviewer", task: "Review 界 🧪 ".repeat(12),
			answer: "**Result**\n\n```ts\nconst answer = '界 🧪';\n```\n\n" + "Long result ".repeat(40),
			activity: [{ mark: "✗", name: "bash", args: "a failed command" }], sessionFile: "/private/session.jsonl" },
		collect: false, expanded: false, isPartial: true, live: false,
	};
	const cases: Array<[Partial<RowState>, Record<string, unknown>, Background]> = [
		[{}, {}, "toolPendingBg"],
		[{ live: true, pinned: true }, { status: "running" }, "toolPendingBg"],
		[{ live: true, pinned: true }, { status: "queued", reason: "gpu" }, "toolPendingBg"],
		[{ isPartial: false }, { status: "running", historical: true }, "toolPendingBg"],
		[{ isPartial: false }, { status: "done" }, "toolSuccessBg"],
		[{ isPartial: false }, {}, "toolSuccessBg"],
		[{ isPartial: false }, { status: "failed", stopReason: "aborted" }, "toolErrorBg"],
		[{ isPartial: false, isError: true }, {}, "toolErrorBg"],
		[{ isPartial: false }, { ok: false }, "toolErrorBg"],
	];
	for (const [overrides, details, color] of cases) for (const expanded of [false, true]) {
		const read = () => ({ ...base, ...overrides, expanded, details: { ...base.details, ...details } });
		const call = renderChildCall({ theme, read }), result = renderChildResult({ theme, read });
		for (const width of [1, 2, 8, 16, 80]) {
			assertBackground(call.render(width), width, theme.palette[color]);
			assertBackground(result.render(width), width, theme.palette[color]);
		}
		assert.deepEqual(call.render(0), []); assert.deepEqual(result.render(0), []);
	}

	// Compact historical receipts are not full cards and must stay unfilled.
	for (const state of [
		{ ...base, live: true },
		{ ...base, collect: true, isPartial: false, details: { ...base.details, status: "done" } },
	]) {
		const input = { theme, read: () => state };
		assert.doesNotMatch([...renderChildCall(input).render(80), ...renderChildResult(input).render(80)].join("\n"), /\x1b\[48;/);
	}

	const board = { summary: "delegate  1 run  1 wait  local 1/1", cards: [
		{ ...base.details, status: "running", answer: undefined },
		{ ...base.details, jobId: "d0002", status: "queued", answer: undefined },
	] };
	for (const expanded of [false, true]) for (const width of [1, 2, 8, 16, 80]) for (const rows of [1, 2, 3, 4, 8, 12]) {
		const lines = renderJobBoard(board, width, rows, theme, expanded, "");
		assert.ok(lines.length <= rows);
		assertBackground(rows >= 4 ? lines.slice(0, -1) : lines, width, theme.palette.toolPendingBg);
		if (rows >= 4) assert.doesNotMatch(lines.at(-1)!, /\x1b\[48;/, "the counts footer is outside the cards");
	}
	const blank = renderJobBoard({ ...board, cards: [{ jobId: "blank", status: "running" }] }, 80, 5, theme, false, "");
	assert.equal(blank[3].replace(/\x1b\[[0-9;]*m/g, ""), " ".repeat(80), "empty card rows also need a background");
	assertBackground(blank.slice(0, -1), 80, theme.palette.toolPendingBg);
	assert.deepEqual(renderJobBoard(board, 0, 5, theme, false, ""), []);
	assert.deepEqual(renderJobBoard(board, 80, 0, theme, false, ""), []);
	const rpc = renderJobBoard(board, 80, 8, plainBoardTheme, false, "");
	assert.doesNotMatch(rpc.join("\n"), /\x1b/);
	assert.ok(rpc.every((line) => line === line.trimEnd()), "RPC previews keep their unpadded plain text");

	// Reused components must consult the current palette, including after invalidation.
	const read = () => ({ ...base, details: { ...base.details, status: "done" }, isPartial: false });
	const call = renderChildCall({ theme, read }), result = renderChildResult({ theme, read });
	const before = call.render(80);
	theme.palette = { toolPendingBg: 254, toolSuccessBg: 194, toolErrorBg: 224 };
	call.invalidate(); result.invalidate();
	assert.notDeepEqual(call.render(80), before);
	assertBackground([...call.render(80), ...result.render(80)], 80, 194);
	assertBackground(renderJobBoard(board, 80, 8, theme, false, "").slice(0, -1), 80, 254);
	return { fullWidth: true, statusColors: true, neutralReceipts: true, themeChanges: true, plainRpc: true };
}
