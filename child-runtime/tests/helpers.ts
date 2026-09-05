import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { runPiChild, type RunPiChildInput } from "../spawn.ts";

export type MockChild = ChildProcess & {
	stdinBytes: string;
	signals: Array<NodeJS.Signals | undefined>;
	close: (code: number) => void;
};

export function mockChild(): MockChild {
	const stdin = new PassThrough();
	const proc = new EventEmitter() as EventEmitter & MockChild;
	proc.stdin = stdin;
	proc.stdout = new PassThrough();
	proc.stderr = new PassThrough();
	// No OS pid, even if a test accidentally omits the injected terminator.
	proc.exitCode = null;
	proc.signalCode = null;
	proc.stdinBytes = "";
	proc.signals = [];
	proc.close = (code) => {
		if (proc.exitCode !== null) return;
		proc.exitCode = code;
		queueMicrotask(() => proc.emit("close", code));
	};
	stdin.on("data", (chunk: Buffer | string) => {
		proc.stdinBytes += chunk.toString();
	});
	stdin.on("end", () => proc.close(0));
	proc.kill = (signal) => {
		proc.signals.push(signal);
		proc.close(1);
		return true;
	};
	return proc;
}

// All fake subprocess runs must use this boundary, never process.kill().
export function runMockPiChild(input: RunPiChildInput) {
	return runPiChild({
		...input,
		killTree: (proc) => { proc.kill("SIGTERM"); },
	});
}
