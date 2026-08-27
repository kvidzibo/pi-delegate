# delegate

One routing tool. Four agents. Model from config.

| kind | default tools | writes |
|---|---|---|
| `recon` | read, grep, find, ls, bash | no |
| `implement` | + write, edit | yes |
| `review` | read, grep, find, ls, bash | no |
| `oracle` | read, grep, find, ls, bash | no |

Child is a nested `pi --mode json -p` with `--no-extensions`. `offline: true` adds `--offline`.

TUI row (no footer). Local child may add live `tg n/s` after model id.

Parent tool list is `delegate` only. Shared process helpers live in `../child-runtime/`.

## Tests

```bash
node --test --experimental-strip-types delegate/tests/*.test.ts tests/load.test.ts
```

No live child. Load smoke is required after config or factory changes.

See `SPEC.md`.
