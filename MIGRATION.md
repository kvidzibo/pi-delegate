# Migration notes

After any update, finish outstanding jobs, then `/reload`. `~/.pi/agent/delegate.json` and existing archives stay valid throughout; no data conversion or deletion is required.

## 0.33.0: background by default

New delegates default to `background: true` and return a job ID immediately. Set `background: false` to wait on spawn. Job-ID collection and controls are unchanged.

## 0.30.0: no per-call model

The `delegate` tool no longer accepts `model`, including for reviews. Configure each role's model with `/pi-delegate roles` or `~/.pi/agent/delegate.json` and remove `model` from tool calls.

## 0.28.0: native Pi extension only

The MCP server, executable, tools/resources and private operator settings API are removed. All role settings are now editable in `/pi-delegate roles`.

1. Finish and collect jobs through the old MCP service before stopping it. The extension cannot adopt running MCP jobs or their job IDs.
2. Remove the old service/client configuration, including any gateway-managed registration. Do not load both interfaces.
3. Install the package as described in the [README](README.md#install), then `/reload`. Avoid duplicate explicit extension entries.

## Removed features and legacy settings

- Role `offline` and `context` keys and legacy `snapshots` configuration are ignored and preserved on saves. Stored snapshots are not deleted; remove them manually if no longer needed.
- `docs` is an ordinary custom role: old `agents.docs` entries need a `prompt` or must be removed.
- Automatic diff/full-file context preparation and `base`/`head` job arguments are unsupported; supply context in the task.
- Execution/headroom guard APIs are retired; stale `execution` options are refused. Existing archive metadata remains readable.
- The savings-profile generation runner and prompt-evaluation tooling are no longer included; existing profiles still work.
