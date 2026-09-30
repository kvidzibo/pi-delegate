# pi-delegate

[npm](https://www.npmjs.com/package/@kvidzibo/pi-delegate) · [Pi package directory](https://pi.dev/packages/@kvidzibo/pi-delegate)

Run focused coding tasks in separate [Pi](https://github.com/earendil-works/pi) agents while the parent keeps working. Supports local and hosted models, background jobs, and one shared local worker across participating Pi sessions.

One child per call; no nested delegation.

| Kind | Purpose |
|---|---|
| `recon` | Find files, map code, gather facts |
| `implement` | Make bounded edits and run tests |
| `review` | Review without editing |
| `oracle` | Last-resort analysis without editing |

## Setup

Requires `pi` on PATH and configured model access. Choose one installation source:

```bash
pi install npm:@kvidzibo/pi-delegate
# Or a local checkout:
pi install /absolute/path/to/pi-delegate
```

Pi supplies the peer dependencies; no manual `npm install` is needed. Do not also add `delegate` to Pi's `extensions` setting. Published releases may lag behind this checkout.

Run **`/pi-delegate`** for the options menu. Esc from Models returns to this menu; Esc at the main menu closes it. Use **`/pi-delegate jobs`** to browse all active/queued jobs and full tasks, **`/pi-delegate stats [session|today|all|rebuild]`** for usage, or **`/pi-delegate models`** to choose each role's default model or reasoning level. Model choices match `/model`: scoped models when a scope is set, otherwise every available model. Select a role, then **Model** or **Reasoning**; changing reasoning leaves the model unchanged. Saving or cancelling a picker returns to that role's settings; save feedback stays in the dialog. Shipped model assignments are active defaults; unavailable models are not automatically replaced. Selections are saved in `~/.pi/agent/delegate.json` and apply to new jobs in the current session.

Jobs and stats use framed, opaque panels so live transcript output stays visually separate. They support ↑/↓, Page Up/Down and Home/End; Esc returns. In the interactive stats panel, **1/2/3** switches Session/Today/All. Jobs refresh while open without changing their state.

Manual configuration edits, package updates and other open sessions need `/reload` or a restart. **Reload stops outstanding children.**

## Use

Ask Pi:

```text
Delegate a background recon to find this repo's test files and test commands.
Do not edit files. Collect the result when it finishes.
```

The parent can wait, peek, request wrap-up or cancel using the returned job ID. `timeoutMs` limits waiting, not runtime. **Esc interrupting the parent also cancels its running and queued delegates, including background jobs.** Active jobs appear above the editor; finished results appear in the transcript. Compact cards lead with job ID, role and status; **Ctrl+O** reveals the full model, reasoning effort and result. Clipped previews show the hidden line count. Finished/unverified and cancelled runs use neutral styling; failures remain red.

Completed results expose `durationMs` and readable `Duration` (for example, `4m 36s`). Timing matches the run's archived `metadata.json`, excludes queue wait, and is zero if cancelled before starting. Use archived timing when a result is unavailable; use “Unknown” only when timing cannot be recovered.

Check receipts freeze elapsed runtime (or queue time) and the interval since the previous returned check; the first check omits the interval.

See [configuration and job controls](delegate/README.md) for manual settings and tool arguments.

## Important constraints

- Shared local capacity requires Linux and `/usr/bin/flock`. All local providers share one slot per agent directory; hosted jobs bypass it. Reload older sessions to participate.
- **No sandbox.** Children have your system permissions; shipped roles include shell access. Read-only roles are prompt policy, not write protection. `offline` skips startup networking; it does not block tool network access.
- Children do not inherit the parent conversation or project instructions. Provide a self-contained task and avoid overlapping edits to shared files.
- Worker completion is not proof of task correctness. The parent must inspect and validate results.
- Archives under `~/.pi/agent/delegate/` are retained indefinitely and can contain sensitive prompts, code, thinking and tool output.

## Development

Run from the repository root:

```bash
npm run test:unit       # no Pi required; also runs in CI
xvfb-run -a npm test    # includes offline CLI/UI checks; needs Pi and Xvfb
```

Tests make no model calls. Delegation guidance ships with the extension; do not duplicate role/model policy in `AGENTS.md`.

See [child-runtime](child-runtime/README.md), [opt-in benchmarks](bench/README.md) and the [implementation contract](delegate/SPEC.md) when working on those areas.
