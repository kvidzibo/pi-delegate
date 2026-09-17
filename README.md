# pi-delegate

Run focused coding tasks in separate [Pi](https://github.com/earendil-works/pi) agents while the parent keeps working. Supports local and hosted models, background jobs, and separate local concurrency limits.

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

Run **`/delegate`** to choose an available model for each role. Shipped model assignments are active defaults; unavailable models are not automatically replaced. Selections are saved in `~/.pi/agent/delegate.json` and apply to new jobs in the current session.

Manual configuration edits, package updates and other open sessions need `/reload` or a restart. **Reload stops outstanding children.**

## Use

Ask Pi:

```text
Delegate a background recon to find this repo's test files and test commands.
Do not edit files. Collect the result when it finishes.
```

The parent can wait, peek, request wrap-up or cancel using the returned job ID. `timeoutMs` limits waiting, not runtime. Active jobs appear above the editor; finished results appear in the transcript. **Ctrl+O** expands details.

See [configuration and job controls](delegate/README.md) for manual settings and tool arguments.

## Important constraints

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
