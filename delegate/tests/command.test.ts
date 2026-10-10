import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { OPTIONS_EVENT, registerDelegateCommand } from "../command.ts";

test("single delegate command routes menu choices, arguments and optional entries without legacy commands", async () => {
	const commands = new Map<string, any>();
	const events = new EventEmitter();
	const lifetime = new AbortController();
	const calls: string[] = [], notices: string[] = [];
	const option = (name: string) => ({ name, description: name,
		handler: async (args: string) => { calls.push(`${name}:${args}`); } });
	registerDelegateCommand({ events, registerCommand: (name: string, command: unknown) => commands.set(name, command) } as any,
		[option("models"), { ...option("stats"), complete: prefix => ["session", "today", "all", "rebuild"].filter(value => value.startsWith(prefix)) }], lifetime.signal);
	assert.deepEqual([...commands.keys()], ["pi-delegate"]);
	const command = commands.get("pi-delegate");
	const choices: Array<string | undefined> = ["models — models", "stats — stats", undefined];
	let menuVisits = 0;
	const ctx: any = { hasUI: true, ui: {
		select: async (title: string, options: string[]) => {
			menuVisits++;
			assert.equal(title, "pi-delegate"); assert.deepEqual(options, ["models — models", "stats — stats"]); return choices.shift();
		},
		notify: (text: string) => notices.push(text),
	} };
	await command.handler("", ctx);
	assert.equal(menuVisits, 3, "returning from an option must reopen the main menu until it is cancelled");
	await command.handler(" stats   today ", ctx);
	assert.equal(menuVisits, 3, "direct subcommands must not open the menu");
	await command.handler("unknown", ctx);
	await command.handler("", { ...ctx, hasUI: false });
	assert.deepEqual(calls, ["models:", "stats:", "stats:today"]);
	assert.deepEqual(notices, Array(2).fill("Usage: /pi-delegate <models|stats>"));
	const complete = (prefix: string) => command.getArgumentCompletions(prefix).map((item: any) => item.value);
	assert.deepEqual(complete(""), ["models", "stats"]);
	assert.deepEqual(complete("m"), ["models"]);
	assert.deepEqual(complete("stats t"), ["stats today"]);
	assert.deepEqual(complete("models x"), []);
	events.on(OPTIONS_EVENT, options => options.push(option("export")));
	assert.deepEqual(complete("e"), ["export"]);
	await command.handler('export {"format":"json"}', ctx);
	assert.equal(calls.at(-1), 'export:{"format":"json"}');
	events.on(OPTIONS_EVENT, options => options.push({ name: "stop", description: "shutdown", handler: async () => lifetime.abort() }));
	let shutdownMenus = 0;
	await command.handler("", { ...ctx, ui: { ...ctx.ui, select: async () => { shutdownMenus++; return "stop — shutdown"; } } });
	assert.equal(shutdownMenus, 1, "shutdown must not reopen the parent menu");
});
