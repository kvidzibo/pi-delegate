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

In TUI/RPC, a finished background job injects a short follow-up notice (preview only; full result still via `jobId`). Failures are visible; successes stay quiet in the transcript. Collecting a finished job suppresses the notice, including when the job finished mid-turn (notice waits until the parent is idle). Print/JSON stays pull-only. `session_shutdown` does not notify.

Background `implement` can race parent file writes. Progress callback failures do not invalidate accepted jobs or hide their collection receipts. Tool activity is correlated by tool-call ID, so identical or overlapping calls remain distinct; ID-less legacy events retain name-based matching.

Child is always a `pi` process (`--mode rpc --model <id>`). Codex/Anthropic/Ollama are providers behind that model id, not a separate CLI. Task goes on stdin as an RPC prompt. Each child end appends one JSON line to `~/.pi/agent/delegate.log` (cmd, pid, exit, JSONL event types, stderr). Task text is not on argv. `PI_DELEGATE_LOG=0` disables. `PI_DELEGATE_LOG=/path` overrides. Empty-answer tool results include the same dump so the parent is not blind.

Then `/reload` (or restart Pi) so the overlay is picked up.

## Job display

Each launch has one updating job card: kind, model identifier (once), job ID, task, and current status. It keeps updating after a background return or foreground timeout, including when the child finishes without a collection call. Running/queued cards use neutral framing; only the job status marks success or failure. Raw child thinking is never printed in the header.

```text
delegate · review · xai/grok-4.6 · d0003
Task: Review timeout and abort handling
✓ Finished
[Readable preview of the child result]
```

Collapsed cards show up to three rendered lines of the result. **Ctrl+O** (or your configured tool-expansion shortcut) shows the full returned result, the last three tool actions, and the native session path for the complete recorded history. Individual command failures are shown in tool details, not confused with overall job failure. Recording warnings and job errors remain visible when collapsed.

Wait/peek/wrap/cancel calls are compact transcript receipts, not duplicate job cards. For example, `d0003 · result collected` or `d0003 · checked · running at check`. These are historical events, while the launch card shows the current job state. The sticky widget shows only running/queued/local-slot counts. The parent model still receives the same full tool results; this is a TUI presentation change.

Completion snapshots are saved as UI-only `delegate-job-state` session entries (including the capped answer, without raw thinking), so cards restore on reload/resume without model calls. Identity uses the original tool-call ID, not a short job ID that can repeat after reload. If an old or interrupted job has no saved completion, it is labelled historical with live status unavailable, never falsely left “running”. This does not resume jobs. `/reload` still stops outstanding children, as before.

Run `/reload` after updating the package to activate the new renderer.

## Child archives and session infobar

Every accepted local **and hosted** delegation is archived under `~/.pi/agent/delegate/` (or `<PI_CODING_AGENT_DIR>/delegate`). Set `PI_DELEGATE_ARCHIVE_DIR` to an absolute path to relocate it. **Retention is indefinite: no expiry, pruning, or size-based eviction.** Recording starts after installation/reload; old unrecorded usage cannot be recovered.

```text
runs/<UUID>/session.jsonl      Native Pi transcript, separate from parent /resume
runs/<UUID>/metadata.json      Parent session/tool-call IDs, model, kind, times, outcome, usage
runs/<UUID>/system-prompt.md   Snapshot of the custom child prompt
runs/<UUID>/task.md            Task, including jobs cancelled before they started
usage.jsonl                   Append-only export of finalized run summaries
```

Run UUIDs remain unique across processes and restarts even when short job IDs repeat. Native transcripts preserve what Pi records (messages, tool results, summaries), not unlimited raw tool output or referenced temporary files. Existing output/transport limits still apply. The custom prompt snapshot and tool configuration are recorded, not credentials, provider environment dumps, or full wire payloads.

New directories/files are private (`0700`/`0600` on POSIX); an existing archive directory must already be private and owned by you. **Transcripts can contain sensitive code, prompts, thinking, and tool output.** Nothing is uploaded automatically. Indefinite retention is not a backup against disk failure. Monitor disk space yourself; inability to establish recording refuses a new launch rather than deleting old data. Later recording errors are shown separately from the child's outcome, with partial usage retained where possible. `PI_DELEGATE_LOG=0` disables only the old diagnostic log, **not** this archive.

The infobar adds a separate status entry, without replacing Pi's normal parent-token counters:

```text
delegated 184k · local 162k · saved —
```

- **delegated:** recorded input + output + cache-read + cache-write tokens for all children of this parent session.
- **local:** the local subset, classified using the actual provider/model when available. This is offloaded work, **not net cloud savings**.
- **saved —:** no defensible cloud-only comparison baseline exists. This version deliberately does not invent a savings estimate or equate local tokens with tokens saved.
- **!partial:** unfinished, missing, or failed accounting attributable to this session; shown totals are known lower bounds. Reported usage from failed attempts counts too. All-zero provider placeholders are treated as missing, not as free work.
- **!archive:** archive errors that cannot be attributed to a parent session. This is separate from known partial usage; totals may be incomplete. `/delegate-stats all` shows the archive diagnostics. Errors known to belong to another parent do not mark this session partial.

Live cumulative usage is replaced, not repeatedly added; final assistant/tool/summarization usage is counted once. Reasoning is already in output. Compaction's retained message copies are not new inference. Totals restore on `/resume` and `/reload`, reset on `/new` and `/fork`, and remain session-wide when navigating `/tree`. Old sessions show recorded runs only. Background work, cancellation, and shutdown are included. No provider calls or model-context messages are generated by the infobar or reports.

```text
/delegate-stats          Current parent session (same as "session")
/delegate-stats today    Runs created today, in local time
/delegate-stats all      All recorded runs
/delegate-stats rebuild  Rebuild the export from retained sessions; append corrected snapshots
```

Reports separate local/hosted token buckets, outcomes, completed runtime and incomplete usage, and list the latest ten transcript paths. Expand a delegate result to see its transcript path. Inspect without model calls using `pi --export /path/to/session.jsonl /tmp/child.html`. To continue a child conversation, **fork it into a normal session** rather than modifying the archive in place.

The runtime passes the already-private archived `system-prompt.md` directly to Pi after a readability check, rather than creating a second temporary copy. The archive owns its lifetime; completion, cancellation, and failure do not delete it.

The per-run native transcript and metadata are the source of truth. Reports never sum repeated `jobId` collections or duplicated export rows. Export consumers must take the **highest `revision` per `runId`** (last row breaks equal-revision ties), not sum all rows. A delayed rebuild cannot supersede a newer terminal revision; `rebuild` appends corrections and never deletes historical rows. Atomic per-run metadata and separate UUID directories avoid cross-process lost updates. Unfinished runs are recovered as incomplete, without assuming another Pi process is dead or resuming its work. Missing/corrupt usage summaries can be reconstructed from native entries when identifying metadata remains intact; unreadable records are reported, not silently treated as zero.

Run `/reload` (or restart Pi) to activate these changes in existing sessions.

## Errors and output limits

Rejected RPC prompts (for example, missing credentials) fail immediately with the child's error, clean up the process, and release its slot. Provider errors appear before any partial answer so output truncation cannot hide the cause. A model output-token cutoff (`stopReason: "length"`) is a failed job with an explicit incomplete-answer warning, even if no answer text was produced. Any partial answer remains available within the output cap. Validation and child failures are marked as errors in Pi and show a short explanation even when collapsed; expand for the full error.

Completed jobs retain capped results for later `jobId` collection within the session, but release runner/control references that would otherwise retain the subprocess and uncapped RPC state. Completed model identifiers preserve Pi's separate provider and model fields as `provider/id`; incomplete model metadata leaves the last known identifier unchanged (initially the configured model).

The final answer includes every text block from the last assistant message, in order. `maxOutputBytes` (default 65536) caps the returned text with a truncation notice. This is separate from the 8-MiB per-record RPC transport limit. Oversized, recognized non-answer events (such as cumulative transcripts and image tool results) are discarded without killing the child; their progress detail may be absent. Oversized assistant/control events or unknown layouts fail explicitly rather than silently returning an earlier answer. Discards appear as `oversized_event_skipped` in diagnostic event types.

## Tests

```bash
npm run test:unit       # no Pi required; this is what CI runs
xvfb-run -a npm test    # unit + CLI load/UI checks (Linux; needs `pi` and Xvfb)
```

Unit tests mock children and process termination; they never signal OS process groups. Load/UI checks start isolated, offline Pi CLI processes with temporary configuration, but never call models or start real delegate workers. Job-card lifecycle probes inject a mocked child runner. They use the installed CLI's loader, not private unbundled Pi imports; no separate `@earendil-works/pi-server` installation is needed. On systems without Xvfb, the underlying command is `npm test`.

CLI load/UI checks are omitted from GitHub Actions because runners have no `pi`.

See `delegate/SPEC.md`.
