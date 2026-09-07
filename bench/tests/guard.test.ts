import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const scenario of ["budget", "missing-usage", "thinking", "tools", "metadata", "persist"]) {
	test(`real guard fails closed: ${scenario} (no model requests)`, t => {
		const dir = mkdtempSync(join(tmpdir(), "delegate-guard-test-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
		const file = join(dir, "budget.json"), dispatched = join(dir, "dispatched");
		writeFileSync(file, JSON.stringify({ model: "openai/luna", thinking: "low", tools: ["read"], local: false, budgetUsd: scenario === "budget" ? 0 : 1,
			maxRequests: 3, contextWindow: 1000, maxTokens: 100, pricing: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } }));
		const script = `import guard from ${JSON.stringify(new URL("../guard.ts", import.meta.url).href)};
			import {writeFileSync,mkdirSync} from 'node:fs';
			process.env.PI_DELEGATE_BENCH_BUDGET = ${JSON.stringify(file)};
			const hooks = new Map(); guard({on:(e,h)=>hooks.set(e,h),getActiveTools:()=>${JSON.stringify(scenario === "tools" ? [] : ["read"])}});
			hooks.get('session_start')();
			${scenario === "persist" ? `mkdirSync(${JSON.stringify(file + ".state.tmp")});` : ""}
			// Pi catches thrown hook errors; the guard must terminate, not just throw.
			try { hooks.get('before_provider_request')({}, {model:{provider:'openai',id:'luna',contextWindow:${scenario === "metadata" ? 2000 : 1000},maxTokens:100,cost:{input:2,output:10,cacheRead:0.2,cacheWrite:2.5}},thinkingLevel:'${scenario === "thinking" ? "off" : "low"}'}); } catch {}
			${scenario === "missing-usage" ? "try { hooks.get('message_end')({message:{role:'assistant',usage:{}}}); } catch {}" : ""}
			writeFileSync(${JSON.stringify(dispatched)},'guard incorrectly allowed continuation');`;
		const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 10000 });
		assert.equal(child.status, 2, child.stderr);
		assert.equal(existsSync(dispatched), false);
		const state = JSON.parse(readFileSync(file + ".state", "utf8"));
		if (scenario === "missing-usage") { assert.equal(state.pending, true); assert.ok(state.reservedUsd > 0); }
		if (scenario === "budget") assert.match(state.stopped, /Insufficient/);
		if (scenario === "persist") assert.equal(state.requests, 0, "stale startup receipt; no provider request was dispatched");
	});
}
