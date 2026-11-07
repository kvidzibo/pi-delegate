import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { loadDelegateConfig } from "../../delegate/config.ts";
import { ModelCommand } from "../../delegate/model-command.ts";
import { enqueueDelegate } from "../../delegate/service.ts";

/** Drive native settings components without a desktop or provider request. */
export async function rolesProbe(ctx: ExtensionCommandContext) {
	const paths = { shippedPath: join(import.meta.dirname, "../../delegate/config.json"), userPath: join(getAgentDir(), "roles-test.json") };
	const overlay = { unrelated: { keep: true }, agents: {
		recon: { offline: true, context: ["legacy"], note: "keep" },
		review: { tools: Array.from({ length: 40 }, (_, i) => `custom_${i}`) },
	} };
	writeFileSync(paths.userPath, JSON.stringify(overlay));
	const config = loadDelegateConfig(paths);
	let additions = 0;
	let created: typeof config.agents[string] | undefined;
	const command = new ModelCommand(config, paths, () => { additions++; created = structuredClone(config.agents.writer); });
	const model = { provider: "test", id: "available", name: "Available", reasoning: false };
	let picks = 0, screen = 0, edits = 0;
	let resizedTools = false;
	const notices: string[] = [];
	const actions = [
		[0], // Explicit new-role model selection.
		[10], // Save safe defaults.
		[0, 10], // Reopen and edit the new role without reloading.
		[0, 4, 5], // Disable recon, enable extensions, edit multiline prompt.
		[6], // Edit the response template independently of the prompt.
		[7, 3], // Enable saving to file, then open tools.
		[0], // All tools.
		[1], // No tools.
		[2, -1], // Enable read, then Back.
		[1], // Model picker.
		[0], // Select available model.
		[2, 10], // Cycle reasoning to off, save.
	];
	const testCtx: any = { ...ctx, hasUI: true, mode: "tui", scopedModels: [],
		modelRegistry: { refresh: async () => {}, getError: () => undefined, getAvailable: () => [model], getAll: () => [model] },
		ui: { ...ctx.ui,
			notify: (text: string) => notices.push(text),
			input: async () => "writer",
			editor: async (_title: string, prefill: string) => {
				edits++;
				if (edits === 1) { assert.equal(prefill, ""); return "Write documents.\nKeep scope."; }
				if (edits === 2) { assert.equal(prefill, config.agents.recon.prompt); return "New recon prompt.\nSecond line."; }
				if (edits === 3) { assert.equal(prefill, ""); return "  Summary:\n{{literal}}\n"; }
				assert.equal(prefill, "  Summary:\n{{literal}}\n");
				return edits === 4 ? undefined : "";
			},
			select: async (_title: string, options: string[]) => {
				picks++;
				if (picks === 1) return options.at(-1);
				if (picks === 2) return options.find(item => item.startsWith("writer ·"));
				if (picks === 3) return options.find(item => item.startsWith("recon ·"));
				return undefined;
			},
			custom: async (create: Function) => {
				let result: string | undefined;
				const terminal = { rows: 30, columns: 100 };
				const component = create({ terminal, requestRender: () => {} }, ctx.ui.theme, getKeybindings(), (value: string | undefined) => { result = value; });
				try {
					const moves = actions[screen++];
					assert.ok(moves, `unexpected screen ${screen}`);
					for (const width of [30, 100]) assert.ok(component.render(width).every((line: string) => visibleWidth(line) <= width));
					if (!resizedTools && component.render(100).join("\n").includes("Tools · recon")) {
						for (let i = 0; i < 35; i++) component.handleInput("\x1b[B");
						for (const [rows, columns] of [[20, 50], [16, 40], [30, 100]]) {
							terminal.rows = rows; terminal.columns = columns;
							component.handleInput("\r"); // Stale geometry must not activate a hidden row.
							const lines = component.render(columns);
							assert.ok(lines.length <= rows - 6);
							assert.ok(lines.every((line: string) => visibleWidth(line) <= columns));
							assert.match(lines.join("\n"), /custom_25/, "Resize preserves the selected tool and scrolling");
							assert.doesNotMatch(lines.join("\n"), /Enlarge terminal/);
						}
						for (let i = 0; i < 35; i++) component.handleInput("\x1b[A");
						component.render(100);
						resizedTools = true;
					}
					let position = 0;
					for (const target of moves) {
						if (target < 0) { component.handleInput("\x1b"); break; }
						while (position < target) { component.handleInput("\x1b[B"); position++; }
						while (position > target) { component.handleInput("\x1b[A"); position--; }
						component.handleInput("\r");
					}
					return result;
				} finally { component.dispose?.(); }
			},
		},
	};
	// An already accepted runner must keep the full role snapshot, not just the model.
	let accepted: any, launched: any, archivedPrompt: string | undefined;
	enqueueDelegate({ scheduler: { enqueue: (input: any) => { accepted = input; return {}; } } as any,
		accounting: { create: (_identity: unknown, _task: string, prompt: string) => {
			archivedPrompt = prompt;
			return { paths: { prompt: "saved-prompt", session: "session" }, data: { runId: "run" } };
		},
			run: (_archive: unknown, _id: unknown, run: Function) => run(() => {}) } as any,
		identity: { kind: "recon", cwd: ctx.cwd, parentSessionId: "test", toolCallId: "test", requestedModel: config.agents.recon.model, thinking: config.agents.recon.thinking },
		agent: config.agents.recon, task: "queued", timeoutMs: 1000, background: true, config,
		childRunner: async input => { launched = input; return { text: "done", exitCode: 0, stderrTail: "" }; },
	});
	const original = structuredClone(config.agents.recon);
	await command.command("", testCtx, true);
	assert.deepEqual(notices, []);
	assert.equal(additions, 1, "New roles refresh the native tool declaration after acceptance");
	assert.equal(screen, actions.length);
	assert.equal(resizedTools, true);
	assert.deepEqual(created, { enabled: true, model: "test/available", thinking: "off", prompt: "Write documents.\nKeep scope.", tools: [], extensions: false });
	assert.deepEqual(config.agents.writer, { ...created, enabled: false }, "Newly created roles remain editable without reload");
	assert.equal(config.agents.recon.enabled, false);
	assert.equal(config.agents.recon.extensions, true);
	assert.deepEqual(config.agents.recon.tools, ["read"]);
	assert.equal(config.agents.recon.prompt, "New recon prompt.\nSecond line.");
	assert.equal(config.agents.recon.responseTemplate, "  Summary:\n{{literal}}\n");
	assert.equal(config.agents.recon.saveToFile, true);
	let saved = JSON.parse(readFileSync(paths.userPath, "utf8"));
	assert.deepEqual(saved.unrelated, overlay.unrelated);
	assert.equal(saved.agents.recon.offline, true);
	assert.deepEqual(saved.agents.recon.context, ["legacy"]);
	assert.equal(saved.agents.recon.note, "keep");
	assert.equal(saved.agents.recon.responseTemplate, config.agents.recon.responseTemplate);
	assert.equal(saved.agents.recon.saveToFile, true);
	assert.deepEqual(loadDelegateConfig(paths).agents.recon, config.agents.recon);
	// Cancelling the editor preserves its prefill; clearing and toggling remain draft-only on Back.
	const savedRole = structuredClone(config.agents.recon);
	const discardStart = actions.length;
	actions.push([6], [6], [7, -1]);
	picks = 2;
	await command.command("", testCtx, true);
	assert.equal(edits, 5);
	assert.deepEqual(config.agents.recon, savedRole);
	assert.deepEqual(JSON.parse(readFileSync(paths.userPath, "utf8")), saved);
	// Paste a whole schema, retry invalid text verbatim, and preserve the template.
	const schemaText = ' {\n  "$schema": "http://json-schema.org/draft-07/schema#",\n  "type": "object",\n  "properties": {"summary": {"type": "string"}},\n  "required": ["summary"],\n  "additionalProperties": false\n}\n';
	const schema = JSON.parse(schemaText);
	let editorSteps: Array<[string, string | undefined]> = [];
	testCtx.ui.editor = async (_title: string, prefill: string) => {
		const step = editorSteps.shift();
		assert.ok(step, "Unexpected schema editor");
		assert.equal(prefill, step[0], "Invalid text must be retained exactly");
		return step[1];
	};
	const editSchema = async (moves: number[][], steps: Array<[string, string | undefined]>) => {
		actions.push(...moves);
		editorSteps = [...steps];
		picks = 2;
		await command.command("", testCtx, true);
		assert.equal(editorSteps.length, 0);
		assert.equal(screen, actions.length);
	};
	await editSchema([[8], [9, 10]], [["", schemaText]]);
	assert.deepEqual(config.agents.recon.responseSchema, schema);
	assert.equal(config.agents.recon.responseRepairAttempts, 0);
	assert.equal(config.agents.recon.responseTemplate, savedRole.responseTemplate);
	assert.deepEqual(loadDelegateConfig(paths).agents.recon, config.agents.recon);
	const schemaSaved = JSON.parse(readFileSync(paths.userPath, "utf8"));
	assert.deepEqual(schemaSaved.agents.recon.responseSchema, schema);
	assert.equal(schemaSaved.agents.recon.responseRepairAttempts, 0);
	const prefill = JSON.stringify(schema, null, 2);
	const invalidJson = ' { "type": ';
	const invalidSchema = ' {\n "type": "not-a-type"\n} ';
	const nonDraft07 = '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}';
	const noticeStart = notices.length;
	await editSchema([[8], [10]], [
		[prefill, invalidJson], [invalidJson, invalidSchema], [invalidSchema, nonDraft07], [nonDraft07, undefined],
	]);
	assert.equal(notices.length, noticeStart + 3);
	assert.ok(notices.slice(noticeStart).every(text => /Invalid response schema/.test(text)));
	assert.deepEqual(config.agents.recon.responseSchema, schema, "Esc after errors preserves the original draft schema");
	assert.deepEqual(JSON.parse(readFileSync(paths.userPath, "utf8")), schemaSaved);
	await editSchema([[8], [10]], [[prefill, undefined]]);
	assert.deepEqual(config.agents.recon.responseSchema, schema, "Cancelled editing preserves the schema");
	await editSchema([[8], [9, 9, 10]], [[prefill, "  \n"]]);
	assert.equal(config.agents.recon.responseSchema, null, "Empty editor explicitly disables schema inheritance");
	assert.equal(config.agents.recon.responseRepairAttempts, 2);
	assert.equal(config.agents.recon.responseTemplate, savedRole.responseTemplate);
	saved = JSON.parse(readFileSync(paths.userPath, "utf8"));
	assert.equal(saved.agents.recon.responseSchema, null);
	assert.equal(saved.agents.recon.responseRepairAttempts, 2);
	assert.deepEqual(loadDelegateConfig(paths).agents.recon, config.agents.recon);
	await accepted.run({ id: "queued" }, new AbortController().signal, () => {}, () => {});
	assert.equal(archivedPrompt, original.prompt);
	assert.equal(launched.model, original.model);
	assert.equal(launched.thinking, original.thinking);
	assert.equal(launched.extensions, original.extensions);
	assert.deepEqual(launched.tools, original.tools);
	// Unrelated external edits conflict too; no overlay fields may be silently lost.
	writeFileSync(paths.userPath, JSON.stringify({ ...saved, changedExternally: true }));
	picks = 2; screen = discardStart - 1;
	await command.command("", testCtx, true);
	assert.ok(notices.some(text => /changed on disk/.test(text)));
	assert.equal(JSON.parse(readFileSync(paths.userPath, "utf8")).changedExternally, true);
	command.stop();
	return { editor: true, safeDefaults: true, preservedOverlay: true, acceptedSnapshot: true };
}
