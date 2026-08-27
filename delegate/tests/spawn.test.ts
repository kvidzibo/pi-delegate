import assert from "node:assert/strict";
import { test } from "node:test";
import { buildChildArgs, buildChildEnv } from "../spawn.ts";

const base = {
	model: "local-qwen38/qwen38-q4km",
	thinking: "off",
	tools: ["read", "grep", "find", "ls", "bash"],
	promptPath: "/tmp/prompt.md",
	task: "list files",
};

test("argv includes isolation flags", () => {
	const args = buildChildArgs(base);
	assert.equal(args[args.indexOf("--mode") + 1], "json");
	assert.ok(args.includes("-p"));
	assert.ok(args.includes("--no-session"));
	assert.ok(args.includes("--no-extensions"));
	assert.ok(args.includes("--no-skills"));
	assert.ok(args.includes("--no-prompt-templates"));
	assert.ok(args.includes("--no-context-files"));
	assert.equal(args.includes("--offline"), false);
	assert.equal(args[args.indexOf("--model") + 1], base.model);
	assert.equal(args[args.indexOf("--tools") + 1], "read,grep,find,ls,bash");
	assert.equal(args[args.indexOf("--system-prompt") + 1], "/tmp/prompt.md");
	assert.equal(args.includes("--append-system-prompt"), false);
	assert.equal(args.at(-1), "Task: list files");
});

test("offline flag only when requested", () => {
	const args = buildChildArgs({ ...base, offline: true });
	assert.ok(args.includes("--offline"));
	assert.equal(buildChildArgs({ ...base, offline: false }).includes("--offline"), false);
});

test("argv never includes session or extension flags", () => {
	const args = buildChildArgs(base);
	assert.equal(args.includes("--session"), false);
	assert.equal(args.includes("--extension"), false);
	assert.equal(args.includes("-e"), false);
});

test("child env marks nest", () => {
	const env = buildChildEnv({ PATH: "/usr/bin" });
	assert.equal(env.PI_DELEGATE_CHILD, "1");
	assert.equal(env.PI_DELEGATE_CHILD_DEPTH, "1");
	assert.equal(env.PI_THIN_CHILD, undefined);
	assert.equal(env.PI_CODEX_CHILD, undefined);
	assert.equal(env.PATH, "/usr/bin");
});
