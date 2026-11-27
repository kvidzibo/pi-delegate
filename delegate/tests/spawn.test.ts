import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendDelegateLog, buildChildArgs, buildChildEnv, delegateLogPath } from "../spawn.ts";
import { parseProviderOwner, providerExtension, resetProviderExtensions } from "../provider-extension.ts";

const base = {
	model: "local-qwen38/qwen38-q4km",
	thinking: "off",
	tools: ["read", "grep", "find", "ls", "bash"],
	promptPath: "/tmp/prompt.md",
	sessionFile: "/private/archive/run/session.jsonl",
};

test("argv includes isolation flags", () => {
	const args = buildChildArgs(base);
	assert.equal(args[args.indexOf("--mode") + 1], "rpc");
	assert.equal(args.includes("-p"), false);
	assert.equal(args.includes("--no-session"), false);
	assert.equal(args[args.indexOf("--session") + 1], base.sessionFile);
	assert.ok(args.includes("--no-extensions"));
	assert.ok(args.includes("--no-skills"));
	assert.ok(args.includes("--no-prompt-templates"));
	assert.ok(args.includes("--no-context-files"));
	assert.equal(args.includes("--offline"), false);
	assert.equal(args[args.indexOf("--model") + 1], base.model);
	assert.equal(args[args.indexOf("--tools") + 1], "read,grep,find,ls,bash");
	assert.equal(args[args.indexOf("--system-prompt") + 1], "/tmp/prompt.md");
	assert.equal(args.includes("--append-system-prompt"), false);
	assert.equal(args.some((arg) => arg.startsWith("Task:")), false);
});

test("child startup mode is controlled only by the supplied Pi environment", () => {
	for (const model of [base.model, "hosted/model"]) {
		assert.equal(buildChildArgs({ ...base, model }).includes("--offline"), false);
	}
	assert.equal(buildChildEnv({ PI_OFFLINE: "1" }).PI_OFFLINE, "1");
	assert.equal(buildChildEnv({ PI_OFFLINE: "0" }).PI_OFFLINE, "0");
	assert.equal(buildChildEnv({}).PI_OFFLINE, undefined);
});

test("argv never inherits or forks parent sessions and extensions require opt-in", () => {
	const args = buildChildArgs(base);
	assert.equal(args.includes("--continue"), false);
	assert.equal(args.includes("--fork"), false);
	assert.equal(args.includes("--extension"), false);
	assert.equal(args.includes("-e"), false);
	assert.equal(buildChildArgs({ ...base, extensions: true }).includes("--no-extensions"), false);
	assert.equal(buildChildArgs({ ...base, tools: ["*"] })[args.indexOf("--tools") + 1], "*");
	const noTools = buildChildArgs({ ...base, tools: [] });
	assert.ok(noTools.includes("--no-tools"));
	assert.ok(noTools.includes("--no-mcp"));
});

test("non-standard speed loads the service-tier extension and policy without extension discovery", () => {
	for (const speed of [undefined, "standard"] as const) {
		assert.equal(buildChildArgs({ ...base, speed }).includes("--extension"), false);
		assert.equal(buildChildEnv({ PI_DELEGATE_SPEED: "fast" }, speed).PI_DELEGATE_SPEED, undefined);
	}
	for (const speed of ["fast", "ultrafast"] as const) {
		const args = buildChildArgs({ ...base, speed });
		assert.ok(args.includes("--no-extensions"));
		assert.match(args[args.indexOf("--extension") + 1], /child-runtime\/service-tier\.ts$/);
		assert.equal(buildChildEnv({}, speed).PI_DELEGATE_SPEED, speed);
	}
});

test("child env marks nest", () => {
	const env = buildChildEnv({ PATH: "/usr/bin" });
	assert.equal(env.PI_DELEGATE_CHILD, "1");
	assert.equal(env.PI_DELEGATE_CHILD_DEPTH, "1");
	assert.equal(env.PI_THIN_CHILD, undefined);
	assert.equal(env.PI_CODEX_CHILD, undefined);
	assert.equal(env.PATH, "/usr/bin");
});

test("delegate log path override and disable", () => {
	assert.equal(delegateLogPath({ PI_DELEGATE_LOG: "0" }), undefined);
	assert.equal(delegateLogPath({ PI_DELEGATE_LOG: "/tmp/delegate.log" }), "/tmp/delegate.log");
});

test("delegate log writes one json line without task text", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-delegate-log-"));
	const path = join(dir, "delegate.log");
	try {
		appendDelegateLog(path, {
			stopReason: "timeout",
			exitCode: 143,
			command: "/usr/bin/node",
			args: ["/opt/pi", "--model", "openai-codex/gpt-5.6-sol", "Task:<redacted 12 chars>"],
			eventCount: 0,
		});
		const line = readFileSync(path, "utf8").trim();
		const rec = JSON.parse(line) as { stopReason: string; args: string[] };
		assert.equal(rec.stopReason, "timeout");
		assert.equal(rec.args.includes("openai-codex/gpt-5.6-sol"), true);
		assert.equal(line.includes("secret"), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a model from an extension provider loads only that extension when extensions are off", async () => {
	const bridge = "/agent/npm/node_modules/pi-claude-bridge/src/index.ts";
	const args = buildChildArgs({ ...base, providerExtension: bridge });
	assert.ok(args.includes("--no-extensions"));
	assert.equal(args[args.indexOf("--extension") + 1], bridge);
	assert.equal(buildChildArgs({ ...base, extensions: true, providerExtension: bridge }).includes("--extension"), false);

	const mark = "mark=";
	assert.equal(parseProviderOwner(`noise\n${mark}"/spoof.ts"\nmore\n${mark}${JSON.stringify(bridge)}\n`, mark), bridge, "Only the last marked line counts");
	assert.equal(parseProviderOwner(`${mark}null\n`, mark), undefined);
	assert.equal(parseProviderOwner(`${mark}"relative.ts"\n`, mark), undefined);
	assert.throws(() => parseProviderOwner("models…\n", mark), /no result/);

	const asked: string[] = [];
	const failing = async (model: string) => { asked.push(model); throw new Error("pi missing"); };
	const working = async (model: string) => { asked.push(model); return model.startsWith("claude-bridge/") ? bridge : undefined; };
	resetProviderExtensions();
	assert.equal(await providerExtension("claude-bridge/claude-opus", failing), undefined, "A failed probe leaves the launch unchanged");
	assert.equal(await providerExtension("claude-bridge/claude-opus", working), bridge, "A failed probe is retried");
	assert.equal(await providerExtension("claude-bridge/claude-opus", failing), bridge, "An answer is reused for later launches");
	assert.equal(await providerExtension("openai-codex/gpt", working), undefined);
	assert.equal(await providerExtension("claude-opus", working), undefined, "Bare ids keep their existing resolution");
	assert.deepEqual(asked, ["claude-bridge/claude-opus", "claude-bridge/claude-opus", "openai-codex/gpt"]);
	const argv = process.argv;
	try {
		process.argv = [...argv, "-ne"];
		assert.equal(await providerExtension("claude-bridge/uncached", working), undefined, "A parent without extensions gets none loaded for it");
		assert.equal(asked.length, 3, "and no probe runs");
	} finally { process.argv = argv; }
	resetProviderExtensions();
});
