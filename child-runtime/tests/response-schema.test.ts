import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import responseGuard from "../response-guard.ts";
import { compileResponseSchema, RESPONSE_FORMAT_ENV, responseFormatError } from "../response-schema.ts";
import { encodeRpc, type ChildControl } from "../spawn.ts";
import { isFailedChildResult } from "../policy.ts";
import { mockChild, runMockPiChild } from "./helpers.ts";

test("schema responses repair in-session without tools and fail closed without changing ordinary child policy", async t => {
	const root = mkdtempSync("/tmp/delegate-schema-");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const schema = { type: "object", required: ["count"], properties: { count: { type: "integer" } }, additionalProperties: false };
	const valid = '{"count":2}';
	const validate = compileResponseSchema(schema);
	assert.match(responseFormatError('{"count":"2","extra":1}', validate, 256)!, /additional properties[\s\S]*integer/);
	assert.equal(responseFormatError(valid, validate, 256), undefined);
	assert.match(responseFormatError('"not-a-date"', compileResponseSchema({ type: "string", format: "date" }), 256)!, /format/);
	assert.match(responseFormatError('1', compileResponseSchema(false), 256)!, /boolean schema/);
	assert.equal(responseFormatError('null', compileResponseSchema(true), 256), undefined);
	assert.throws(() => compileResponseSchema({ $schema: "https://json-schema.org/draft/2020-12/schema" }));

	for (const mode of ["valid", "repair", "exhausted", "zero", "oversize", "wrap", "error", "length", "abort", "native-abort", "unsettled", "no-helper"] as const) {
		const path = join(root, `${mode}.json`);
		writeFileSync(path, JSON.stringify({ schema, repairAttempts: mode === "zero" ? 0 : 2, maxOutputBytes: 256 }));
		const proc = mockChild(), controller = new AbortController();
		let options: any, control!: ChildControl;
		const observed: any[] = [];
		const pending = runMockPiChild({ cwd: root, model: "test/model", task: "count once", hardTimeoutMs: 0,
			maxOutputBytes: 256, promptSourcePath: path, responseFormatPath: path, env: {}, buildArgs: () => [],
			signal: controller.signal, onControl: ctl => { control = ctl; }, onEvent: event => observed.push(event),
			spawnFn: (_cmd, args, input) => { options = input; assert.ok(args.some(arg => arg.endsWith("response-guard.ts"))); return proc; },
		});
		const handlers = new Map<string, Function>();
		let toolResets = 0;
		const previous = process.env[RESPONSE_FORMAT_ENV];
		try {
			process.env[RESPONSE_FORMAT_ENV] = options.env[RESPONSE_FORMAT_ENV];
			responseGuard({ on: (name: string, fn: Function) => handlers.set(name, fn), setActiveTools: (tools: string[]) => {
				assert.deepEqual(tools, []); toolResets++;
			} } as any);
		} finally {
			if (previous === undefined) delete process.env[RESPONSE_FORMAT_ENV]; else process.env[RESPONSE_FORMAT_ENV] = previous;
		}
		const emit = (event: unknown) => proc.stdout!.write(encodeRpc(event));
		const ctx = { mode: "rpc", signal: controller.signal, ui: { notify: (message: string) => emit({ type: "extension_ui_request", method: "notify", message }) } };
		try {
			assert.equal(proc.stdinBytes, "");
			if (mode === "no-helper") {
				proc.close(0);
				const result = await pending;
				assert.equal(isFailedChildResult(result), true); assert.equal(result.evidence?.taskSent, false);
				continue;
			}
			handlers.get("session_start")!({}, ctx);
			for (let i = 0; i < 20 && !proc.stdinBytes; i++) await Promise.resolve();
			assert.ok(proc.stdinBytes.includes('"id":"p1"'));
			if (mode === "wrap") {
				assert.equal(control.wrap("finish"), true);
				emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: '{"count":1}' }], stopReason: "stop" } });
				emit({ type: "message_end", message: { role: "user", content: "finish" } });
			}
			let turns = 0;
			while (true) {
				const text = ["valid", "wrap", "abort", "native-abort", "unsettled"].includes(mode) || (mode === "repair" && turns > 0) ? valid
					: mode === "oversize" ? ` ${" ".repeat(300)}${valid}` : '{"count":"wrong"}';
				const event = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }],
					stopReason: mode === "error" || mode === "length" ? mode : "stop" } };
				handlers.get("message_end")!(event); emit(event); turns++;
				if (mode === "abort") { controller.abort(); break; }
				if (mode === "unsettled") { proc.close(0); break; }
				const boundary = handlers.get("agent_before_settle")!({ entries: [] }, ctx);
				if (!boundary?.continue) { emit({ type: "agent_settled", aborted: mode === "native-abort" }); break; }
				assert.ok(turns <= 2, "at most two repairs");
				assert.match(boundary.entries[0].content, /do not repeat the task/);
				assert.equal(handlers.get("tool_call")!().block, true);
				assert.equal(handlers.get("tool_call")!().terminate, true);
			}
			const result = await pending;
			const success = ["valid", "repair", "wrap"].includes(mode);
			assert.equal(isFailedChildResult(result), !success, mode);
			assert.equal((proc.stdinBytes.match(/"type":"prompt"/g) ?? []).length, 1, "same task/session, not a restart");
			assert.equal(observed.filter(event => event.type === "message_end" && event.message.role === "assistant").length, turns + (mode === "wrap" ? 1 : 0));
			if (success) { assert.equal(result.text, valid); assert.deepEqual(JSON.parse(result.text), { count: 2 }); }
			if (["exhausted", "oversize"].includes(mode)) { assert.equal(turns, 3); assert.equal(toolResets, 2); }
			if (mode === "repair") { assert.equal(turns, 2); assert.equal(toolResets, 1); }
			if (["zero", "error", "length", "abort"].includes(mode)) assert.equal(toolResets, 0);
			if (["zero", "exhausted", "oversize", "unsettled"].includes(mode)) {
				assert.equal(result.stopReason, "response-format"); assert.match(result.text, /Response format validation failed/);
			}
			if (["error", "length", "abort", "native-abort"].includes(mode)) assert.equal(result.stopReason, mode.endsWith("abort") ? "aborted" : mode);
		} finally { proc.close(1); await pending; }
	}
});
