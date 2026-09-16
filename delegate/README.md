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

Default limits apply to this parent session, not other Pi sessions or unrelated GPU processes. The separately opted-in shared-capacity API below adds cross-session coordination without replacing these limits.

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

Local providers are `local-qwen*`, `llama.cpp` and `ollama`. A running local child holds its slot until its runner settles after process closure; requesting cancellation does not free it early. Eligible jobs start in acceptance order; hosted work can pass a local job waiting for a local slot. The extension never starts/stops local servers or changes GPU fans.

`localAlternatives` maps local models to hosted pricing references, **not fallbacks**. An overlay replaces the whole map; `{}` disables it. `calibrationProfiles` replaces the list of absolute profile paths and defaults to `[]`. See [calibration](../bench/README.md).

## Shared-capacity API

`JobScheduler` optionally accepts a `CapacityBroker`. The Linux `FileCapacityBroker` coordinates cooperating schedulers across processes and working directories:

```ts
const capacity = new FileCapacityBroker("/absolute/private/shared-root");
const scheduler = new JobScheduler({ maxConcurrent: 8, maxLocalConcurrent: 1,
  maxQueued: 16, capacity, resourcePollMs: 250 });
// Every local enqueue supplies resourceGroup: { key: "server-a", capacity: 1 }.
// Its runner forwards handle.resourceLease to runChild with explicit guarded execution.
```

This is a runtime API, **not yet a configuration setting or default**. Models, tools and saved prompts are unchanged. All cooperating clients must use the same absolute root and explicit resource key for the same server/resource pool, including different model IDs on that pool. This is host-local coordination, not a distributed lock or proof of server-side inference idleness. It does not coordinate older/unconfigured clients, unrelated GPU work, or servers themselves; it never starts/stops servers or changes fans.

- Keys are 1–128 safe ASCII characters; capacity is an integer 1–64. Capacity is independent of model ID. Parent `maxConcurrent` and `maxLocalConcurrent` still apply.
- Every local job needs an explicit group when a broker is enabled; a missing group or broker is refused, never silently uncoordinated. Hosted jobs bypass this local-only broker. Eligible hosted/independent-group work can pass a busy group. Shared-resource waiters count toward `maxQueued`; queue time is not execution time.
- Polling runs only while otherwise-eligible resource waiters exist (250 ms default, configurable 10–60000 ms). A busy group/capacity pair is probed once per pass, preserving acceptance order within it.
- Linux `/usr/bin/flock` holds stable private lock-file descriptors. The utility does not own the lease after it exits: the parent and then the Pi child share its open-file description. Readiness verifies the expected inherited descriptor before any task is sent. Release closes descriptors, never unlinks lock files or forcibly unlocks another holder. Parent death cannot free a lease still held by the child.
- Capacity changes require every existing slot to be idle. Conflicting live limits, missing locking support, corrupt/insecure state or failed descriptor acknowledgement fail closed. There is no PID/mtime expiry, age-based takeover or uncoordinated fallback. Keep the root on a local filesystem with Linux `flock` semantics; do not delete or replace live lock files.
- Cancellation/shutdown retain running leases until runner completion after process closure. A runner borrows its descriptor and must not close it; the scheduler owns release. A failed release is reported separately without rewriting the child outcome.
- With `localAdmission`, both gates must accept before a runner starts. A denied/failed local admission releases provisional capacity immediately. Uncertain rollback fails the queued job rather than retrying and leaking more leases; an already-cancelled outcome remains unchanged.

Snapshots/results distinguish `resource` waits and `waiting`, `held`, `released`, `not-acquired` or `release-unknown` resource states. UI cards identify the waiting group; release uncertainty remains a visible warning. Broker acquisition failures use `resource-error`; inherited-descriptor startup failures use `guard-error`. Root setup/ownership checks happen on acquisition, not construction.

## Local delegation switch

`/delegate-local` opens Pi's native picker (TUI or RPC). Its title shows **ON/OFF** and the active local-job count across participating processes; the current choice is marked and listed first. Choose **On** or **Off**, or Esc to leave the state unchanged. Direct forms: `/delegate-local on|off|status`.

- **Off:** refuse new local launches immediately, including local `model` overrides on any kind. Existing queued local jobs remain queued with an explicit OFF reason. Running jobs are not interrupted.
- **On:** allow new local work and resume held jobs. Shared-state polling refreshes queues and the OFF footer within about one second; every admission checks the switch directly, without relying on polling.
- **Status:** show active/draining jobs or idle. The OFF footer updates from `draining N jobs` to `idle`. Admission reservations count as active until runner cleanup finishes. Hosted jobs do not use this gate and are never selected as an automatic fallback.

State lives in `<agent-dir>/delegate-local/` (normally `~/.pi/agent/delegate-local/`), separately from `delegate.json` and archive overrides. An atomic `state.json` stores the switch; private `active/` reservation files track admitted local jobs. The default is ON; OFF survives shutdown, reload and restart until explicitly enabled. No model calls are made by the command. No saved prompts, model configuration, servers or fans are changed.

**Scope:** same user, machine, local filesystem and agent directory, with this feature loaded in every participating Pi session. Older versions, other agent directories, parent models, the opt-in calibration runner and unrelated GPU clients are not controlled or counted. Install/update and reload each session once before using the switch; subsequent toggles need no reload. The switch is not a cross-process capacity lock. Concurrency limits remain per-parent unless the separately opted-in shared-capacity API above is also supplied.

**Before benchmarking:** select Off and wait for `OFF · idle`; separately stop or coordinate clients outside this scope. A crashed parent may leave an orphaned child. Its reservation is retained and reported as **unverified (not idle)**, rather than silently expired. Inspect the processes/archives and remove only the corresponding files in `delegate-local/active/` after confirming the work has stopped. PID reuse can conservatively keep a stale reservation counted as active. Do not delete active reservations or the state directory to force an idle report.

Unreadable/corrupt control state blocks local admission and produces an unavailable warning; hosted work remains independent. `/delegate-local on` or `off` can replace a malformed state file, but never clears reservations. Cleanup failures leave a warning and a conservative reservation. Concurrent command changes are last-writer-wins; status is a snapshot, not an exclusive benchmark reservation.

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
- Use `wrap` to steer the child toward finishing; the current tool may complete first. Requests made before control readiness are retained; repeated accepted wraps are idempotent.
- Use `cancel` to stop it. `hardTimeoutMs` is the separate, optional process-start kill limit.

The child runtime determines cancellation and deadline causes; a zero exit after an applied stop remains unsuccessful. A later cancellation during post-exit recording does not relabel an already-completed child. Available text stays collectible; capacity remains held until the runner settles after process closure.

The runtime library separately offers [explicit guarded execution](../child-runtime/README.md#opt-in-guarded-execution): a readiness handshake, execution-body tool gate, soft execution budget and bounded finalization grace. It is not yet connected to agent configuration or enabled by default. For opted-in runners, result details distinguish a finalization request from acknowledged enforcement and retain incomplete streaming evidence on forced stops. Legacy calibration estimates are disabled for these runs.

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

Unit tests mock Pi children and process termination; Linux lease tests additionally use owned offline Node processes and real kernel locks. CLI/UI checks use isolated offline Pi processes and mocked runners, never model requests; CI runs unit tests only because its runners lack Pi. See the [test contract](SPEC.md#tests) for coverage and regression requirements.
