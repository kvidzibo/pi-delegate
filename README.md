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
pi install git:github.com/kvidzibo/pi-delegate@v0.2.0
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

Background `implement` can race parent file writes.

Then `/reload` (or restart Pi) so the overlay is picked up.

## Tests

```bash
npm test          # unit + factory load (needs `pi` on PATH)
npm run test:unit # no Pi required; this is what CI runs
```

No live child. Factory load is omitted from GitHub Actions because runners have no `pi`.

See `delegate/SPEC.md`.

## Publish

- GitHub: `kvidzibo/pi-delegate`
- npm: `@kvidzibo/pi-delegate` (gallery crawls the `pi-package` keyword)

Push to `main` runs `.github/workflows/publish.yml`: unit tests, then `npm publish` if `package.json` `version` is not already on npm. Same version = skip (no error).

Bump `version` in the PR that should ship. Do not republish an existing version.

One-time npm trusted publisher (no `NPM_TOKEN` secret):

1. [Package access](https://www.npmjs.com/package/@kvidzibo/pi-delegate/access) → **Trusted Publisher**
2. GitHub Actions: user `kvidzibo`, repo `pi-delegate`, workflow `publish.yml`
3. Allow `npm publish`
