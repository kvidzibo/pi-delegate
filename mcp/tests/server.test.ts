import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createMcpServer } from "../tools.ts";
import { DelegateService } from "../../delegate/service.ts";
import { loadDelegateConfig } from "../../delegate/config.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** Real stdio transport and owned offline workers; never contacts a model. */
test("packaged MCP launch, retries, observation, controls and connection cleanup", { timeout: 30000 }, async () => {
	const temp = mkdtempSync(join(tmpdir(), "pi-delegate-mcp-"));
	const workerLog = join(temp, "workers.jsonl");
	const worker = join(temp, "fake-pi");
	writeFileSync(worker, `#!/usr/bin/env node
import { readFileSync, appendFileSync, fstatSync } from 'node:fs';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
if (!args.includes('--mode') || !args.includes('rpc') || !args.includes('--no-context-files')) process.exit(9);
readFileSync(args[args.indexOf('--system-prompt') + 1]);
const record = data => appendFileSync(process.env.WORKER_LOG, JSON.stringify(data) + '\\n');
const send = data => process.stdout.write(JSON.stringify(data) + '\\n');
record({pid:process.pid, args, type:'start'});
process.on('SIGTERM', () => {record({pid:process.pid,type:'stop'}); process.exit(0)});
const lease = process.env.PI_DELEGATE_LEASE_STARTUP;
if (lease) {
  const config=JSON.parse(lease), stat=fstatSync(3);
  if(String(stat.dev)!==config.lease.dev || String(stat.ino)!==config.lease.ino) process.exit(8);
  readFileSync(args[args.indexOf('--extension') + 1]);
  send({type:'extension_ui_request',method:'notify',message:JSON.stringify({type:'delegate-lease-ready',version:1,...config})});
}
let timer;
const finish = text => {
  if(timer)clearTimeout(timer);
  send({type:'message_end',message:{role:'assistant',provider:'test',model:'worker',stopReason:'stop',content:[{type:'text',text}]}});
  send({type:'agent_settled'});
};
const input=createInterface({input:process.stdin});
input.on('line', line => {
  const msg=JSON.parse(line);
  if(msg.type==='prompt') {
    const task=msg.message.replace(/^Task: /, '');
    record({pid:process.pid,type:'prompt',task});
    send({type:'response',command:'prompt',id:msg.id,success:true});
    if(task==='hold')timer=setTimeout(()=>finish('late'),60000);
    else finish('offline report');
  } else if(msg.type==='steer') {
    send({type:'message_end',message:{role:'user',content:msg.message}});
    finish('wrapped');
  } else if(msg.type==='abort') {if(timer)clearTimeout(timer);send({type:'agent_settled'});}
});
input.on('close',()=>{if(timer)clearTimeout(timer);process.exit(0)});
`, { mode: 0o755 });
	// ESM worker fixture lives outside the package; declare its own format.
	writeFileSync(join(temp, "package.json"), '{"type":"module"}\n');
	const workspace = join(temp, "workspace");
	execFileSync("git", ["init", "-q", workspace]);
	const config = join(temp, "config.json");
	writeFileSync(config, JSON.stringify({
		maxConcurrent: 1, snapshots: { directory: join(temp, "snapshots"), repositories: { [workspace]: true } },
		agents: { recon: { model: "test/worker", offline: true }, implement: { model: "test/worker", offline: true } },
	}));
	const env = { PATH: process.env.PATH, HOME: temp, USERPROFILE: temp, SystemRoot: process.env.SystemRoot,
		PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_DELEGATE_LOG: "0", WORKER_LOG: workerLog };
	const launch = (extra: string[] = [], overrides: Record<string, string> = {}) => spawn(process.execPath, [
		join(root, "dist/server.js"), "--workspace", workspace, "--agent-dir", join(temp, "agent"),
		"--config", config, "--pi-command", worker, ...extra,
	], { env: { ...env, ...overrides }, stdio: "pipe" });
	const children: ChildProcessWithoutNullStreams[] = [];
	const connect = async () => {
		const child = launch(); children.push(child);
		let tail = "", stderr = "", seq = 0;
		const replies = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
		const lines: any[] = [];
		child.stderr.on("data", chunk => { stderr += chunk.toString(); });
		child.stdin.on("error", () => {}); // The closed transport may reject pending client writes.
		child.stdout.on("data", chunk => {
			tail += chunk.toString();
			let end: number;
			while ((end = tail.indexOf("\n")) !== -1) {
				const raw = tail.slice(0, end); tail = tail.slice(end + 1);
				let message: any;
				try { message = JSON.parse(raw); } catch { assert.fail(`Non-protocol stdout: ${raw}`); }
				lines.push(message);
				const reply = replies.get(message.id);
				if (reply) { replies.delete(message.id); reply.resolve(message); }
			}
		});
		child.on("close", code => {
			for (const reply of replies.values()) reply.reject(new Error(`MCP closed (${code}): ${stderr}`));
			replies.clear();
		});
		const request = (method: string, params: unknown = {}) => {
			const id = ++seq;
			const result = new Promise<any>((resolve, reject) => replies.set(id, { resolve, reject }));
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
			return result;
		};
		const init = await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "offline-test", version: "1" } });
		assert.equal(init.result.serverInfo.name, "pi-delegate");
		child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
		const call = async (name: string, args: unknown) => {
			const reply = await request("tools/call", { name, arguments: args });
			assert.equal(reply.error, undefined, JSON.stringify(reply));
			return reply.result;
		};
		return { child, request, call, lines, lastRequestId: () => seq, stderr: () => stderr };
	};
	try {
		await cancelledStartProbe(temp, workspace, config);
		const client = await connect();
		const listed = await client.request("tools/list");
		assert.deepEqual(listed.result.tools.map((tool: any) => tool.name).sort(), ["delegate_control", "delegate_start", "delegate_status"]);
		const launchArgs = { kind: "implement", task: "hold", requestId: "retry-safe" };
		const first = (await client.call("delegate_start", launchArgs)).structuredContent;
		assert.equal(first.reused, false);
		const id = first.job.jobId;
		const retry = (await client.call("delegate_start", launchArgs)).structuredContent;
		assert.equal(retry.reused, true);
		assert.equal(retry.job.jobId, id);
		assert.equal((await client.call("delegate_start", { ...launchArgs, task: "different" })).isError, true);
		assert.equal((await client.call("delegate_start", { ...launchArgs, requestId: "escape", cwd: ".." })).isError, true);
		assert.equal((await client.call("delegate_start", { ...launchArgs, requestId: "override", model: "test/other" })).isError, true);
		const invalid = await client.request("tools/call", { name: "delegate_start", arguments: { ...launchArgs, auditId: "not-approval" } });
		assert.ok(invalid.error || invalid.result?.isError);
		const observed = (await client.call("delegate_status", { jobId: id, waitMs: 30 })).structuredContent.job;
		assert.equal(observed.terminal, false, JSON.stringify(observed));
		// Cancel only the observation request; the worker must keep running.
		const cancelledWait = client.request("tools/call", { name: "delegate_status", arguments: { jobId: id, waitMs: 20000 } });
		const cancelledId = client.lastRequestId();
		childNotify(client.child, { method: "notifications/cancelled", params: { requestId: cancelledId } });
		// Cancelled requests are not required to respond; consume either outcome during teardown.
		void cancelledWait.catch(() => {});
		const afterWait = (await client.call("delegate_status", { jobId: id })).structuredContent.job;
		assert.equal(afterWait.terminal, false);
		assert.notEqual(afterWait.cancellationRequested, true);
		const queued = (await client.call("delegate_start", { kind: "recon", task: "report", requestId: "queued" })).structuredContent.job;
		assert.equal(queued.status, "queued");
		await client.call("delegate_control", { jobId: queued.jobId, action: "wrap" });
		assert.equal((await client.call("delegate_status", { jobId: queued.jobId })).structuredContent.job.stopReason, "aborted");
		await client.call("delegate_control", { jobId: id, action: "cancel" });
		const cancelled = (await client.call("delegate_status", { jobId: id, waitMs: 10000 })).structuredContent.job;
		assert.equal(cancelled.terminal, true);
		assert.equal(cancelled.stopReason, "aborted");
		const success = (await client.call("delegate_start", { kind: "recon", task: "report", requestId: "success" })).structuredContent.job;
		const result = (await client.call("delegate_status", { jobId: success.jobId, waitMs: 10000 })).structuredContent.job;
		assert.equal(result.status, "done");
		assert.equal(result.answer, "offline report");
		assert.equal(result.outcome.taskAssessment, "not-performed");
		assert.ok(result.durationMs >= 0);
		const metadata = JSON.parse(readFileSync(join(dirname(result.archive.sessionFile), "metadata.json"), "utf8"));
		assert.equal(metadata.requestedModel, "test/worker");
		assert.equal(metadata.repositorySnapshot, undefined);
		assert.equal(existsSync(join(temp, "snapshots")), false);
		const summary = (await client.call("delegate_status", {})).structuredContent;
		assert.equal(summary.jobs.length, 3);
		assert.ok(summary.jobs.every((job: any) => job.answer === undefined));
		const hold = (await client.call("delegate_start", { kind: "implement", task: "hold", requestId: "shutdown" })).structuredContent.job;
		await client.call("delegate_status", { jobId: hold.jobId, waitMs: 50 });
		const closed = once(client.child, "close");
		client.child.stdin.end();
		assert.equal((await closed)[0], 0, client.stderr());
		const stoppedMetadata = JSON.parse(readFileSync(join(dirname(hold.archive.sessionFile), "metadata.json"), "utf8"));
		assert.equal(stoppedMetadata.stopReason, "aborted");
		const restarted = await connect();
		assert.equal((await restarted.call("delegate_status", { jobId: id })).isError, true);
		const stopped = once(restarted.child, "close"); restarted.child.stdin.end(); await stopped;
		// SDK-initiated wire closure does not necessarily emit stdin EOF/close.
		const brokenWire = await connect();
		const active = (await brokenWire.call("delegate_start", { kind: "implement", task: "hold", requestId: "transport-close" })).structuredContent.job;
		await brokenWire.call("delegate_status", { jobId: active.jobId, waitMs: 50 });
		const transportClosed = once(brokenWire.child, "close");
		brokenWire.child.stdin.write("x".repeat(11 * 1024 * 1024)); // No newline and no client EOF.
		assert.equal((await transportClosed)[0], 0, brokenWire.stderr());
		const disconnectedMetadata = JSON.parse(readFileSync(join(dirname(active.archive.sessionFile), "metadata.json"), "utf8"));
		assert.equal(disconnectedMetadata.stopReason, "aborted");
		assert.match(brokenWire.stderr(), /buffer/i);
		// Independent MCP processes must retain the same user-scoped local lease namespace.
		writeFileSync(config, JSON.stringify({ maxConcurrent: 1, agents: {
			recon: { model: "ollama/offline-fixture", offline: true },
			implement: { model: "test/worker", offline: true },
		} }));
		const localA = await connect(), localB = await connect();
		const local = (await localA.call("delegate_start", { kind: "recon", task: "hold", requestId: "local-a" })).structuredContent.job;
		await localA.call("delegate_status", { jobId: local.jobId, waitMs: 100 });
		const waiting = (await localB.call("delegate_start", { kind: "recon", task: "report", requestId: "local-b" })).structuredContent.job;
		const blocked = (await localB.call("delegate_status", { jobId: waiting.jobId, waitMs: 100 })).structuredContent.job;
		assert.equal(blocked.status, "queued");
		assert.equal(blocked.queueReason, "resource");
		const bypass = (await localB.call("delegate_start", { kind: "implement", task: "report", requestId: "hosted-bypass" })).structuredContent.job;
		assert.equal((await localB.call("delegate_status", { jobId: bypass.jobId, waitMs: 10000 })).structuredContent.job.status, "done");
		await localA.call("delegate_control", { jobId: local.jobId, action: "cancel" });
		assert.equal((await localA.call("delegate_status", { jobId: local.jobId, waitMs: 10000 })).structuredContent.job.terminal, true);
		assert.equal((await localB.call("delegate_status", { jobId: waiting.jobId, waitMs: 10000 })).structuredContent.job.answer, "offline report");
		const localClosed = [once(localA.child, "close"), once(localB.child, "close")];
		localA.child.stdin.end(); localB.child.stdin.end();
		for (const close of localClosed) assert.equal((await close)[0], 0);
		const nested = launch([], { PI_DELEGATE_CHILD: "1" }); children.push(nested);
		let nestingError = ""; nested.stderr.on("data", chunk => { nestingError += chunk; });
		assert.equal((await once(nested, "close"))[0], 1);
		assert.match(nestingError, /Nesting is forbidden/);
		const workerEvents = readFileSync(workerLog, "utf8").trim().split("\n").map(line => JSON.parse(line));
		assert.equal(workerEvents.filter(event => event.type === "start").length, 7);
		assert.equal(workerEvents.filter(event => event.type === "prompt" && event.task === "hold").length, 4);
		assert.ok(workerEvents.filter(event => event.type === "start").every(event => !event.args.includes("--workspace")));
	} finally {
		await Promise.all(children.map(child => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			const closed = once(child, "close");
			child.kill("SIGTERM");
			return closed;
		}));
		rmSync(temp, { recursive: true, force: true });
	}
});

async function cancelledStartProbe(temp: string, workspace: string, configPath: string): Promise<void> {
	const [client, wire] = InMemoryTransport.createLinkedPair();
	const messages: any[] = [];
	const replies = new Map<number, (value: any) => void>();
	client.onmessage = (message: any) => { messages.push(message); replies.get(message.id)?.(message); };
	let launches = 0;
	const service = new DelegateService({
		workspace, agentDir: join(temp, "cancellation-agent"),
		config: loadDelegateConfig({ shippedPath: join(root, "delegate/config.json"), userPath: configPath }),
		promptDir: join(root, "delegate/prompts"), invocation: { command: "unused-offline-worker", args: [] },
		leaseGuardPath: join(root, "dist/lease-guard.js"), env: { PI_DELEGATE_LOG: "0" },
		childRunner: input => {
			launches++;
			// Cancel synchronously after acceptance started, before the SDK returns its receipt.
			void client.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 3 } });
			return new Promise(resolve => input.signal!.addEventListener("abort", () => {
				resolve({ text: "cancelled offline worker", exitCode: 1, stopReason: "aborted", stderrTail: "" });
			}, { once: true }));
		},
	});
	const handle = serveStdio(() => createMcpServer(service, "test"), { transport: wire });
	try {
		await client.start();
		const initialized = new Promise<any>(resolve => replies.set(1, resolve));
		await client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
			protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "cancel-race", version: "1" },
		} });
		await initialized;
		await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
		const params = { name: "delegate_start", arguments: { kind: "implement", task: "offline", requestId: "before-acceptance" } };
		await client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params });
		await client.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } });
		await setImmediate();
		assert.equal(launches, 0, "cancelled validation must not launch a worker");
		assert.equal(service.list().jobs.length, 0);
		assert.ok(!messages.some(message => message.id === 2));
		const acceptedParams = { name: "delegate_start", arguments: { ...params.arguments, requestId: "after-acceptance" } };
		await client.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: acceptedParams });
		await setImmediate();
		assert.equal(launches, 1);
		assert.ok(!messages.some(message => message.id === 3));
		const retry = new Promise<any>(resolve => replies.set(4, resolve));
		await client.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: acceptedParams });
		const recovered = (await retry).result.structuredContent;
		assert.equal(recovered.reused, true);
		assert.equal(recovered.job.terminal, false);
		assert.equal(launches, 1, "a lost post-acceptance receipt must not duplicate work");
	} finally {
		await service.shutdown();
		await handle.close();
		await client.close();
	}
}

function childNotify(child: ChildProcessWithoutNullStreams, message: Record<string, unknown>): void {
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}
