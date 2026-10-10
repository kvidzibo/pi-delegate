# pi-delegate

[npm](https://www.npmjs.com/package/@kvidzibo/pi-delegate) · [Pi package directory](https://pi.dev/packages/@kvidzibo/pi-delegate)

Delegate focused coding tasks to separate [Pi](https://github.com/earendil-works/pi) workers through a **standalone MCP server** or the existing Pi extension. Supports local and hosted models, background jobs, and one shared local worker across participating processes.

One child per call; no nested delegation.

| Kind | Purpose |
|---|---|
| `recon` | Find files, map code, gather facts |
| `implement` | Make bounded edits and run tests |
| `review` | Review without editing |
| `oracle` | Last-resort analysis without editing |

## MCP setup

Requires Node.js 22.19+, `pi` on PATH and configured model access. No parent Pi extension or interactive Pi session is needed.

```bash
npm install -g @kvidzibo/pi-delegate
pi-delegate-mcp --help
```

Configure your MCP client to launch `pi-delegate-mcp --workspace /absolute/path/to/project`. The server exposes `delegate_start`, `delegate_status` and `delegate_control`; starts return immediately, observation waits are capped at 20 seconds, and launch request IDs prevent duplicate retries within the connection. Snapshot capture is forcibly disabled. Closing the connection cancels its outstanding jobs; restart adoption is not supported.

MCP is available in 0.16.0+; published releases may lag behind this checkout. See [MCP configuration, client examples, lifecycle and validation](mcp/README.md), including running an unreleased checkout. The server publishes a subscribable `delegate://jobs` resource for live panels; rendering belongs to the client. It does not modify client settings. The optional [gateway Pi adapter](https://github.com/kvidzibo/mcp-session-gateway#live-delegate-panel) displays it above the editor without adding refreshes to model context. See [the job resource contract](mcp/README.md#live-job-resource). An opt-in [operator settings API](mcp/README.md#operator-settings-extension) exposes model/reasoning settings to a trusted UI without adding agent tools; UI/gateway integration is separate.

## Pi extension setup

Requires `pi` on PATH and configured model access. Choose one installation source:

```bash
pi install npm:@kvidzibo/pi-delegate
# Or a local checkout:
pi install /absolute/path/to/pi-delegate
```

Pi supplies the peer dependencies; no manual `npm install` is needed. Do not also add `delegate` to Pi's `extensions` setting. Published releases may lag behind this checkout.

Run **`/pi-delegate`** for the options menu. Esc from Models returns to this menu; Esc at the main menu closes it. Use **`/pi-delegate jobs`** to browse all active/queued jobs and full tasks, **`/pi-delegate stats [session|today|all|rebuild]`** for usage, or **`/pi-delegate models`** to choose each role's default model and reasoning level. Model choices match `/model`: scoped models when a scope is set, otherwise every available model. Select a role to open its model picker immediately; selecting a model continues to reasoning. Enter on the current model skips a model save. Esc returns to the role list. Declining a save stays on that picker. Save feedback stays in the dialog. Shipped model assignments are active defaults; unavailable models are not automatically replaced. Selections are saved in `~/.pi/agent/delegate.json` and apply to new jobs in the current session.

Jobs and stats use framed, opaque panels so live transcript output stays visually separate. They support ↑/↓, Page Up/Down and Home/End; Esc returns. In the interactive stats panel, **1/2/3** switches Session/Today/All. Jobs refresh while open without changing their state.

Use **`/pi-delegate snapshots`** to configure first-use repository audits, manual risk-approved enablement, explicit capture settings and storage for eval snapshots. The global default offers audits for repositories without an explicit setting; it never captures or enables capture automatically. No model call or repository audit starts before you approve the audit prompt. Repository count/size and storage print once at session startup—not in a sticky widget. Snapshots preserve source and Git history and may contain secrets; see [capture configuration and constraints](delegate/README.md#eval-repository-snapshots).

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
- **No sandbox.** Children have your system permissions; shipped roles include shell access. Read-only roles are prompt policy, not write protection. Delegation leaves Pi's `PI_OFFLINE` environment setting unchanged; legacy role `offline` keys are ignored. Without `PI_OFFLINE=1`, startup may perform automatic networking. It is not network isolation.
- Children do not inherit the parent conversation or project instructions. Provide a self-contained task and avoid overlapping edits to shared files.
- A review covers the full requested diff unless the task asks for a small review.
- Worker completion is not proof of task correctness. The parent must inspect and validate results.
- Archives under `~/.pi/agent/delegate/` are retained indefinitely and can contain sensitive prompts, code, thinking and tool output.

## Development

Run from the repository root:

```bash
npm ci
npm run test:unit       # no Pi required; also runs in CI
npm run test:mcp        # builds and exercises stdio without model calls
xvfb-run -a npm test    # includes offline CLI/UI checks; needs Pi and Xvfb
```

Tests make no model calls. Delegation guidance ships with the extension; do not duplicate role/model policy in `AGENTS.md`.

See [child-runtime](child-runtime/README.md) and the [implementation contract](delegate/SPEC.md) when working on those areas.
