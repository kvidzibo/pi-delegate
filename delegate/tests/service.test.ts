import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { Accounting } from "../accounting.ts";
import type { AgentConfig } from "../config.ts";
import { JobScheduler } from "../jobs.ts";
import { agentPrompt, enqueueDelegate } from "../service.ts";

test("role response policy is snapshotted, formats instructions and saves private collectible results without changing outcomes", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "delegate-response-test-"));
	const accounting = new Accounting(root);
	const scheduler = new JobScheduler({ maxConcurrent: 1, maxLocalConcurrent: 1, maxQueued: 4 });
	t.after(async () => { await scheduler.shutdown(); accounting.close(); rmSync(root, { recursive: true, force: true }); });
	const template = "| # | Severity | Finding | Resolution |\n|---|---|---|---|\n| 1 | High | <finding> | Fixed in `<commit>`; awaiting re-review |";
	const agent: AgentConfig = { model: "hosted/mock", prompt: "Read-only review.", thinking: "off", tools: [], extensions: false };
	assert.equal(agentPrompt(agent), agent.prompt);
	assert.equal(agentPrompt({ ...agent, responseTemplate: " \n" }), agent.prompt);
	assert.ok(agentPrompt({ ...agent, responseTemplate: template }).endsWith(template));
	const files = new Set<string>();
	for (const saveToFile of [false, true]) {
		for (const [text, stopReason] of [["Review: 界", "stop"], ["Partial failure", "error"], ["", "stop"]]) {
			let finish!: () => void;
			const block = scheduler.enqueue({ kind: "recon", model: agent.model, local: false, task: "block", timeoutMs: 1000,
				run: () => new Promise(resolve => { finish = () => resolve({ text: "done", exitCode: 0, stderrTail: "" }); }) });
			const accepted = { ...agent, responseTemplate: template, saveToFile };
			const expectedPrompt = agentPrompt(accepted);
			const job = enqueueDelegate({ scheduler, accounting, agent: accepted,
				identity: { kind: "review", requestedModel: agent.model, thinking: "off", cwd: root, parentSessionId: "test", toolCallId: "test" },
				task: "Exact task", timeoutMs: 1000, background: saveToFile, config: { hardTimeoutMs: 0, maxOutputBytes: 4096 },
				childRunner: async input => {
					assert.equal(input.task, "Exact task");
					assert.equal(readFileSync(input.promptSourcePath, "utf8"), expectedPrompt);
					assert.equal("saveToFile" in input, false);
					assert.equal("responseFile" in input, false);
					return { text, stopReason, exitCode: 0, stderrTail: "" };
				},
			});
			assert.equal(job.status, "queued");
			accepted.responseTemplate = "Changed after acceptance"; accepted.saveToFile = !saveToFile;
			finish(); await scheduler.wait(block.id);
			const done = await scheduler.wait(job.id);
			assert.equal(done.failed, stopReason === "error" || !text);
			assert.equal(done.stopReason, stopReason);
			if (saveToFile && text) {
				const file = done.responseFile!;
				t.after(() => rmSync(dirname(file), { recursive: true, force: true }));
				assert.ok(file.startsWith(join(tmpdir(), "pi-delegate-result-")));
				assert.equal(files.has(file), false); files.add(file);
				assert.equal(readFileSync(file, "utf8"), text);
				assert.equal(statSync(file).mode & 0o777, 0o600);
				assert.equal(statSync(dirname(file)).mode & 0o777, 0o700);
				assert.equal(done.answer, `Response saved to: ${file}`);
				assert.equal(scheduler.get(job.id).responseFile, file, "collection reuses the same file");
			} else {
				assert.equal(done.responseFile, undefined); assert.equal(done.answer, text);
			}
		}
	}
	const schema = { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] };
	const schemaAgent = { ...agent, responseTemplate: template, responseSchema: schema, responseRepairAttempts: 1, saveToFile: true };
	let release!: () => void;
	const blocked = scheduler.enqueue({ kind: "recon", model: agent.model, local: false, task: "block", timeoutMs: 1000,
		run: () => new Promise(resolve => { release = () => resolve({ text: "done", exitCode: 0, stderrTail: "" }); }) });
	const expectedSchema = structuredClone(schema);
	const schemaJob = enqueueDelegate({ scheduler, accounting, agent: schemaAgent,
		identity: { kind: "review", requestedModel: agent.model, thinking: "off", cwd: root, parentSessionId: "test", toolCallId: "schema" },
		task: "JSON response", timeoutMs: 1000, background: true, config: { hardTimeoutMs: 0, maxOutputBytes: 4096 },
		childRunner: async input => {
			assert.deepEqual(JSON.parse(readFileSync(input.responseFormatPath!, "utf8")), { schema: expectedSchema, repairAttempts: 1, maxOutputBytes: 4096 });
			assert.equal(statSync(input.responseFormatPath!).mode & 0o777, 0o600);
			const prompt = readFileSync(input.promptSourcePath, "utf8");
			assert.match(prompt, /draft-07 JSON Schema/); assert.ok(!prompt.includes(template));
			return { text: '{"summary":"done"}', stopReason: "stop", exitCode: 0, stderrTail: "" };
		},
	});
	schema.properties.summary.type = "number"; schemaAgent.responseRepairAttempts = 0;
	release(); await scheduler.wait(blocked.id);
	const schemaDone = await scheduler.wait(schemaJob.id);
	assert.equal(schemaDone.failed, false); assert.ok(schemaDone.responseFile!.endsWith("response.json"));
	assert.equal(readFileSync(schemaDone.responseFile!, "utf8"), '{"summary":"done"}');
	t.after(() => rmSync(dirname(schemaDone.responseFile!), { recursive: true, force: true }));
	const previous = process.env.TMPDIR;
	try {
		process.env.TMPDIR = join(root, "missing");
		const job = enqueueDelegate({ scheduler, accounting, agent: { ...agent, saveToFile: true },
			identity: { kind: "review", requestedModel: agent.model, thinking: "off", cwd: root, parentSessionId: "test", toolCallId: "save-failure" },
			task: "Failure fallback", timeoutMs: 1000, background: false, config: { hardTimeoutMs: 0, maxOutputBytes: 4096 },
			childRunner: async () => ({ text: "Preserved answer", stopReason: "stop", exitCode: 0, stderrTail: "" }),
		});
		const done = await scheduler.wait(job.id);
		assert.equal(done.failed, false); assert.equal(done.responseFile, undefined);
		assert.match(done.answer!, /Could not save response[\s\S]*Preserved answer/);
		assert.match(done.recordingError!, /Could not save response/);
		const typedJob = enqueueDelegate({ scheduler, accounting, agent: { ...agent, responseSchema: true, saveToFile: true },
			identity: { kind: "review", requestedModel: agent.model, thinking: "off", cwd: root, parentSessionId: "test", toolCallId: "schema-save-failure" },
			task: "JSON fallback", timeoutMs: 1000, background: false, config: { hardTimeoutMs: 0, maxOutputBytes: 4096 },
			childRunner: async () => ({ text: '{"summary":"done"}', stopReason: "stop", exitCode: 0, stderrTail: "" }),
		});
		const typedDone = await scheduler.wait(typedJob.id);
		assert.equal(typedDone.failed, false); assert.equal(typedDone.responseFile, undefined);
		assert.deepEqual(JSON.parse(typedDone.answer!), { summary: "done" });
		assert.match(typedDone.recordingError!, /Could not save response/);
	} finally {
		if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
	}
});
