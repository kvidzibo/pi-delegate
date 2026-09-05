# delegate

One routing tool. Four agents. Model from config.

| kind | default tools | writes |
|---|---|---|
| `recon` | read, grep, find, ls, bash | no |
| `implement` | + write, edit | yes |
| `review` | read, grep, find, ls, bash | no |
| `oracle` | read, grep, find, ls, bash | no |

Child is a nested `pi --mode rpc` with `--no-extensions`. `offline: true` adds `--offline`. Wrap uses RPC `steer`. After `agent_settled`, stdin closes.

The session infobar shows `delegated N · local N · saved —` (`!partial` for incomplete accounting). `/delegate-stats [session|today|all|rebuild]` reports usage without model calls. Native child sessions and metadata are retained indefinitely outside parent `/resume`; see the root README for storage, privacy, recovery, and metric definitions.

Local child rows may add live `tg n/s` after model id. Background jobs add a sticky widget (`N run  M wait  local x/y`) while queued or running.

`background: true` returns `jobId`. `timeoutMs` waits, never kills. `jobId` waits/peeks; `wrap: true` steers wrap-up; `cancel: true` kills. Collect samples quiet every `checkIntervalMs` (60s) inside the wait. Local models share `maxLocalConcurrent`. Interactive mode may inject a short completion notice after the parent is idle (preview; full result via `jobId`). Mid-turn collect still suppresses it. Print/JSON stays pull-only.

Parent tool list is `delegate` only. Shared process helpers live in `../child-runtime/`.

## Tests

```bash
xvfb-run -a node --test --experimental-strip-types delegate/tests/*.test.ts tests/load.test.ts
```

No live child. Load smoke is required after config or factory changes.

See `SPEC.md`.
