import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HistoricalCase } from "./cases.ts";

export type Validation = {
	ran: boolean; passed: boolean | null; exitCode?: number | null; signal?: NodeJS.Signals | null;
	output?: string; cause?: string; cleanupError?: string; passedTests?: string[];
};

/** Owned POSIX process group: timeout/abort/normal exit terminate workers and CLI descendants too. */
export function validateFixture(root: string, task: HistoricalCase, home: string, signal?: AbortSignal, timeoutMs = 5000): Promise<Validation> {
	if (!task.testFile) return Promise.resolve({ ran: false, passed: null });
	if (signal?.aborted) return Promise.resolve({ ran: false, passed: null, cause: "aborted" });
	if (process.platform === "win32") throw new Error("Historical fixture validation requires POSIX process groups");
	if (!task.expectedTests?.length) throw new Error("Missing expected fixture test names");
	mkdirSync(home, { mode: 0o700 });
	return new Promise(resolve => {
		const child = spawn(process.execPath, ["--test", "--test-reporter", fileURLToPath(new URL("./reporter.mjs", import.meta.url)), join(root, task.testFile!)], {
			cwd: join(root, "workspace"), detached: true, stdio: ["ignore", "pipe", "pipe"],
			// No model credentials, inherited NODE_OPTIONS or personal application paths.
			env: { PATH: dirname(process.execPath), HOME: home, USERPROFILE: home, TMPDIR: home, TEMP: home, TMP: home, LANG: "C.UTF-8", TZ: "UTC", SystemRoot: process.env.SystemRoot },
		});
		let output = "", bytes = 0, cause: string | undefined, cleanupError: string | undefined;
		const killGroup = () => {
			if (!child.pid) return;
			try { process.kill(-child.pid, "SIGKILL"); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") cleanupError = "Could not terminate the owned validation process group"; }
		};
		const stop = (reason: string) => { cause ??= reason; killGroup(); };
		const interrupt = () => stop("aborted");
		const timer = setTimeout(() => stop("timeout"), timeoutMs);
		const capture = (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > 65536) { stop("output-limit"); return; }
			output += chunk.toString("utf8");
		};
		child.stdout.on("data", capture); child.stderr.on("data", capture);
		child.on("error", error => { cause ??= error.message; });
		child.on("close", (exitCode, exitSignal) => {
			clearTimeout(timer); signal?.removeEventListener("abort", interrupt);
			// A worker can leave a same-group descendant with detached stdio after the leader exits.
			killGroup();
			const passedTests: string[] = [];
			try {
				for (const line of output.trim().split("\n").filter(Boolean)) {
					const event = JSON.parse(line);
					if (event.type === "test:pass" && event.data?.nesting === 0 && !event.data.skip && !event.data.todo) passedTests.push(event.data.name);
				}
			} catch { cause ??= "invalid-test-events"; }
			if (!task.expectedTests!.every(name => passedTests.includes(name))) cause ??= "missing-expected-tests";
			resolve({ ran: true, passed: !cause && !cleanupError && exitCode === 0 && !exitSignal,
				exitCode, signal: exitSignal, output, cause, cleanupError, passedTests });
		});
		signal?.addEventListener("abort", interrupt, { once: true });
		if (signal?.aborted) interrupt();
	});
}
