import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { FileCapacityBroker, type ResourceLease } from "../../capacity.ts";

// Offline test worker, never a Pi/model worker. All state is under the parent's temporary root.
const broker = new FileCapacityBroker(process.argv[2]);
const leases = new Map<string, ResourceLease>();
try {
	for await (const line of createInterface({ input: process.stdin })) {
		const call = JSON.parse(line);
		try {
			let result: unknown;
			if (call.op === "try") {
				if (leases.has(call.name)) throw new Error("Duplicate test lease name");
				const lease = broker.tryAcquire(call.group);
				if (lease) leases.set(call.name, lease);
				result = lease ? { acquired: true, ...lease.claim } : { acquired: false };
			} else if (call.op === "release") {
				leases.get(call.name)?.release(); leases.delete(call.name); result = { released: true };
			} else if (call.op === "fork") {
				const lease = leases.get(call.name); if (!lease) throw new Error("Unknown test lease");
				const child = spawn(process.execPath, ["-e", `require("node:fs").fstatSync(3); process.stdout.write("ready\\n"); setTimeout(() => process.exit(0), 700);`], {
					stdio: ["ignore", "pipe", "ignore", lease.inherited.fd],
				});
				await Promise.race([once(child.stdout!, "data"), once(child, "exit").then(() => { throw new Error("Inherited child exited before readiness"); })]);
				result = { inherited: true };
			} else throw new Error("Unknown test operation");
			process.stdout.write(JSON.stringify({ id: call.id, result }) + "\n");
		} catch (error) { process.stdout.write(JSON.stringify({ id: call.id, error: String(error) }) + "\n"); }
	}
} finally { for (const lease of leases.values()) lease.release(); }
