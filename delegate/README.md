# Delegate

The extension provides the `delegate` tool, model picker, job controls and usage reports. Start with the [project README](../README.md) for installation, roles and safety limits.

## Configuration

Prefer **`/delegate`** to select role models. It saves to `~/.pi/agent/delegate.json` and affects new jobs in the current session; running and queued jobs keep their settings. Other sessions need `/reload`.

For manual configuration, override [shipped defaults](config.json) in that user file, not in the installed package. Replace `provider/model` with an available Pi model ID:

```json
{
  "agents": {
    "recon": { "model": "provider/model", "offline": false }
  }
}
```

Each role accepts `model`, `tools`, `thinking` and `offline`. Omitted fields inherit defaults; tool arrays replace rather than extend them. Invalid configuration prevents loading. Manual edits require `/reload` or restart; **reload stops outstanding children**.

Set `offline: false` when manually switching to a hosted model; the picker does this automatically. A per-call `model` override keeps the role's tools, thinking and offline setting. Providers available only through parent extensions must be configured separately for children, which disable extension discovery.

Defaults are **8 running jobs, 1 local worker and 16 queued jobs per parent**. Hosted work can proceed while local work waits. Limits are configurable in the user file; local providers are `local-qwen*`, `llama.cpp` and `ollama`.

## Job lifecycle

Example tool arguments:

```json
{
  "kind": "recon",
  "task": "Find test files and test commands; report paths and do not edit.",
  "background": true
}
```

An optional `cwd` selects an existing working directory; relative paths resolve against the parent's cwd. Use the returned job ID for controls:

| Action | Arguments |
|---|---|
| Wait / collect | `{ "jobId": "d0001" }` |
| Peek | `{ "jobId": "d0001", "timeoutMs": 0 }` |
| Request wrap-up | `{ "jobId": "d0001", "wrap": true }` |
| Cancel | `{ "jobId": "d0001", "cancel": true }` |

`timeoutMs` is a wait budget, **not a kill timeout**. Foreground expiry leaves the child running in the background. Each collection starts a fresh quiet interval (60 seconds by default); child events restart it, but an explicit wait budget may return sooner. `quietForMs` still reports actual child inactivity, not time spent waiting. Collect again for the final result; completion notices are previews only.

**Esc interrupting the parent cancels all its running and queued delegates**, including background jobs and jobs from earlier turns. Pending completion notices are suppressed so they cannot restart the parent after cancellation. Normal parent completion and wait timeouts leave background jobs running; dismissing a menu with Esc is not a parent interrupt.

Wrap is advisory: it asks the child to finish without interrupting its current turn/tools; wrapping a queued job cancels it. For a suspected stall, wrap, wait again, then inspect a fresh peek before cancelling. Silence alone does not prove a stall. Cancel stops the child. The separate `hardTimeoutMs` configuration limits runtime; `0` disables it. Shutdown stops outstanding jobs.

## Local delegation switch

`/delegate-local` opens an On/Off picker; direct commands are `/delegate-local on|off|status`.

Off rejects new local jobs, holds queued ones and lets running jobs finish. Wait for **OFF · idle** before benchmarking. The switch persists across participating sessions using the same agent directory. It does not pause hosted work, servers or unrelated GPU clients, and is not a cross-session concurrency limit.

An **unverified** reservation is not proof of idleness. Confirm its work has stopped before removing stale reservation files under `~/.pi/agent/delegate-local/active/`.

## Results and history

Collected-result rows show the role, model and job ID. Failed/cancelled rows also show the task and last recorded tool; cancellation is labelled explicitly. **Ctrl+O** expands full output, recent tools and archive paths, including raw cancellation diagnostics.

Returned answers are capped; inspect the native session for more recorded history. Capability receipts describe configured tools, not verified availability or sandboxing. Outcome receipts describe execution, not task correctness.

`/delegate-stats [session|today|all|rebuild]` reports recorded usage without model calls. `saved ~$X` is a [calibrated API-equivalent estimate](../bench/README.md), not measured net savings.

Archives default to `~/.pi/agent/delegate/`; `PI_DELEGATE_ARCHIVE_DIR` accepts an absolute replacement path. Retention is indefinite. Keep archives private: they can contain sensitive prompts and tool output. Rebuild reconstructs usage summaries, not running jobs.

Diagnostics default to `~/.pi/agent/delegate.log`. `PI_DELEGATE_LOG` changes the path; `0` disables diagnostics, **not archives**.

## Development

Parent guidance lives in [index.ts](index.ts), child instructions in [prompts/](prompts/), and model assignments in configuration. Keep role/model policy out of `AGENTS.md`.

Run from the repository root:

```bash
node --test --experimental-strip-types delegate/tests/*.test.ts
xvfb-run -a npm test
```

The [implementation contract](SPEC.md) covers changes to runtime behavior. Guarded execution and shared-capacity APIs are opt-in library features, not delegate configuration defaults; see [child-runtime](../child-runtime/README.md).
