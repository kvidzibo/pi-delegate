import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { FileCapacityBroker, validateResourceGroup, type ResourceLease } from "../capacity.ts";
import { readLeaseIdentity, verifyLease } from "../../child-runtime/lease.ts";

const shared = { key: "shared-server", capacity: 1 };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const linux = { skip: process.platform !== "linux" };
const groupDir = (root: string, key = shared.key) => join(root, createHash("sha256").update(key).digest("hex"));

function worker(root: string, cwd: string) {
	const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./fixtures/capacity-worker.ts", import.meta.url)), root], {
		cwd, stdio: ["pipe", "pipe", "pipe"],
	});
	const closed = once(child, "close"); let seq = 0, stderr = "";
	child.stderr.on("data", data => { stderr = (stderr + data).slice(-4000); });
	const waiting = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
	createInterface({ input: child.stdout }).on("line", line => {
		const message = JSON.parse(line), pending = waiting.get(message.id); waiting.delete(message.id);
		if (message.error) pending?.reject(new Error(message.error)); else pending?.resolve(message.result);
	});
	child.on("close", () => { for (const pending of waiting.values()) pending.reject(new Error(`worker closed: ${stderr}`)); waiting.clear(); });
	return {
		call: (value: object): Promise<any> => new Promise((resolve, reject) => {
			const id = ++seq;
			const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`capacity worker timed out: ${stderr}`)); }, 5000);
			waiting.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
			child.stdin.write(JSON.stringify({ id, ...value }) + "\n");
		}),
		kill: async () => { child.kill("SIGKILL"); await closed; },
		close: async () => {
			if (child.exitCode === null && child.signalCode === null) child.stdin.end();
			const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
			try { await closed; } finally { clearTimeout(timer); }
		},
	};
}

function fixture(t: TestContext) {
	const root = mkdtempSync("/tmp/pi-delegate-capacity-");
	const leases: ResourceLease[] = [], workers: ReturnType<typeof worker>[] = [];
	let orphan = false;
	t.after(async () => {
		await Promise.all(workers.map(worker => worker.close()));
		for (const lease of leases) lease.release();
		if (orphan) await sleep(750); // Only our short-lived inherited-descriptor test child.
		rmSync(root, { recursive: true, force: true });
	});
	return { root, broker: new FileCapacityBroker(root),
		keep: (lease: ResourceLease | undefined) => { if (lease) leases.push(lease); return lease; },
		worker: (cwd = root) => { const child = worker(root, cwd); workers.push(child); return child; },
		orphan: () => { orphan = true; },
	};
}

test("resource keys/capacities are explicit and validated before creating state", linux, t => {
	const f = fixture(t);
	assert.deepEqual(validateResourceGroup(shared), shared);
	for (const key of ["", "../bad", "bad/key", "bad\nkey", "x".repeat(129)]) assert.throws(() => validateResourceGroup({ key, capacity: 1 }));
	for (const capacity of [0, -1, 0.5, NaN, 65]) assert.throws(() => validateResourceGroup({ key: "valid", capacity }));
	assert.throws(() => new FileCapacityBroker("relative"), /absolute/);
	assert.throws(() => new FileCapacityBroker(f.root, { flockPath: "relative" }), /absolute/);
	assert.equal(existsSync(groupDir(f.root)), false);
});

test("separate brokers enforce a resource-wide limit, independent groups, and idempotent release", linux, t => {
	const f = fixture(t), peer = new FileCapacityBroker(f.root);
	const first = f.keep(f.broker.tryAcquire(shared))!; assert.ok(first);
	assert.equal(peer.tryAcquire(shared), undefined);
	assert.deepEqual(readLeaseIdentity(first.inherited.fd), { dev: first.inherited.dev, ino: first.inherited.ino });
	assert.doesNotThrow(() => verifyLease(first.inherited.fd, first.inherited));
	assert.throws(() => verifyLease(first.inherited.fd, { ...first.inherited, ino: "0" }), /identity changed/);
	const independent = f.keep(peer.tryAcquire({ key: "another-server", capacity: 1 })); assert.ok(independent);
	const inode = statSync(join(groupDir(f.root), "slot-0.lock")).ino;
	first.release(); first.release();
	const next = f.keep(peer.tryAcquire(shared)); assert.ok(next);
	assert.equal(statSync(join(groupDir(f.root), "slot-0.lock")).ino, inode, "stable lock inode must never be replaced on release");
});

test("capacity changes require quiescence, and a missing catalog cannot steal a live slot", linux, t => {
	const f = fixture(t), pair = { key: shared.key, capacity: 2 };
	const a = f.keep(f.broker.tryAcquire(pair))!, b = f.keep(f.broker.tryAcquire(pair))!;
	assert.deepEqual([a.claim.slot, b.claim.slot], [0, 1]); assert.equal(f.broker.tryAcquire(pair), undefined);
	assert.throws(() => f.broker.tryAcquire(shared), /conflicts with live leases/);
	a.release(); assert.throws(() => f.broker.tryAcquire(shared), /conflicts with live leases/);
	b.release(); const reduced = f.keep(f.broker.tryAcquire(shared))!; assert.ok(reduced);
	assert.equal(JSON.parse(readFileSync(join(groupDir(f.root), "capacity.json"), "utf8")).capacity, 1);
	unlinkSync(join(groupDir(f.root), "capacity.json"));
	assert.throws(() => f.broker.tryAcquire(pair), /conflicts with live leases/);
	reduced.release(); assert.ok(f.keep(f.broker.tryAcquire(pair)));
});

test("missing flock, corrupt metadata, permissive files and symlinks fail closed", linux, t => {
	const f = fixture(t);
	assert.throws(() => new FileCapacityBroker(f.root, { flockPath: join(f.root, "missing") }).tryAcquire(shared), /locking unavailable/);
	const lease = f.keep(f.broker.tryAcquire(shared))!; lease.release();
	const metadata = join(groupDir(f.root), "capacity.json"), saved = readFileSync(metadata, "utf8");
	writeFileSync(metadata, "not json"); assert.throws(() => f.broker.tryAcquire(shared));
	writeFileSync(metadata, saved); chmodSync(metadata, 0o644);
	assert.throws(() => f.broker.tryAcquire(shared), /private regular file/); chmodSync(metadata, 0o600);
	const slot = join(groupDir(f.root), "slot-0.lock"), target = join(f.root, "foreign-target");
	writeFileSync(target, "unchanged", { mode: 0o600 }); unlinkSync(slot); symlinkSync(target, slot);
	assert.throws(() => f.broker.tryAcquire(shared)); assert.equal(readFileSync(target, "utf8"), "unchanged");
	chmodSync(f.root, 0o755); assert.throws(() => f.broker.tryAcquire(shared), /private \(0700\)/); chmodSync(f.root, 0o700);
});

test("mutex-close failure releases a provisionally acquired slot before acquisition throws", linux, t => {
	const f = fixture(t), originalClose = fs.closeSync;
	const target = join(groupDir(f.root), "slot-0.lock");
	let injected = false, provisional: number | undefined, recovered: ResourceLease | undefined;
	const path = (fd: number) => { try { return fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { return ""; } };
	const mocked = t.mock.method(fs, "closeSync", (fd: number) => {
		if (!injected && path(fd) === join(groupDir(f.root), "catalog.lock")) {
			injected = true;
			provisional = fs.readdirSync("/proc/self/fd").map(Number).find(fd => path(fd) === target);
			originalClose(fd); throw new Error("simulated mutex close failure");
		}
		originalClose(fd);
	});
	syncBuiltinESMExports();
	try {
		assert.throws(() => f.broker.tryAcquire(shared), /simulated mutex close failure/);
		recovered = f.keep(f.broker.tryAcquire(shared));
		assert.ok(recovered, "failed acquisition must not strand its provisional lease");
	} finally {
		mocked.mock.restore(); syncBuiltinESMExports();
		// Also clean up the intentional pre-fix reproduction's leaked descriptor.
		if (!recovered && provisional !== undefined && path(provisional) === target) originalClose(provisional);
	}
});

test("capacity-change cleanup attempts every held descriptor after a close error", linux, t => {
	const f = fixture(t), pair = { ...shared, capacity: 2 };
	f.keep(f.broker.tryAcquire(pair))!.release();
	// Materialize the second stable slot before starting the failure injection.
	const first = f.keep(f.broker.tryAcquire(pair))!, second = f.keep(f.broker.tryAcquire(pair))!;
	first.release(); second.release();
	const originalClose = fs.closeSync, target = join(groupDir(f.root), "slot-1.lock");
	const path = (fd: number) => { try { return fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { return ""; } };
	let injected = false, remaining: number | undefined;
	const mocked = t.mock.method(fs, "closeSync", (fd: number) => {
		if (!injected && path(fd) === join(groupDir(f.root), "slot-0.lock")) {
			injected = true; remaining = fs.readdirSync("/proc/self/fd").map(Number).find(fd => path(fd) === target);
			originalClose(fd); throw new Error("simulated slot close failure");
		}
		originalClose(fd);
	});
	syncBuiltinESMExports();
	try {
		assert.throws(() => f.broker.tryAcquire(shared), /simulated slot close failure/);
		assert.ok(f.keep(f.broker.tryAcquire(pair)), "remaining slots must not retain abandoned cleanup locks");
	} finally {
		mocked.mock.restore(); syncBuiltinESMExports();
		if (remaining !== undefined && path(remaining) === target) originalClose(remaining);
	}
});

test("independent Node processes in different cwd values cannot overlap on one resource", linux, async t => {
	const f = fixture(t), a = f.worker(f.root), b = f.worker("/tmp");
	const attempts = await Promise.all([a.call({ op: "try", name: "lease", group: shared }), b.call({ op: "try", name: "lease", group: shared })]);
	assert.equal(attempts.filter(result => result.acquired).length, 1);
	const [holder, waiter] = attempts[0].acquired ? [a, b] : [b, a];
	assert.equal((await waiter.call({ op: "try", name: "other", group: { key: "other-server", capacity: 1 } })).acquired, true);
	await holder.call({ op: "release", name: "lease" });
	assert.equal((await waiter.call({ op: "try", name: "lease", group: shared })).acquired, true);
});

test("process death releases a lease without PID files or stale-age stealing", linux, async t => {
	const f = fixture(t), holder = f.worker(), peer = f.worker();
	assert.equal((await holder.call({ op: "try", name: "lease", group: shared })).acquired, true);
	assert.equal((await peer.call({ op: "try", name: "lease", group: shared })).acquired, false);
	await holder.kill();
	assert.equal((await peer.call({ op: "try", name: "lease", group: shared })).acquired, true);
});

test("a child-inherited descriptor keeps occupancy after parent death until the child exits", linux, async t => {
	const f = fixture(t), holder = f.worker(), peer = f.worker(); f.orphan();
	assert.equal((await holder.call({ op: "try", name: "lease", group: shared })).acquired, true);
	assert.equal((await holder.call({ op: "fork", name: "lease" })).inherited, true);
	await holder.kill();
	assert.equal((await peer.call({ op: "try", name: "lease", group: shared })).acquired, false);
	let acquired = false;
	for (let i = 0; i < 50 && !acquired; i++) { await sleep(30); acquired = (await peer.call({ op: "try", name: "lease", group: shared })).acquired; }
	assert.equal(acquired, true);
});
