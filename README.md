# pi-delegate

[npm](https://www.npmjs.com/package/@kvidzibo/pi-delegate) · [Pi package directory](https://pi.dev/packages/@kvidzibo/pi-delegate)

Delegate focused coding tasks to separate [Pi](https://github.com/earendil-works/pi) workers through the native Pi extension. Supports local and hosted models, background jobs, and one shared local worker across participating processes.

One child per call; no nested delegation. The starter roles are:

| Kind | Purpose |
|---|---|
| `recon` | Find files, map code, gather facts |
| `implement` | Implement scoped changes and run tests |
| `review` | Read-only review with shell access |
| `oracle` | Last-resort analysis without editing |

Add roles or change prompts, models and tool access in `/pi-delegate roles` or `~/.pi/agent/delegate.json`. Upgrading from an older version? See the [migration notes](MIGRATION.md).

## Install

Requires Node.js 22.19+, Pi 1.5.0+ on PATH and configured model access. Choose one installation source:

```bash
pi install npm:@kvidzibo/pi-delegate
# Or a local checkout:
(cd /absolute/path/to/pi-delegate && npm ci --omit=peer)
pi install /absolute/path/to/pi-delegate
```

Pi supplies peer dependencies and installs runtime dependencies for npm/git sources. Local checkouts need the `npm ci` step above. Do not also add `delegate` to Pi's `extensions` setting. Published releases may lag behind this checkout.

## Use

Ask Pi:

```text
Delegate a background recon to find this repo's test files and test commands.
Do not edit files. Collect the result when it finishes.
```

By default, spawns return a job ID immediately; the parent can wait, peek, request wrap-up or cancel with it. `timeoutMs` limits waiting, not runtime. **Esc interrupting the parent also cancels its running and queued delegates, including background jobs.** Active jobs appear above the editor and finished results in the transcript, marked **needs validation**; **Ctrl+O** expands them.

| Command | Purpose |
|---|---|
| `/pi-delegate` | Menu for everything below |
| `/pi-delegate roles` | Edit or add roles: enablement, model, reasoning, speed, tools, extensions, prompt and response settings |
| `/pi-delegate models` | Model-first picker, then reasoning |
| `/pi-delegate jobs` | Active and queued jobs with full tasks |
| `/pi-delegate stats [session\|today\|all\|rebuild]` | Recorded usage |
| `/pi-delegate summary` | Print a table of this session's delegate runs |
| `/pi-delegate checkpoints` | Opt-in periodic advice during main-agent work |

Settings save to `~/.pi/agent/delegate.json` and affect future jobs only. Manual edits, package updates and other open sessions need `/reload` or a restart. **Reload stops outstanding children.**

Optional features, all off by default and set per role unless noted:

- [Speed](delegate/README.md#speed): `fast`/`ultrafast` OpenAI Codex service tiers, using more plan allowance.
- [Response template and Save to file](delegate/README.md#response-templates-and-files): guide the final response, or return a temporary file path instead of the body.
- [Response schema](delegate/README.md#json-schema-validation): enforce JSON output with local validation and bounded repairs. It checks structure, not correctness. The `implement` role ships a report schema that is off until you set `responseSchemaEnabled: true`.
- [Completion hook](delegate/README.md#completion-hooks): run a trusted executable with the terminal result, with your permissions. The [review-comment example](examples/review-comment/README.md) drafts review comments without publishing.
- [Automatic checkpoints](delegate/README.md#automatic-checkpoints): a global setting, not per role. A tool-free advisor role comments on all main-agent work every 10 or 20 action rounds. **It sends conversation and tool excerpts, which may contain sensitive data, to the advisor's provider.** Feedback is advisory, not a review or approval gate.

See [configuration and job controls](delegate/README.md) for all settings and tool arguments, and the [model comparison](MODEL-COMPARISON.md) for a dated benchmark reference when choosing models.

## Important constraints

- Shared local capacity requires Linux and `/usr/bin/flock`. All local providers share one slot per agent directory; hosted jobs bypass it. Reload older sessions to participate.
- **No sandbox.** Children have your system permissions; all shipped roles include shell access. Read-only roles rely on prompt policy, not write protection.
- **No network isolation.** Delegation leaves Pi's `PI_OFFLINE` setting unchanged; without `PI_OFFLINE=1`, startup may perform automatic networking.
- Children do not inherit the parent conversation or project instructions. Extensions are disabled unless the role sets `extensions: true`; skills, prompt templates and context files stay disabled. Provide a self-contained task and avoid overlapping edits to shared files.
- Manually configured new roles without `tools` get all Pi tools; roles created in the menu start with no tools and no extensions.
- No automatic diff or extra task context is prepared. For reviews, supply a readable diff or file paths and the scope; a review covers the full requested diff unless the task asks for a small one.
- Worker completion is not proof of task correctness. The parent must inspect and validate results.
- Archives under `~/.pi/agent/delegate/` are retained indefinitely and can contain sensitive prompts, code, thinking and tool output.

## Development

Run from the repository root:

```bash
npm ci --omit=peer
npm run test:unit       # no Pi required; runs in CI
npm run test:examples   # review-comment example; runs in CI
npm run test:load       # installed Pi CLI, isolated temporary configuration
npm test                # all three
```

Tests make no model calls. Delegation guidance ships with the extension; do not duplicate role/model policy in `AGENTS.md`.

See [child-runtime](child-runtime/README.md) and the [implementation contract](delegate/SPEC.md) when working on those areas.
