# pi-delegate

Pi package. One parent tool, four agents. Child model is config — any id `pi` already knows.

| kind | job |
|---|---|
| `recon` | map / lookup (prompt says read-only) |
| `implement` | bounded edits + tests |
| `review` | review (prompt says read-only) |
| `oracle` | last-resort analysis (prompt says read-only) |

One child per call. No nesting.

> **Security:** Pi packages run with your full system permissions. This one spawns child `pi` processes with `bash`. There is **no sandbox**. `offline` only skips Pi startup network; child `bash` can still use the network, write files, and read credentials. “Read-only” kinds are prompt policy only. Install only from a source you trust.

## Install

After the GitHub repo exists and a tag is pushed:

```bash
pi install git:github.com/<owner>/pi-delegate@v0.1.0
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

Then `/reload` (or restart Pi) so the overlay is picked up.

## Tests

```bash
npm test          # unit + factory load (needs `pi` on PATH)
npm run test:unit # no Pi required; this is what CI runs
```

No live child. Factory load is omitted from GitHub Actions because runners have no `pi`.

See `delegate/SPEC.md`.

## Publish

1. Create public GitHub repo.
2. Put `repository` / `homepage` / `bugs` in `package.json`.
3. `git tag v0.1.0 && git push origin main --tags`
4. Users install the git spec above.
