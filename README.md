# pi-delegate

[npm](https://www.npmjs.com/package/@kvidzibo/pi-delegate) · [Pi package directory](https://pi.dev/packages/@kvidzibo/pi-delegate)

Delegate focused coding tasks to separate [Pi](https://github.com/earendil-works/pi) workers through the native Pi extension. Supports local and hosted models, background jobs, and one shared local worker across participating processes.

One child per call; no nested delegation. Define custom roles or override prompts, models and tool access in `~/.pi/agent/delegate.json`. Set `agents.<role>.enabled: false` to disable a role. The starter roles are:

| Kind | Purpose |
|---|---|
| `recon` | Find files, map code, gather facts |
| `implement` | Make bounded edits and run tests |
| `review` | Read-only review with shell access |
| `oracle` | Last-resort analysis without editing |

## Migration to 0.28.0

This breaking release is extension-only: the MCP server, executable and operator API are removed. Finish and collect existing MCP jobs before removing the old service/client or gateway configuration. Install/load the native package below, then run `/reload`. Do not load both interfaces. Running MCP jobs cannot be adopted; keep `~/.pi/agent/delegate.json` and the existing archives unchanged. See [migration details](MIGRATION.md).

## Pi extension setup

Requires Node.js 22.19+, `pi` on PATH and configured model access. Choose one installation source:

```bash
pi install npm:@kvidzibo/pi-delegate
# Or a local checkout:
pi install /absolute/path/to/pi-delegate
```

Pi supplies the peer dependencies; no manual `npm install` is needed. Do not also add `delegate` to Pi's `extensions` setting. Published releases may lag behind this checkout.

Run **`/pi-delegate`** for the menu, or **`/pi-delegate roles`** for the full native Roles editor: enablement, model, supported reasoning, tools (including all/none), extension discovery, multiline prompt and named-role creation. Short choices cycle inline. **Save role** persists changes; Esc discards the draft and goes back. New roles require an explicit available model and nonblank prompt, defaulting to no tools, no extensions and reasoning off.

Model choices match `/model` (scoped models when set, otherwise all available models). **`/pi-delegate models`** retains the model-first picker followed by reasoning. Both editors save to `~/.pi/agent/delegate.json`, preserving unrelated and legacy keys; disk conflicts or uncertain catalogues refuse saves. Changes affect future jobs only; queued and running jobs keep their accepted settings. Unavailable models are never automatically replaced.

Use **`/pi-delegate jobs`** for active/queued jobs and full tasks, or **`/pi-delegate stats [session|today|all|rebuild]`** for usage.

Jobs and stats use framed, opaque panels so live transcript output stays visually separate. They support ↑/↓, Page Up/Down and Home/End; Esc returns. In the interactive stats panel, **1/2/3** switches Session/Today/All. Jobs refresh while open without changing their state.

Manual configuration edits, package updates and other open sessions need `/reload` or a restart. **Reload stops outstanding children.**

## Use

Ask Pi:

```text
Delegate a background recon to find this repo's test files and test commands.
Do not edit files. Collect the result when it finishes.
```

The parent can wait, peek, request wrap-up or cancel using the returned job ID. `timeoutMs` limits waiting, not runtime. **Esc interrupting the parent also cancels its running and queued delegates, including background jobs.** Active jobs appear above the editor; finished results appear in the transcript. Compact cards show job ID, role, status, model and thinking level; **Ctrl+O** reveals the full model and result. Clipped previews show the hidden line count. Finished/unverified and cancelled runs use neutral styling; failures remain red.

Completed results expose `durationMs` and readable `Duration` (for example, `4m 36s`). Timing matches the run's archived `metadata.json`, excludes queue wait, and is zero if cancelled before starting. Use archived timing when a result is unavailable; use “Unknown” only when timing cannot be recovered.

Check receipts freeze elapsed runtime (or queue time) and the interval since the previous returned check; the first check omits the interval.

See [configuration and job controls](delegate/README.md) for manual settings and tool arguments.

## Important constraints

- Shared local capacity requires Linux and `/usr/bin/flock`. All local providers share one slot per agent directory; hosted jobs bypass it. Reload older sessions to participate.
- **No sandbox.** Children have your system permissions; all shipped roles include shell access. Read-only roles rely on prompt policy, not write protection. Delegation leaves Pi's `PI_OFFLINE` environment setting unchanged; legacy role `offline` keys are ignored. Without `PI_OFFLINE=1`, startup may perform automatic networking. It is not network isolation.
- Children do not inherit the parent conversation or project instructions. Extensions are disabled unless the role sets `extensions: true`; skills, prompt templates and context files stay disabled. Manually configured new roles without `tools` get all Pi tools; Roles-menu creations default to no tools and no extension discovery. Provide a self-contained task and avoid overlapping edits to shared files.
- A review covers the full requested diff unless the task asks for a small review. No automatic diff or extra task context is prepared: supply a readable diff or file paths and review scope in the task.
- Worker completion is not proof of task correctness. The parent must inspect and validate results.
- Archives under `~/.pi/agent/delegate/` are retained indefinitely and can contain sensitive prompts, code, thinking and tool output.

## Development

Run from the repository root:

```bash
npm ci --omit=peer
npm run test:unit       # no Pi required; also runs in CI
npm run test:load       # installed Pi CLI, isolated temporary configuration
npm test               # both suites
```

Tests make no model calls. Delegation guidance ships with the extension; do not duplicate role/model policy in `AGENTS.md`.

See [child-runtime](child-runtime/README.md) and the [implementation contract](delegate/SPEC.md) when working on those areas.
