# pi-delegate

Run focused coding tasks in separate [Pi](https://github.com/earendil-works/pi) agents while the parent keeps working. Choose local or hosted models, with separate concurrency limits for local workers.

One tool, four kinds of child. One child per call; no nesting.

| Kind | Purpose |
|---|---|
| `recon` | Find files, map code, gather facts |
| `implement` | Make bounded edits and run tests |
| `review` | Review code without editing |
| `oracle` | Last-resort analysis without editing |

> **No sandbox.** Children have your system permissions, including `bash` access. “Read-only” is prompt policy, not enforcement. `offline` skips Pi startup networking; it does not block tool network access. Install only trusted code.

## Install

Requires `pi` on PATH and working model access. Choose one:

```bash
pi install npm:@kvidzibo/pi-delegate
# Or repository source:
pi install git:github.com/kvidzibo/pi-delegate
# Or a local checkout:
pi install /absolute/path/to/pi-delegate
```

Pi supplies the peer dependencies; no manual `npm install` is needed. Do not also add `delegate` to `settings.json` → `extensions`.

This README describes repository source; published releases may lag behind it.

## Config

The [shipped models](delegate/config.json) are examples and become active defaults. Set models available in your Pi setup in `~/.pi/agent/delegate.json`, for example:

```json
{
  "agents": {
    "recon": { "model": "ollama/qwen3:8b", "offline": true },
    "implement": { "model": "openai-codex/gpt-5.6-luna", "offline": false },
    "review": { "model": "anthropic/claude-sonnet-4-6", "offline": false },
    "oracle": { "model": "openai-codex/gpt-5.6-sol", "offline": false }
  }
}
```

Omitted settings inherit shipped values, **including `offline`**. Set it to `false` when switching a local agent to a hosted model. Invalid config prevents loading. Edit the user overlay, not an installed package clone.

Run `/reload` or restart Pi after changes. **Reload stops outstanding children.** See the [configuration reference](delegate/README.md#configuration) for tools, thinking levels and limits.

## Use

Ask Pi:

```text
Delegate a background recon to find this repo's test files and test commands.
Do not edit files. Collect the result when it finishes.
```

Equivalent `delegate` tool arguments:

```json
{
  "kind": "recon",
  "task": "Find test files and test commands. Report paths and commands; do not edit files.",
  "background": true
}
```

Use the returned job ID in another `delegate` call (`d0001` below is illustrative):

| Action | Arguments |
|---|---|
| Wait / collect | `{ "jobId": "d0001" }` |
| Peek | `{ "jobId": "d0001", "timeoutMs": 0 }` |
| Request wrap-up | `{ "jobId": "d0001", "wrap": true }` |
| Cancel | `{ "jobId": "d0001", "cancel": true }` |

`timeoutMs` limits waiting, **not runtime**. A foreground timeout leaves the child running in the background. Collect again to wait longer; wrap requests a finish without interrupting the current tool, while cancel kills the child. Avoid overlapping parent/child edits.

Defaults: **8 running jobs, 1 local worker, 16 queued jobs**. Hosted work can run while local work waits; a full queue rejects new work. See [job lifecycle](delegate/README.md#job-lifecycle) for overrides and notifications.

### Pause local delegation for benchmarks

Run `/delegate-local` to open an **On / Off picker** showing the current shared setting and active local jobs. Esc leaves it unchanged. Direct commands are `/delegate-local on`, `/delegate-local off`, and `/delegate-local status`.

**Off** rejects new local launches and holds queued local jobs. Already-running jobs finish; the status changes from **OFF · draining N jobs** to **OFF · idle**. Wait for idle before benchmarking. Hosted delegation stays available, with no automatic cloud fallback.

The switch persists across restarts and applies without reload to participating Pi sessions using the same agent directory. It does not stop servers, control other GPU clients, or change concurrency limits. Load this version in each session once before relying on the switch. See [scope and recovery](delegate/README.md#local-delegation-switch).

## Results and history

- Active cards stay above the editor; finished results appear in the transcript. **Ctrl+O** expands details and shows the archived session path.
- Wrap-up replies are labelled separately from the preceding report, so an acknowledgement cannot replace it. Returned text remains capped; archives keep the full recorded history.
- `/delegate-stats [session|today|all|rebuild]` reports recorded child usage without model calls.
- **Archives are retained indefinitely** under `~/.pi/agent/delegate/`. They can contain sensitive prompts, code, thinking and tool output. See [storage and privacy](delegate/README.md#archives-and-privacy).
- `saved ~$X` is an optional **calibrated API-equivalent estimate**, not measured net savings. [Calibration and opt-in benchmarks](bench/README.md) explain setup and limits.

## Development

```bash
npm run test:unit       # no Pi required; used in CI
xvfb-run -a npm test    # unit + offline CLI/UI checks; needs Pi and Xvfb
```

Tests use mocked workers or isolated offline Pi processes, never model calls. See the [runtime reference](delegate/README.md), [child-process helpers](child-runtime/README.md) and [implementation contract](delegate/SPEC.md) for details.
