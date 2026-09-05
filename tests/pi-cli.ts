import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Exercise the installed CLI/loader, never private unbundled Pi entrypoints. */
export async function runPiProbe(command: string): Promise<Record<string, unknown>> {
	const dir = mkdtempSync(join(tmpdir(), "pi-delegate-load-"));
	try {
		return await new Promise((resolve, reject) => {
			const child = spawn("pi", [
				"--offline", "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills",
				"--no-prompt-templates", "--no-context-files", "--no-themes", "--no-approve",
				"-e", REPO, "-e", join(REPO, "tests", "fixtures", "probe.ts"),
			], {
				cwd: dir,
				// No user settings, credentials, nesting markers, or startup network.
				env: {
					PATH: process.env.PATH, HOME: dir, USERPROFILE: dir, SystemRoot: process.env.SystemRoot,
					PI_CODING_AGENT_DIR: join(dir, "agent"), PI_CODING_AGENT_SESSION_DIR: join(dir, "sessions"),
					PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_DELEGATE_SKIP_USER_CONFIG: "1", PI_DELEGATE_LOG: "0", NO_COLOR: "1",
				},
				stdio: ["pipe", "pipe", "pipe"],
			});
			let output = "", tail = "", stderr = "";
			let result: Record<string, unknown> | undefined;
			let failure: Error | undefined;
			const timer = setTimeout(() => { failure = new Error(`Pi probe timeout: ${command}`); child.kill("SIGKILL"); }, 20000);
			child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-16000); });
			child.stdout.on("data", (chunk: string) => {
				output += chunk; tail += chunk;
				if (output.length > 1024 * 1024) { failure = new Error("Pi probe output limit"); child.kill("SIGKILL"); return; }
				let end: number;
				while ((end = tail.indexOf("\n")) !== -1) {
					const line = tail.slice(0, end); tail = tail.slice(end + 1);
					try {
						const event = JSON.parse(line);
						if (event.type !== "extension_ui_request" || event.method !== "notify") continue;
						const notice = JSON.parse(event.message);
						if (notice.type === "delegate_test_probe" && notice.command === command) {
							result = notice;
							// EOF shuts RPC down. Keep stdin open until async command work really finishes.
							child.stdin.end();
						}
					} catch { /* non-probe output */ }
				}
			});
			child.stdin.on("error", () => {});
			child.on("error", (error) => { clearTimeout(timer); reject(error); });
			child.on("close", (code) => {
				clearTimeout(timer);
				if (failure) reject(failure);
				else if (code !== 0 || !result) reject(new Error(`Pi probe did not finish (${code}): ${output}\n${stderr}`));
				else if (result.error) reject(new Error(String(result.error)));
				else resolve(result);
			});
			child.stdin.write(`${JSON.stringify({ id: "probe", type: "prompt", message: `/${command}` })}\n`);
		});
	} finally { rmSync(dir, { recursive: true, force: true }); }
}
