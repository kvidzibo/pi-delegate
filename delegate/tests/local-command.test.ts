import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { LocalCommand } from "../local-command.ts";
import { LocalControl } from "../local-control.ts";

function setup(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "delegate-local-command-"));
	const control = new LocalControl(dir);
	let wakes = 0;
	const command = new LocalCommand(control, () => { wakes++; });
	const notices: string[] = [], statuses: Array<string | undefined> = [];
	const ctx: any = { hasUI: true, ui: {
		setStatus: (_key: string, text: string | undefined) => statuses.push(text),
		notify: (text: string) => notices.push(text),
		select: async () => undefined,
	} };
	t.after(() => { command.stop(); rmSync(dir, { recursive: true, force: true }); });
	return { dir, command, control, ctx, notices, statuses, wakes: () => wakes };
}

test("picker shows current state and global scope, selects absolute OFF/ON and Escape leaves state unchanged", async t => {
	const { command, control, ctx, notices, dir } = setup(t);
	const release = control.acquire()!;
	ctx.ui.select = async (title: string, options: string[]) => {
		assert.match(title, /ON · 1 job active/);
		assert.match(title, /All Pi sessions/);
		assert.deepEqual(options, ["On ✓ current", "Off"]);
		return "Off";
	};
	await command.command("", ctx);
	assert.match(notices.at(-1)!, /OFF · draining 1 job/);
	release();
	const before = readFileSync(join(dir, "state.json"), "utf8");
	ctx.ui.select = async (title: string, options: string[]) => {
		assert.match(title, /OFF · idle/);
		assert.deepEqual(options, ["Off ✓ current", "On"]);
		return undefined;
	};
	await command.command("", ctx);
	assert.equal(readFileSync(join(dir, "state.json"), "utf8"), before);
	ctx.ui.select = async () => "On";
	await command.command("", ctx);
	assert.equal(control.enabled(), true);
});

test("direct commands and live footer show draining then idle; repeated refreshes are deduplicated", async t => {
	const { command, control, ctx, notices, statuses, wakes } = setup(t);
	command.start(ctx);
	const release = control.acquire()!;
	await command.command("off", ctx);
	assert.match(statuses.at(-1)!, /OFF · draining 1 job/);
	release();
	command.refresh();
	assert.equal(statuses.at(-1), "Local delegation: OFF · idle");
	const count = statuses.length;
	command.refresh();
	assert.equal(statuses.length, count);
	await command.command("status", ctx);
	assert.match(notices.at(-1)!, /OFF · idle/);
	await command.command("on", ctx);
	assert.equal(statuses.at(-1), undefined);
	assert.ok(wakes() > 0);
	await command.command("garbage", ctx);
	assert.match(notices.at(-1)!, /Usage:/);
	assert.equal(control.enabled(), true);
});

test("poll observes another session without reload and stops on shutdown", async t => {
	const { command, control, ctx, statuses, wakes } = setup(t);
	command.start(ctx);
	control.setEnabled(false);
	await new Promise(r => setTimeout(r, 1100));
	assert.equal(statuses.at(-1), "Local delegation: OFF · idle");
	command.stop();
	const before = wakes();
	await new Promise(r => setTimeout(r, 1100));
	assert.equal(wakes(), before);
});

test("shutdown while picker is open prevents a late selection from changing the switch", async t => {
	const { command, control, ctx } = setup(t);
	let select!: (choice: string) => void;
	ctx.ui.select = async () => new Promise<string>(r => { select = r; });
	const pending = command.command("", ctx);
	command.stop(); command.start(ctx); select("Off"); await pending;
	assert.equal(control.enabled(), true);
});

test("throwing status UI does not block shared state changes or polling", async t => {
	const { command, control, ctx } = setup(t);
	ctx.ui.setStatus = () => { throw new Error("UI disposed"); };
	command.start(ctx);
	await command.command("off", ctx);
	assert.equal(control.enabled(), false);
	assert.doesNotThrow(() => command.refresh());
	assert.doesNotThrow(() => command.stop());
});
