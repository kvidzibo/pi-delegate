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
pi install git:github.com/kvidzibo/pi-delegate@v0.3.0
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

`background: true` spawns and returns `jobId`. Call again with `jobId` to wait, or `timeoutMs: 0` to peek. Local models (`local-qwen*`, `llama.cpp`, `ollama`) never overlap above `maxLocalConcurrent`. Hosted jobs still run in parallel. Child timeout starts when the process starts, not while queued. `session_shutdown` kills leftovers.

In TUI/RPC, a finished background job injects a short follow-up notice (preview only; full result still via `jobId`). Failures are visible; successes stay quiet in the transcript. Collecting a finished job suppresses the notice. Print/JSON stays pull-only. `session_shutdown` does not notify.

Background `implement` can race parent file writes.

Child is always a `pi` process (`--mode json -p --model <id>`). Codex/Anthropic/Ollama are providers behind that model id, not a separate CLI. Each child end appends one JSON line to `~/.pi/agent/delegate.log` (cmd, pid, exit, JSONL event types, stderr). Task text is redacted. `PI_DELEGATE_LOG=0` disables. `PI_DELEGATE_LOG=/path` overrides. Timeout/empty-answer tool results include the same dump so the parent is not blind.

Then `/reload` (or restart Pi) so the overlay is picked up.

## Tests

```bash
npm test          # unit + factory load (needs `pi` on PATH)
npm run test:unit # no Pi required; this is what CI runs
```

No live child. Factory load is omitted from GitHub Actions because runners have no `pi`.

See `delegate/SPEC.md`.
