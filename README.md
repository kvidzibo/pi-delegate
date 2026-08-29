# pi-delegate

Pi package. One parent tool, four agents. Child model is config — any id `pi` already knows.

| kind | job |
|---|---|
| `recon` | map / lookup (prompt says read-only) |
| `implement` | bounded edits + tests |
| `review` | review (prompt says read-only) |
| `oracle` | last-resort analysis (prompt says read-only) |

One child per call. No nesting. `background: true` returns `jobId` now. Local/GPU children share `maxLocalConcurrent` (default 1).

> **Security:** Pi packages run with your full system permissions. This one spawns child `pi` processes with `bash`. There is **no sandbox**. `offline` only skips Pi startup network; child `bash` can still use the network, write files, and read credentials. “Read-only” kinds are prompt policy only. Install only from a source you trust.

## Install

```bash
pi install npm:@kvidzibo/pi-delegate
```

Git:

```bash
pi install git:github.com/kvidzibo/pi-delegate@v0.4.0
```

Local checkout:

```bash
pi install /absolute/path/to/pi-delegate
```

Needs Pi on PATH. Do not `npm install` this repo; Pi supplies `@earendil-works/*` and `typebox`.

Do **not** also list `delegate` in `settings.json` `extensions`. Package load is enough.

## Config

Shipped `delegate/config.json` is **example models** (they become active defaults until you overlay). Set yours in `~/.pi/agent/delegate.json`. Omitted keys inherit shipped values, including `offline`. If you change a local agent to a hosted model, set `"offline": false`. Invalid overlay JSON prevents the extension from loading. Do not edit files inside a `pi install git:` clone.

```json
{
  "maxConcurrent": 8,
  "maxLocalConcurrent": 1,
  "maxQueued": 16,
  "agents": {
    "recon": { "model": "ollama/qwen3:8b", "offline": true },
    "implement": { "model": "openai-codex/gpt-5.6-luna" },
    "review": { "model": "anthropic/claude-sonnet-4-6" },
    "oracle": { "model": "openai-codex/gpt-5.6-sol" }
  }
}
```

`model` is any `provider/id` from `pi` model list (Ollama, llama.cpp, Codex, etc.).

Per-agent keys: `model`, `tools`, `thinking` (`off|minimal|low|medium|high`), `offline` (adds `--offline` for the child `pi` process only).

Optional tool argument `model` overrides that call only. Kind keeps tools and prompt.

`timeoutMs` is a wait budget. It does **not** kill the child. Foreground expiry auto-backgrounds and returns a short check-in (`jobId`, last tools, `quietForMs`). Collect `jobId` again to wait; omit `timeoutMs` to wait until done or 60s quiet (silent inside the wait — no extra parent tokens while events flow). `timeoutMs: 0` peeks. `wrap: true` steers the child to finish (current tool may complete first). `cancel: true` kills. `hardTimeoutMs` in config (default `0`) is the only process-start kill. Local models (`local-qwen*`, `llama.cpp`, `ollama`) never overlap above `maxLocalConcurrent`. A running child keeps its slot. Hosted jobs still run in parallel. `session_shutdown` kills leftovers.

In TUI/RPC, a finished background job injects a short follow-up notice (preview only; full result still via `jobId`). Failures are visible; successes stay quiet in the transcript. Collecting a finished job suppresses the notice. Print/JSON stays pull-only. `session_shutdown` does not notify.

Background `implement` can race parent file writes.

Child is always a `pi` process (`--mode rpc --model <id>`). Codex/Anthropic/Ollama are providers behind that model id, not a separate CLI. Task goes on stdin as an RPC prompt. Each child end appends one JSON line to `~/.pi/agent/delegate.log` (cmd, pid, exit, JSONL event types, stderr). Task text is not on argv. `PI_DELEGATE_LOG=0` disables. `PI_DELEGATE_LOG=/path` overrides. Empty-answer tool results include the same dump so the parent is not blind.

Then `/reload` (or restart Pi) so the overlay is picked up.

## Tests

```bash
npm test          # unit + factory load (needs `pi` on PATH)
npm run test:unit # no Pi required; this is what CI runs
```

No live child. Factory load is omitted from GitHub Actions because runners have no `pi`.

See `delegate/SPEC.md`.
