# MCP server

`pi-delegate-mcp` runs Pi workers directly through a local stdio MCP connection. It does not start a parent Pi agent or require loading the delegate extension. The extension remains available separately; its panels are not part of the MCP server.

## Setup

Requires Node.js **22.19+** and an installed, configured `pi` executable. The worker protocol is validated against Pi **1.1.0**. Configure Pi model access separately; unavailable role models fail rather than fall back.

```bash
npm install -g @kvidzibo/pi-delegate
pi-delegate-mcp --help
```

Use a release containing the MCP executable (0.16.0+). For an unreleased checkout:

```bash
npm ci
npm run build
node /absolute/path/to/pi-delegate/dist/server.js --help
```

Add a server entry to your MCP client's configuration. For clients accepting `mcpServers`:

```json
{
  "mcpServers": {
    "delegate": {
      "command": "pi-delegate-mcp",
      "args": ["--workspace", "/absolute/path/to/project"]
    }
  }
}
```

For a checkout, set `command` to your Node executable and prepend `/absolute/path/to/pi-delegate/dist/server.js` to `args`. Use absolute executable paths if your client does not inherit your shell's PATH. This configuration is an example; the server never edits client or Pi settings.

### Configuration

Role models, tools, reasoning and queue/runtime limits use the existing [delegate configuration](../delegate/README.md#configuration): shipped defaults plus `~/.pi/agent/delegate.json`. There is no MCP model picker or configuration-writing tool. Restart the server after configuration changes; this cancels its outstanding jobs.

Options:

| Option | Purpose |
|---|---|
| `--workspace DIRECTORY` | Required; fixed workspace root. Per-job `cwd` may select an existing directory below it. |
| `--pi-command EXECUTABLE` | Worker executable, default `pi`. One executable, not a shell command or script with arguments. |
| `--agent-dir DIRECTORY` | Pi data and shared local capacity; default `PI_CODING_AGENT_DIR` or `~/.pi/agent`. Also passed to workers. |
| `--config FILE` | Explicit delegate overlay; must exist. Default: `<agent-dir>/delegate.json`, if present. |
| `--allow-model-override` | Permit optional per-job `provider/model` overrides. Disabled by default; role tools/reasoning/offline policy remain unchanged. |

Directory/config options resolve relative to the launch directory; use absolute paths in client configuration. Keep the same agent directory across participating clients to retain shared local-worker coordination. Changing it creates a separate capacity namespace and model/credential setup.

**Snapshot capture is always disabled in MCP**, even when inherited delegate configuration contains repository approvals or a global audit offer. Configuration is not modified. Snapshot auditing/approval remains an extension-only workflow.

## Tools

### `delegate_start`

Start one job and return immediately:

```json
{
  "kind": "recon",
  "task": "Find test commands in this workspace. Do not edit files; report paths and evidence.",
  "requestId": "find-tests-1"
}
```

Kinds: `recon`, `implement`, `review`, `oracle`. Provide a self-contained task, scope, acceptance checks and stop rules: workers do not inherit your conversation or project instructions. Tasks are capped at 20,000 characters (a smaller configured limit also applies).

`requestId` is a caller-generated, nonblank string of at most 128 characters. Retry the same key with the same effective task/kind/workspace/model **within this server process** to retrieve the existing job without launching another. Conflicting reuse fails. A start cancelled before acceptance launches nothing; cancellation after acceptance can suppress the receipt but leaves the job and retry identity intact. This is not restart-safe deduplication: after a lost connection, do not replay uncertain implementation tasks automatically.

Optional `cwd` resolves relative to the fixed workspace. Canonical paths must remain below that root; symlink escapes are refused. Optional `model` requires operator opt-in.

### `delegate_status`

Peek or wait for one job:

```json
{ "jobId": "<returned UUID>", "waitMs": 20000 }
```

`waitMs` defaults to zero and is capped at 20 seconds. A timeout or cancellation of this observation ends only the wait, **not the worker**. Collect again until `terminal: true`; use `delegate_control` to stop work.

Omit `jobId` to list this server's jobs, 20 per page. Pass the returned numeric `nextCursor` as `cursor` for the next page. Lists omit answers/stderr and shorten task previews; individual collection returns the bounded report. A cursor cannot accompany `jobId`; nonzero `waitMs` requires `jobId`.

### `delegate_control`

```json
{ "jobId": "<returned UUID>", "action": "cancel" }
```

Actions: `wrap` or `cancel`. Wrap is advisory and does not interrupt a running tool; **wrapping a queued job cancels it**. Cancel requests worker termination, but receipts remain nonterminal until cleanup releases capacity. Repeated controls do not restart work.

### Results

Tools return structured data and equivalent text so clients without structured-result rendering can still read reports. Individual receipts include job UUID, role/model, task/workspace, execution status, activity, timing, archive path, configured capabilities, outcome evidence and recording warnings when available.

`done` means the worker finished—not that its changes or tests are correct. The caller owns integration and validation. Answers are bounded by `maxOutputBytes` (default 64 KiB); inspect the private native archive for more recorded history. Completed `durationMs` excludes queue wait. Completed results remain collectible repeatedly during the connection.

## Lifecycle and limits

One server process owns its jobs. Closing the stdio connection or sending handled SIGINT/SIGTERM stops acceptance, cancels queued/running work and awaits cleanup. Archives remain; live jobs cannot be adopted after restart. Abrupt crashes/SIGKILL are not guaranteed graceful cleanup. Never infer another process is dead from unfinished archive metadata.

At most 256 jobs are accepted over one connection's lifetime, including completed jobs. Retry identities and collectible results are retained rather than silently evicted. Collect results and finish/cancel outstanding work before restarting. Running/queued limits remain configurable.

Local workers use the existing Linux `/usr/bin/flock` broker and share one slot across participating processes using the same agent directory. The private compiled worker lease helper verifies inherited capacity ownership; it is not the parent extension and is required for local execution. Hosted work does not require Linux/flock and can bypass local resource waits.

The baseline is pull-based: call status when needed, or use bounded waits. There is no universal completion-triggered model turn, native MCP task integration, dashboard or additional socket in this version. A future UI can poll summaries programmatically without model calls.

## Safety

- **No sandbox.** Workspace validation selects where work starts; shell commands can still access other paths, processes, credentials and network services available to the server's OS account.
- Workers inherit the server environment. Provide only credentials/services needed for the task. A client's approval of `delegate_start` does not approve or restrict each child tool call.
- Read-only roles are prompt policy; their shell access is not write protection. `offline` skips startup networking, not tool networking.
- Nesting is refused when the delegate-child marker is present. Workers disable extension discovery, context files, skills and prompt templates; local runs explicitly load only the private lease helper.
- No tool can change role configuration, enable snapshots or authorize capture.
- Archives retain tasks, code, thinking and tool output indefinitely. Keep them private; no automatic upload, redaction or expiry.

## Validation

```bash
npm ci
npm run test:unit
npm run test:mcp
xvfb-run -a npm test  # also exercises the retained Pi extension; requires Pi and Xvfb
```

MCP integration tests use real stdio and owned offline worker fixtures, never model calls. For manual protocol inspection, run the MCP Inspector against the built server with an explicit workspace. Normal server stdout contains only protocol messages; diagnostics go to stderr.
