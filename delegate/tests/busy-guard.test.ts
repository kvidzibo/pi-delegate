import assert from "node:assert/strict";
import { test } from "node:test";
import { respondToBusyQuery } from "../busy-guard.ts";

test("busy query replies synchronously with the supplied status", () => {
	let answer: boolean | undefined;
	respondToBusyQuery({ reply: (busy: boolean) => { answer = busy; } }, true);
	assert.equal(answer, true);
	respondToBusyQuery({ reply: (busy: boolean) => { answer = busy; } }, false);
	assert.equal(answer, false);
	assert.doesNotThrow(() => respondToBusyQuery(undefined, true));
	assert.doesNotThrow(() => respondToBusyQuery({ reply: "not a function" }, true));
});
