import assert from "node:assert/strict";
import { test } from "node:test";
import { CARD_STATE_TYPE, JobCards } from "../cards.ts";

const running = { jobId: "d0001", status: "running", task: "review", model: "xai/grok-4.6" };
const done = { ...running, status: "done", answer: "No important findings." };
const entry = (origin: string, details: object) => ({ type: "custom", customType: CARD_STATE_TYPE, data: { ...details, originToolCallId: origin } });

test("origin card updates without collection and releases its UI observer at terminal", () => {
	const cards = new JobCards(); let renders = 0;
	cards.begin("spawn", running);
	cards.watch("spawn", () => { renders++; cards.watch("spawn", () => { renders++; }); });
	cards.update("spawn", { ...running, current: { name: "bash", mark: "→" } });
	cards.update("spawn", done);
	assert.equal(cards.get("spawn")?.answer, done.answer);
	assert.equal(cards.isLive("spawn"), false);
	assert.equal(renders, 2);
	cards.update("spawn", done);
	assert.equal(renders, 2, "terminal cards must not retain row callbacks");
	cards.update("spawn", running);
	assert.equal(cards.get("spawn")?.status, "done", "late pending receipt cannot downgrade completion");
});

test("dead observers and shutdown do not retain UI or change child state", () => {
	const cards = new JobCards(); cards.begin("spawn", running);
	cards.watch("spawn", () => { throw new Error("dead UI"); });
	assert.doesNotThrow(() => cards.update("spawn", done));
	cards.clear(); assert.equal(cards.get("spawn"), undefined);
	cards.begin("next", running); cards.forget("next");
	assert.equal(cards.isLive("next"), false);
});

test("restore uses origin IDs, branch entries and terminal precedence, never reused short IDs", () => {
	const cards = new JobCards();
	cards.restore([entry("old", done), entry("old", running), entry("unfinished", running)]);
	assert.equal(cards.get("old")?.status, "done");
	assert.equal(cards.get("unfinished")?.historical, true);
	cards.begin("new", running);
	assert.equal(cards.get("old")?.status, "done");
	assert.equal(cards.get("new")?.status, "running");
	cards.restore([entry("another-branch", done)]);
	assert.equal(cards.get("old"), undefined);
	assert.equal(cards.get("new")?.status, "running");
	assert.equal(cards.get("another-branch")?.answer, done.answer);
	cards.update("new", done);
	cards.restore([entry("new", running)]);
	assert.equal(cards.get("new")?.status, "done", "a job that completed on another branch is still known in this runtime");
});

test("terminal collect results recover a card even without its UI-only completion entry", () => {
	const cards = new JobCards();
	cards.restore([{ type: "message", message: { role: "toolResult", toolName: "delegate", details: { ...done, originToolCallId: "origin", callType: "collect" } } }]);
	assert.equal(cards.get("origin")?.answer, done.answer);
	cards.restore([null, {}, { type: "custom", data: done }]);
	assert.equal(cards.get("origin"), undefined);
});
