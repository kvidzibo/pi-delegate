import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Exercise the installed CLI/loader, never private unbundled Pi entrypoints. */
export function runPiProbe(command: string): Record<string, unknown> {
	const dir = mkdtempSync(join(tmpdir(), "pi-delegate-load-"));
	try {
		const stdout = execFileSync("pi", [
			"--offline", "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills",
			"--no-prompt-templates", "--no-context-files", "--no-themes", "--no-approve",
			"-e", REPO, "-e", join(REPO, "tests", "fixtures", "probe.ts"),
		], {
			cwd: dir,
			// No user settings, credentials, nesting markers, or startup network.
			env: {
				PATH: process.env.PATH,
				HOME: dir,
				USERPROFILE: dir,
				SystemRoot: process.env.SystemRoot,
				PI_CODING_AGENT_DIR: join(dir, "agent"),
				PI_CODING_AGENT_SESSION_DIR: join(dir, "sessions"),
				PI_OFFLINE: "1",
				PI_TELEMETRY: "0",
				PI_DELEGATE_SKIP_USER_CONFIG: "1",
				PI_DELEGATE_LOG: "0",
				NO_COLOR: "1",
			},
			input: `${JSON.stringify({ id: "probe", type: "prompt", message: `/${command}` })}\n`,
			encoding: "utf8", timeout: 20000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
		});
		const events = stdout.split("\n").flatMap((line) => {
			try { return [JSON.parse(line)]; } catch { return []; }
		});
		const notices = events.flatMap((event) => {
			if (event.type !== "extension_ui_request" || event.method !== "notify") return [];
			try { return [JSON.parse(event.message)]; } catch { return []; }
		});
		const result = notices.find((event) => event.type === "delegate_test_probe" && event.command === command);
		if (!result) throw new Error(`Pi probe did not finish: ${stdout}`);
		if (result.error) throw new Error(result.error);
		return result;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
