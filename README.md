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

## Migration to 0.33.0

New delegates default to `background: true`, returning a job ID immediately. Set `background: false` to wait on spawn. Job-ID collection and controls are unchanged. After updating, finish outstanding jobs before `/reload`.

## Migration to 0.30.0

The `delegate` tool no longer accepts `model`, including for reviews. Configure each role's model with `/pi-delegate roles` or `~/.pi/agent/delegate.json`; remove `model` from tool calls, then `/reload` after outstanding jobs finish. Accepted jobs and archives are unchanged.

## Migration to 0.28.0

This breaking release is extension-only: the MCP server, executable and operator API are removed. Finish and collect existing MCP jobs before removing the old service/client or gateway configuration. Install/load the native package below, then run `/reload`. Do not load both interfaces. Running MCP jobs cannot be adopted; keep `~/.pi/agent/delegate.json` and the existing archives unchanged. See [migration details](MIGRATION.md).

## Pi extension setup

Requires Node.js 22.19+, Pi 1.5.0+ on PATH and configured model access. Choose one installation source:

```bash
pi install npm:@kvidzibo/pi-delegate
# Or a local checkout:
(cd /absolute/path/to/pi-delegate && npm ci --omit=peer)
pi install /absolute/path/to/pi-delegate
```

Pi supplies peer dependencies and installs runtime dependencies for npm/git sources. Local checkouts need the `npm ci` step above. Do not also add `delegate` to Pi's `extensions` setting. Published releases may lag behind this checkout.

Run **`/pi-delegate`** for the menu, or **`/pi-delegate roles`** for the full native Roles editor: enablement, model, supported reasoning, tools (including all/none), extension discovery, multiline prompt, optional response template, raw JSON Schema editor, repair attempts, save-to-file toggle and named-role creation. Short choices cycle inline. **Save role** persists changes; Esc discards the draft and goes back. New roles require an explicit available model and nonblank prompt, defaulting to no tools, no extensions and reasoning off.

Model choices match `/model` (scoped models when set, otherwise all available models). **`/pi-delegate models`** retains the model-first picker followed by reasoning. Both editors save to `~/.pi/agent/delegate.json`, preserving unrelated and legacy keys; disk conflicts or uncertain catalogues refuse saves. Changes affect future jobs only; queued and running jobs keep their accepted settings. Unavailable models are never automatically replaced.

Use **`/pi-delegate jobs`** for active/queued jobs and full tasks, or **`/pi-delegate stats [session|today|all|rebuild]`** for usage.

Jobs and stats use framed, opaque panels so live transcript output stays visually separate. They support ↑/↓, Page Up/Down and Home/End; Esc returns. In the interactive stats panel, **1/2/3** switches Session/Today/All. Jobs refresh while open without changing their state.

Manual configuration edits, package updates and other open sessions need `/reload` or a restart. **Reload stops outstanding children.**

## Automatic checkpoints

`/pi-delegate checkpoints` enables periodic, text-only progress advice during main-agent work. **Off by default.** Choose an existing advisor role (default name `goldfish`) and an interval of 10 or 20 action rounds. Configure the role’s model/prompt in **Roles**; it must have no tools or extensions. No advisor role is created automatically.

Checks pause the next main-agent step and send bounded conversation/tool excerpts to the advisor’s provider. Excerpts may contain sensitive data. Feedback is advisory, not a code review or approval gate. See [checkpoint behaviour and limits](delegate/README.md#automatic-checkpoints).

## Use

Ask Pi:

```text
Delegate a background recon to find this repo's test files and test commands.
Do not edit files. Collect the result when it finishes.
```

A role’s **Response template** guides its final response (including Markdown tables); blank leaves behavior unchanged. For enforced JSON output, open **Response schema**, paste a draft-07 JSON Schema and **Save role**. Invalid schemas are rejected; empty disables validation. Ajv validates locally and asks the same model to repair invalid output, with tools disabled, up to **Repair attempts** (0–2; default 2). The schema takes precedence over the template. Exhausted repairs fail explicitly; validation checks structure, not factual correctness.

**Save to file** independently writes the response to a private temporary file (`response.json` for validated JSON; otherwise `response.md`) and returns its path. Saved responses retain the output limit; copy files elsewhere for long-term retention. [Schema configuration and limits](delegate/README.md#json-schema-validation).

The parent can wait, peek, request wrap-up or cancel using the returned job ID. `timeoutMs` limits waiting, not runtime. **Esc interrupting the parent also cancels its running and queued delegates, including background jobs.** Active jobs appear above the editor; finished results appear in the transcript. Compact cards show job ID, role, status, model and thinking level, plus live elapsed/queue time and frozen duration when finished; **Ctrl+O** reveals the full model and result. Clipped previews show the hidden line count. Finished runs say **needs validation** (the parent must check the result); finished and cancelled runs use neutral styling, while failures remain red. Task previews wrap to two lines with an ellipsis when shortened. Saved-response paths appear only when expanded.

Completed results expose `durationMs` and readable `Duration` (for example, `4m 36s`). Timing matches the run's archived `metadata.json`, excludes queue wait, and is zero if cancelled before starting. Use archived timing when a result is unavailable; use “Unknown” only when timing cannot be recovered.

Check receipts freeze elapsed runtime (or queue time) and the interval since the previous returned check; the first check omits the interval.

See [configuration and job controls](delegate/README.md) for manual settings and tool arguments.

For a dated benchmark reference with intelligence scores and cost per task, see the [model comparison](MODEL-COMPARISON.md). These are not Pi-delegate performance measurements.

## Important constraints

- Shared local capacity requires Linux and `/usr/bin/flock`. All local providers share one slot per agent directory; hosted jobs bypass it. Reload older sessions to participate.
- **No sandbox.** Children have your system permissions; all shipped roles include shell access. Read-only roles rely on prompt policy, not write protection. Delegation leaves Pi's `PI_OFFLINE` environment setting unchanged; legacy role `offline` keys are ignored. Without `PI_OFFLINE=1`, startup may perform automatic networking. It is not network isolation.
- Children do not inherit the parent conversation or project instructions. Extensions are disabled unless the role sets `extensions: true`; skills, prompt templates and context files stay disabled. Manually configured new roles without `tools` get all Pi tools; Roles-menu creations default to no tools and no extension discovery. Provide a self-contained task and avoid overlapping edits to shared files.
- A review covers the full requested diff unless the task asks for a small review. No automatic diff or extra task context is prepared: supply a readable diff or file paths and review scope in the task. The shipped reviewer may run explicitly authorized isolated Pi integration tests with temporary files, but must leave project files unchanged and never delegate work or make model requests.
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
