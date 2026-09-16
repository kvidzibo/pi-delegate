# Delegate reference

[Quick start](../README.md) · [Calibration](../bench/README.md) · [Implementation contract](SPEC.md)

## Configuration

Settings load from [config.json](config.json), then `~/.pi/agent/delegate.json` (or `<PI_CODING_AGENT_DIR>/delegate.json`). A missing overlay is fine; invalid JSON or settings prevent loading. Omitted fields inherit shipped values. Keep customizations outside installed package clones, which Pi may reset during updates.

Run `/reload` or restart Pi to apply changes. Reload stops outstanding children; it does not resume them.

### Per-agent settings

Configure these under `agents.recon`, `agents.implement`, `agents.review` or `agents.oracle`:

| Key | Meaning |
|---|---|
| `model` | Any `provider/id` available to the child Pi process |
| `tools` | Non-empty tool-name array; replaces the kind's tool list |
| `thinking` | `off`, `minimal`, `low`, `medium` or `high` |
| `offline` | Adds `--offline` to the child; skips startup networking only |

All kinds default to `read`, `grep`, `find`, `ls` and `bash`; `implement` also gets `write` and `edit`. The other kinds' no-edit policy is a prompt instruction, **not a filesystem boundary**. All children retain your system permissions and can access the network through tools.

A per-call `model` override changes only the model. The kind keeps its tools, prompt, thinking level and `offline` setting. When changing a local agent to a hosted model, explicitly set `offline: false` in the overlay.

### Limits

Limits apply to this parent session, not other Pi sessions or unrelated GPU processes.

| Setting | Default | Meaning |
|---|---:|---|
| `maxConcurrent` | 8 | Running children, local + hosted |
| `maxLocalConcurrent` | 1 | Running local children |
| `maxQueued` | 16 | Jobs waiting for capacity; overflow is rejected |
| `maxTaskChars` | 20000 | Maximum task length |
| `defaultTimeoutMs` | 300000 | Initial foreground wait budget, including queue time |
| `maxTimeoutMs` | 900000 | Upper clamp for the initial wait budget |
| `checkIntervalMs` | 60000 | Quiet interval used inside collection waits |
| `hardTimeoutMs` | 0 | Kill timeout measured from process start; `0` disables it |
| `maxOutputBytes` | 65536 | Returned-answer cap, including a truncation notice |

Local providers are `local-qwen*`, `llama.cpp` and `ollama`. A running local child holds its slot until it finishes or is cancelled. Eligible jobs start in acceptance order; hosted work can pass a local job waiting for a local slot. The extension never starts/stops local servers or changes GPU fans.

`localAlternatives` maps local models to hosted pricing references, **not fallbacks**. An overlay replaces the whole map; `{}` disables it. `calibrationProfiles` replaces the list of absolute profile paths and defaults to `[]`. See [calibration](../bench/README.md).

## Job lifecycle

Each call launches one child or operates on an existing job. Nested delegation is forbidden.

| Argument | Use |
|---|---|
| `kind`, `task` | Required to launch; use a non-empty, self-contained task |
| `cwd` | Existing directory; relative paths resolve against the parent's cwd |
| `model` | Override the configured model for this call |
| `background: true` | Return a `jobId` immediately; child keeps running |
| `timeoutMs` | Wait budget, never a kill timeout |
| `jobId` | Wait for or collect an existing job; cannot combine with launch fields |
| `wrap: true` | With `jobId`: request wrap-up; cancel if still queued |
| `cancel: true` | With `jobId`: abort and kill; safe to repeat after completion |

Do not combine `wrap` and `cancel`, or `jobId` and `background: true`.

Without `background`, launch waits for completion or the initial budget. Budget expiry promotes the job to background and returns a check-in with `jobId`, recent tools and `quietForMs`; it does not release the slot. Background children survive parent Esc. Avoid concurrent `implement` work on files the parent is editing.

For collection:

- Omit `timeoutMs` to wait until completion or 60 seconds of quiet by default. Progress keeps the wait open without repeated parent receipts.
- Set a positive `timeoutMs` to bound that wait, or `0` to peek.
- Use `wrap` to steer the child toward finishing; the current tool may complete first.
- Use `cancel` to stop it. `hardTimeoutMs` is the separate, optional process-start kill limit.

Finished results remain collectible within the session. In TUI/RPC, background completion may inject a short follow-up after the parent becomes idle; collect via `jobId` for the full result. Collecting a finished job suppresses the notice. Success notices stay hidden in the transcript; failures are visible. Print/JSON is pull-only. Shutdown stops children and queued work without completion notices.

Children are always `pi --mode rpc` processes, not vendor CLIs. They use the kind's custom prompt with extensions, skills, prompt templates and context files disabled. The parent conversation is not copied; include necessary context in the task. Tasks arrive over stdin, not argv. See [child-runtime](../child-runtime/README.md) for transport details.

## Job display

While a job runs, its full card stays pinned above the editor:

```text
delegate · d0003 · review · xai/grok-4.6
Task: Review timeout and abort handling
● Running — reading file
→ read  delegate/jobs.ts
delegate  1 run  0 wait  local 0/1 · ctrl+o details
```

The transcript holds a compact acceptance receipt. On completion, the pinned card disappears and that receipt becomes the finished result card, even without collection or after a foreground timeout. Wait/peek/wrap/cancel calls remain compact receipts, not duplicate cards.

Collapsed finished cards show up to three rendered result lines. **Ctrl+O** (or your configured tool-expansion shortcut) shows the full returned answer, last three tools and native session path. Job errors and recording warnings remain visible when collapsed. A failed child command is not itself an overall job failure. Raw thinking is never displayed.

The pinned stack preserves acceptance order and shows running/queued/local counts, optional local generation rate and wrap requests. It uses at most 12 rows and half the terminal height, reduced further for the editor/footer and sibling widgets in regular mode. Overflow shows `+N more` with job IDs; tiny terminals use compact cards. Expansion stays within that budget.

Cards are theme-matched: pending/historical use `toolPendingBg`, finished use `toolSuccessBg`, failed/cancelled use `toolErrorBg`. Receipts and the counts footer remain unfilled. RPC gets deduplicated plain previews, capped at ten rows and 100 columns.

Regular mode anchors cards and the existing editor/footer at the bottom; fullscreen keeps Pi's native layout. The panel and spacing disappear when idle. Shutdown/reload restores the original component tree without changing Pi settings or replacing the editor/footer. Live updates avoid rewriting off-screen transcript rows; completion may cause one redraw. Terminal scrollback stays native.

UI-only `delegate-job-state` session entries restore completed cards on reload/resume without model calls. Identity uses the original tool-call ID, since short job IDs can repeat. Interrupted or old jobs without a saved completion show historical/status unavailable, never falsely running. **Restoring a card does not resume a job.**

## Archives and privacy

Every accepted local and hosted job is archived under `~/.pi/agent/delegate/` (or `<PI_CODING_AGENT_DIR>/delegate`). Set `PI_DELEGATE_ARCHIVE_DIR` to an absolute path to relocate it.

```text
runs/<UUID>/session.jsonl      Native Pi transcript, separate from parent /resume
runs/<UUID>/metadata.json      Parent/tool-call IDs, model, kind, times, outcome, usage
runs/<UUID>/system-prompt.md   Custom child prompt snapshot
runs/<UUID>/task.md            Task, including queued cancellations
usage.jsonl                   Append-only finalized run summaries
```

**Retention is indefinite: no expiry, pruning or size-based eviction.** Recording starts after installation/reload; earlier unrecorded usage cannot be recovered. Monitor disk space and keep your own backups.

New directories/files use `0700`/`0600` on POSIX. An existing archive directory must already be private and owned by you. Transcripts may contain sensitive code, prompts, thinking and tool output. The recorder does not capture credential/environment dumps or full wire payloads, but sensitive data can still appear in recorded messages and tool output. Archives are not uploaded automatically.

Native transcripts retain what Pi records, not unlimited raw tool output or referenced temporary files. Transport/output limits still apply. The archived custom prompt is passed directly to Pi and retained after completion, cancellation or failure.

Failure to establish recording refuses a new launch rather than deleting old data. Later recording errors are shown separately from the child's outcome, preserving partial usage where possible.

Expand a result or use `/delegate-stats` for transcript paths. Inspect without model calls:

```bash
pi --export /path/to/session.jsonl /tmp/child.html
```

To continue a child conversation, fork it into a normal session rather than modifying the archive in place.

## Usage and reports

The infobar adds child accounting without replacing Pi's parent-token counters:

```text
delegated 184k · local 162k · saved —
```

| Field | Meaning |
|---|---|
| `delegated` | Recorded input + output + cache-read + cache-write tokens for this parent's children |
| `local` | Local subset, classified by actual provider/model when available; offloaded work, not net cloud savings |
| `saved ~$X` | Calibrated API-equivalent value of complete, successful local runs versus a configured hosted child |
| `saved —` | No matching calibration or known reference pricing |
| `!estimate` | Only some eligible local runs have monetary estimates; coverage, not a confidence interval |
| `!partial` | Session-attributable accounting gaps; shown usage is a known lower bound |
| `!archive` | Archive errors whose parent session cannot be identified; inspect `/delegate-stats all` |

Failed/pending/incompletely recorded runs count toward usage but earn no savings estimate. All-zero provider placeholders mean missing usage, not free work. Errors known to belong to another parent do not mark this session partial.

Live cumulative usage replaces prior values; finalized inference, tool/summarization and failed-attempt usage count once. Reasoning is already in output; compaction's retained copies are not new inference. Totals restore on `/resume` and `/reload`, reset on `/new` and `/fork`, and remain session-wide across `/tree`. Old sessions include recorded runs only.

```text
/delegate-stats          Current parent session (same as "session")
/delegate-stats today    Runs created today, in local time
/delegate-stats all      All recorded runs
/delegate-stats rebuild  Rebuild the export from retained sessions
```

Reports separate local/hosted token buckets, outcomes, completed runtime and incomplete usage, plus the latest ten transcript paths. The infobar and reports make no model calls and add no model-context messages.

### Recovery and export consumers

Native sessions and per-run metadata are the source of truth. Reports do not count repeated collections or export rows twice. For `usage.jsonl`, take the **highest `revision` per `runId`**, using the last row for equal-revision ties; never sum every row.

Rebuild appends corrected snapshots without deleting history or replacing newer terminal revisions with stale data. UUID run directories and atomic metadata avoid cross-process lost updates. Unfinished runs are reported as incomplete without assuming another Pi process is dead or resuming its work. Missing/corrupt usage can be reconstructed from native entries when identifying metadata survives; unreadable records are reported, not treated as zero.

## Errors and diagnostics

Rejected RPC prompts, including missing-credential failures, clean up the process and release its slot. Provider errors precede partial answers so truncation cannot hide the cause. Model output-token cutoff (`stopReason: "length"`) fails with an incomplete-answer warning, even for an empty answer; any partial text remains available within the cap.

Without delivered wrap steering, the returned answer joins all text blocks from the last assistant message. When a wrap message is delivered, the preceding response is retained separately from subsequent wrap-up replies. Labels identify the task/wrap phase and assistant-message ordinal (not a native session entry ID). Reports finishing while steering is queued still belong to the preceding phase; acknowledgements and corrections never replace them. A successful retry replaces an earlier error within the same phase. Empty or missing wrap-up responses are labelled and fail rather than imply a complete answer.

`maxOutputBytes` caps the combined text. Space is shared between retained phases so a long report cannot consume the follow-up's entire budget; errors precede the history. At most eight phases are retained in memory: the first plus the most recent seven, with omissions labelled. Very small caps explicitly truncate the history; full recorded messages remain in the native archive. Natural completion shortened only by this cap remains successful. Completed jobs retain capped results but release process/control references.

The separate RPC transport limit is 8 MiB per record. Recognized oversized non-answer events (such as cumulative transcripts or image tool results) are discarded; some progress detail may be absent. Oversized assistant/control events or unknown layouts fail explicitly rather than return an older answer. Discards are logged as `oversized_event_skipped`.

Each child exit appends a JSON line to `~/.pi/agent/delegate.log` with command, PID, duration/exit, event types and stderr. Empty-answer results include the same diagnostics. Set `PI_DELEGATE_LOG=/path` to relocate it or `PI_DELEGATE_LOG=0` to disable it. **This does not disable the archive.**

## Development

Run checks from the repository root:

```bash
npm run test:unit
xvfb-run -a npm test
```

Unit tests mock children and process termination. CLI/UI checks use isolated offline Pi processes and mocked runners, never model requests; CI runs unit tests only because its runners lack Pi. See the [test contract](SPEC.md#tests) for coverage and regression requirements.
