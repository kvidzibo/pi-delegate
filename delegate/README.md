# delegate

One routing tool. Four agents. Model from config.

| kind | default tools | writes |
|---|---|---|
| `recon` | read, grep, find, ls, bash | no |
| `implement` | + write, edit | yes |
| `review` | read, grep, find, ls, bash | no |
| `oracle` | read, grep, find, ls, bash | no |

Child is a nested `pi --mode rpc` with `--no-extensions`. `offline: true` adds `--offline`. Wrap uses RPC `steer`. After `agent_settled`, stdin closes.

The session infobar shows `delegated N · local N · saved —`, or `saved ~$X` for calibrated API-equivalent local offload (`!estimate` for partial estimate coverage, `!partial` for incomplete accounting). Configure `localAlternatives` and absolute `calibrationProfiles` paths; benchmarking is separate and explicitly budget-gated via `bench/index.ts`. No profiles or historical guesses are shipped. `/delegate-stats [session|today|all|rebuild]` reports usage without model calls. Native child sessions and metadata are retained indefinitely outside parent `/resume`; see the root README for storage, privacy, recovery, and metric definitions.

The full active card (job ID, kind, model, task, live status and latest tool) is pinned above the editor. Its transcript row is only an acceptance receipt until completion, when it becomes the full finished card with a Markdown result preview. This avoids duplicate live cards and rewrites of off-screen history. The pinned stack includes counts (`N run  M wait  local x/y`), optional local `tg n/s`, and wrap requests; Ctrl+O expands task/tool detail within the height budget. TUI mounts it once, caps it at 12 rows and half the terminal height, and labels overflow with `+N more` and job IDs. Tiny terminals use compact cards. Regular mode further budgets for the editor/footer and sibling widgets, then fills spare rows above the panel to anchor it even for short output; fullscreen keeps its native layout. Idle removes the panel and padding, and shutdown/reload removes the wrapper. No Pi settings or editor/footer replacements are needed. RPC sends deduplicated plain card previews capped at ten rows and 100 columns. Wait/collect calls are compact historical receipts; they do not repeat the job's tool list. Expand final cards for the full result, recent tools and native transcript path. Raw thinking is not displayed. UI-only terminal snapshots restore cards on reload; unfinished historical jobs are labelled status unavailable rather than running, with their recorded tools still available when expanded. Completion can still cause one redraw. Run `/reload` after updating.

`background: true` returns `jobId`. `timeoutMs` waits, never kills. `jobId` waits/peeks; `wrap: true` steers wrap-up; `cancel: true` kills. Collect samples quiet every `checkIntervalMs` (60s) inside the wait. Local models share `maxLocalConcurrent`. Interactive mode may inject a short completion notice after the parent is idle (preview; full result via `jobId`). Mid-turn collect still suppresses it. Print/JSON stays pull-only.

Parent tool list is `delegate` only. Shared process helpers live in `../child-runtime/`.

## Tests

```bash
xvfb-run -a node --test --experimental-strip-types delegate/tests/*.test.ts tests/load.test.ts
```

No live child. Load smoke is required after config or factory changes.

See `SPEC.md`.
