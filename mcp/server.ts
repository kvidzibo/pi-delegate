#!/usr/bin/env node
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadDelegateConfig } from "../delegate/config.ts";
import { DelegateService } from "../delegate/service.ts";
import { createMcpServer } from "./tools.ts";

declare const PACKAGE_VERSION: string;

const help = `pi-delegate-mcp --workspace <directory> [options]

Standalone stdio MCP server. Requires Pi on PATH; no parent Pi extension.
  --workspace <directory>    Required workspace; cwd requests stay below this root
  --pi-command <executable>  Pi executable (default: pi); not a shell command
  --agent-dir <directory>    Pi data and shared capacity (default: ~/.pi/agent)
  --config <file>            Delegate overlay (default: <agent-dir>/delegate.json)
  --allow-model-override     Allow per-job provider/model overrides
  --help                    Show this help
  --version                 Show package version

Snapshots are disabled. Workers are not sandboxed. Jobs belong to this connection.
`;

function resolvePath(path: string): string {
	return resolve(path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
}

async function main(): Promise<void> {
	const { values } = parseArgs({ options: {
		workspace: { type: "string" }, "pi-command": { type: "string" },
		"agent-dir": { type: "string" }, config: { type: "string" },
		"allow-model-override": { type: "boolean" }, help: { type: "boolean" }, version: { type: "boolean" },
	}, strict: true, allowPositionals: false });
	if (values.help) { process.stdout.write(help); return; }
	if (values.version) { process.stdout.write(`${PACKAGE_VERSION}\n`); return; }
	if (!values.workspace?.trim()) throw new Error("--workspace is required. Use --help for setup.");
	const command = values["pi-command"] ?? "pi";
	if (!command.trim()) throw new Error("--pi-command must be one executable, not blank.");
	const agentDir = resolvePath(values["agent-dir"] ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
	const configPath = values.config ? resolvePath(values.config) : join(agentDir, "delegate.json");
	if (values.config && !existsSync(configPath)) throw new Error(`Config file does not exist: ${configPath}`);
	const config = loadDelegateConfig({
		shippedPath: fileURLToPath(new URL("./config.json", import.meta.url)),
		userPath: !values.config && process.env.PI_DELEGATE_SKIP_USER_CONFIG === "1" ? undefined : configPath,
	});
	const service = new DelegateService({
		workspace: resolvePath(values.workspace), agentDir, config,
		promptDir: fileURLToPath(new URL("./prompts", import.meta.url)),
		invocation: { command: isAbsolute(command) || command.includes("/") ? resolvePath(command) : command, args: [] },
		leaseGuardPath: fileURLToPath(new URL("./lease-guard.js", import.meta.url)),
		allowModelOverride: values["allow-model-override"],
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
	});
	const handle = serveStdio(() => createMcpServer(service, PACKAGE_VERSION), {
		onerror: error => process.stderr.write(`MCP: ${error.message}\n`),
	});
	let closing: Promise<void> | undefined;
	const close = (): Promise<void> => closing ??= service.shutdown().finally(() => handle.close());
	const report = (error: unknown): void => {
		process.exitCode = 1;
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	};
	const shutdown = (): void => { void close().catch(report); };
	process.stdin.once("end", shutdown);
	process.stdin.once("close", shutdown);
	process.stdout.once("error", shutdown);
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
	process.once("uncaughtException", error => { report(error); shutdown(); });
	process.once("unhandledRejection", error => { report(error); shutdown(); });
}

main().catch(error => {
	process.stderr.write(`pi-delegate-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
