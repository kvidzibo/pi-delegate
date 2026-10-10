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

Role models, tools, reasoning and queue/runtime limits use the existing [delegate configuration](../delegate/README.md#configuration): shipped defaults plus `~/.pi/agent/delegate.json`. There is no built-in MCP model picker or model-callable configuration-writing tool. An opt-in [operator settings extension](#operator-settings-extension) lets a trusted UI change role models and reasoning without restarting. Manual configuration edits still require a restart; this cancels outstanding jobs.

Options:

| Option | Purpose |
|---|---|
| `--workspace DIRECTORY` | Required; fixed workspace root. Per-job `cwd` may select an existing directory below it. |
| `--pi-command EXECUTABLE` | Worker executable, default `pi`. One executable, not a shell command or script with arguments. |
| `--agent-dir DIRECTORY` | Pi data and shared local capacity; default `PI_CODING_AGENT_DIR` or `~/.pi/agent`. Also passed to workers. |
| `--config FILE` | Explicit delegate overlay; must exist. Default: `<agent-dir>/delegate.json`, if present. |
| `--allow-model-override` | Permit optional per-job `provider/model` overrides. Disabled by default; role tools/reasoning/offline policy remain unchanged. |
| `--pi-package-dir DIRECTORY` | Explicit Pi SDK installation for the settings catalogue when `--pi-command` is a wrapper/binary. Must be the `@earendil-works/pi-coding-agent` package directory. |

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

`requestId` is a caller-generated, nonblank string of at most 128 characters. Retry the same key with the same normalized task/kind/workspace and explicit model parameter **within this server process** to retrieve the existing job without launching another. Conflicting reuse fails. Changing role defaults does not break retries of already accepted requests. A start cancelled before acceptance launches nothing; cancellation after acceptance can suppress the receipt but leaves the job and retry identity intact. This is not restart-safe deduplication: after a lost connection, do not replay uncertain implementation tasks automatically.

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

## Operator settings extension

This is a **custom, versioned MCP extension**, not a standard settings API or a set of tools. It is disabled by default. A supporting gateway/UI must implement the contract below; merely connecting this server does not create `/pi-delegate` or a settings panel. No gateway or live client configuration is modified by this package.

### Enable and discover

The trusted launcher generates a random base64url token (32–256 characters; use at least 32 random bytes), retains it privately and passes it as `PI_DELEGATE_SETTINGS_TOKEN`. For example, a launcher can generate it with `randomBytes(32).toString("base64url")`. Never put it in prompts, tool arguments, checked-in configuration or model-readable settings. The server removes this variable before loading its catalogue or launching workers.

When enabled, discovery advertises `com.kvidzibo/settings` in `capabilities.extensions`, and in `capabilities.experimental` for legacy clients using `initialize` (including protocol `2025-11-25`):

```json
{
  "version": 1,
  "getMethod": "kvidzibo/settings/get",
  "updateMethod": "kvidzibo/settings/update",
  "authorization": "token",
  "audience": "operator"
}
```

Neither method appears in `tools/list`, and `tools/call` cannot invoke them. **The gateway must not publish a generic custom-RPC forwarding tool or expose the token to the agent.** Its trusted UI route sends these JSON-RPC requests directly to its existing child connection. Missing/wrong authorization is rejected before reading the catalogue.

### Read settings

Call `kvidzibo/settings/get` with `{ "token": "<private operator token>" }`. The result contains:

| Field | Meaning |
|---|---|
| `schemaVersion`, `title` | Contract version (1) and display name |
| `revision` | Opaque configuration revision for optimistic updates |
| `schema` | JSON Schema 2020-12 with titles, descriptions, defaults, model choices and read-only hints |
| `values.agents` | Active per-role `model`, `thinking` and read-only `offline` values |
| `sources.agents` | `user` or `default` for each returned value |
| `models` | Sanitized model IDs, labels, availability, supported `thinking` levels and `local` classification |
| `writable`, `conflict`, `warning` | Persistence/catalogue availability and external-edit conflicts |
| `applyTo` | `future-jobs`: accepted running/queued jobs retain their policy |

The catalogue belongs to the **server’s configured Pi installation and agent directory**, not the parent Pi session. It loads configured chat models and credential availability without model calls or network catalogue discovery. It does not load extensions or return credentials, endpoints, prompts, tools, storage paths or snapshot configuration. Model availability is configuration presence, not proof that credentials or endpoints work. Unsupported installations, wrappers without a matching `--pi-package-dir`, or catalogue errors produce a generic warning and disable editing; delegation remains usable.

The UI uses JSON Schema for basic controls, `models[].available` to disable unavailable selections and `models[].thinking` for dependent reasoning choices. Current unavailable models remain visible; no fallback or reasoning clamp is chosen automatically.

### Save settings

After showing the exact changes and receiving human confirmation, call `kvidzibo/settings/update`:

```json
{
  "token": "<private operator token>",
  "revision": "<revision returned by get>",
  "patch": {
    "agents": {
      "review": { "model": "provider/model", "thinking": "high" }
    }
  },
  "confirmOfflineChange": true
}
```

Only nonempty role `model`/`thinking` patches are accepted. The resulting model must be available and its reasoning supported. A model change that makes existing reasoning invalid must include a supported reasoning value. Selecting a hosted model turns `offline` off: show this derived change in the confirmation and explicitly send `confirmOfflineChange: true` when needed. Selecting a local model preserves the previous `offline` value.

The server validates all roles before atomically replacing the configured user overlay, preserving unrelated keys and existing symlinks/modes. It applies the new role policy to future launches immediately; retries and already accepted jobs remain unchanged. The update returns the same description shape as `get`, with the new revision. An uncertain update can be resolved by reading current settings; do not blindly repeat a stale patch.

Application errors: `-33001` unauthorized; `-33002` revision/disk conflict; `-33003` persistence or catalogue unavailable. Invalid parameters use `-32602`. Unknown fields, snapshots and direct `offline`/tool/permission writes are rejected. With `PI_DELEGATE_SKIP_USER_CONFIG=1` and no explicit `--config`, settings are read-only.

External file edits are detected but not silently adopted. A conflict requires collecting/cancelling work before restarting. Concurrent settings writers sharing the canonical overlay use a short-lived `.settings-lock` directory; a leftover lock after a crash fails closed. Remove it only after confirming no settings writer is active. Legacy manual/extension writers do not participate in that lock: avoid simultaneous writes.

The token authenticates the trusted operator route; it does not prove a human clicked confirmation. The host must enforce that step. This is **not a sandbox**: an unsandboxed child with OS access may still read files or inspect processes. Do not treat hiding RPC methods as protection from arbitrary shell access.

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
- No tool can change role configuration, enable snapshots or authorize capture. The optional operator-only RPC extension changes only role models/reasoning; snapshots remain forcibly disabled.
- Archives retain tasks, code, thinking and tool output indefinitely. Keep them private; no automatic upload, redaction or expiry.

## Validation

```bash
npm ci
npm run test:unit
npm run test:mcp
xvfb-run -a npm test  # also exercises the retained Pi extension; requires Pi and Xvfb
```

MCP integration tests use real stdio and owned offline worker fixtures, never model calls. For manual protocol inspection, run the MCP Inspector against the built server with an explicit workspace. Normal server stdout contains only protocol messages; diagnostics go to stderr.
