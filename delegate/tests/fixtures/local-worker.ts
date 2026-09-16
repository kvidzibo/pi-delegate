import { LocalControl } from "../../local-control.ts";
import { LocalCommand } from "../../local-command.ts";
import { JobScheduler } from "../../jobs.ts";

const control = new LocalControl(process.argv[2]);
const scheduler = new JobScheduler({ maxConcurrent: 3, maxLocalConcurrent: 1, maxQueued: 3, localAdmission: control });
const command = new LocalCommand(control, () => scheduler.refreshLocalState());
command.start({ hasUI: false, ui: {} } as any);
const finishes = new Map<string, () => void>();
process.on("message", async (message: any) => {
	try {
		let value: unknown;
		if (message.cmd === "crash") process.exit(0); // simulate parent exit without child cleanup
		if (message.cmd === "launch") value = scheduler.enqueue({
			kind: "recon", model: "test/model", local: message.local !== false, task: "mock only", timeoutMs: 1000, background: true,
			run: async (job, signal) => {
				if (message.hold) await new Promise<void>(resolve => { finishes.set(job.id, resolve); signal.addEventListener("abort", () => resolve(), { once: true }); });
				return { text: "done", exitCode: 0, stderrTail: "" };
			},
		});
		else if (message.cmd === "finish") { finishes.get(message.jobId)?.(); value = await scheduler.wait(message.jobId); }
		else if (message.cmd === "get") value = scheduler.get(message.jobId);
		else if (message.cmd === "shutdown") { command.stop(); await scheduler.shutdown(); value = true; }
		process.send?.({ id: message.id, value });
	} catch (error) { process.send?.({ id: message.id, error: String(error) }); }
});
