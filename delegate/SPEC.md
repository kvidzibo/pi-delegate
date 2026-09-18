# delegate — implementation contract

One routing tool. Four named agents. Child model is config. No nesting. Do not add a second parent tool.

## Goal

One routing tool. Four named agents. Child model is config (any Pi model id). No nesting.

Background spawn returns `jobId` immediately. Local/GPU children share `maxLocalConcurrent` (queue, do not overlap). Hosted children use `maxConcurrent` only. Do not start/stop GPU servers.

## Layout

```
delegate/
  README.md SPEC.md config.json
  index.ts config.ts spawn.ts display.ts view.ts cards.ts board.ts dock.ts panel.ts tg.ts jobs.ts notify.ts
  archive.ts usage.ts accounting.ts stats.ts calibration.ts capacity.ts capabilities.ts outcomes.ts
  prompts/{recon,implement,review,oracle}.md
  tests/{config,spawn,display,tg,jobs,lifecycle,notify}.test.ts
```

Repo root has `package.json` (`pi.extensions: ["./delegate"]`). This directory has no package.json.

User overlay: `~/.pi/agent/delegate.json` merged onto shipped `config.json`. Missing overlay is fine.

## Tool

Name: `delegate`  
Label: `Delegate`  
Description must say: named agents, model from config, no nesting.

| Field | Required | Rules |
|---|---|---|
| `task` | spawn | non-empty, max `maxTaskChars` |
| `kind` | spawn | `recon` \| `implement` \| `review` \| `oracle` |
| `cwd` | no | existing directory |
| `timeoutMs` | no | wait budget, never a kill. Spawn/fg: first wait (queue time counts). `jobId`: max wait (omit = until done or quiet). `0` with `jobId` = peek |
| `model` | no | any Pi model id. Kind keeps tools/prompt/thinking/offline. |
| `background` | no | `true` = return `jobId` now; child keeps running. Parent Esc does not kill it. Interactive mode may later inject a short completion notice |
| `jobId` | collect | wait, peek, wrap, or cancel. Cannot combine with `background`. Terminal collect suppresses the notice |
| `wrap` | no | with `jobId`: RPC `steer` wrap-up. Does not interrupt the current tool. Queued job → cancel. Cannot combine with `cancel` |
| `cancel` | no | with `jobId`: abort + kill. Idempotent if already terminal |

No model allowlist. No fallback chain.

`maxConcurrent` = max running children (local + hosted).  
`maxLocalConcurrent` = max running local children (`isLocalModel`).  
`maxQueued` = max jobs waiting for a slot. Overflow refuses.  
`checkIntervalMs` = silent quiet sample inside collect waits (default 60000). Events flowing → keep blocking. Quiet/junk → short check-in.  
`hardTimeoutMs` = optional process-start kill (default `0` = off). Distinct `hard_timeout`. Overlay only.

Eligible-first FIFO: a hosted job may start while a local job waits on the GPU slot.

Shared-capacity runtime API is opt-in, separate from configuration/default activation. A scheduler with a broker requires explicit `{ key, capacity }` groups for local jobs; never derive the group key from a model ID or silently omit a required group. Keep parent concurrency/local/queue limits. Hosted jobs and independent groups can bypass a blocked resource. Probe each busy group/capacity pair once per pass, poll only otherwise-eligible waiters, and stop polling on idle/shutdown. Coordination failures are explicit `resource-error`; release uncertainty is separate from child outcome.

The Linux file broker uses private stable lock inodes, a serialized catalog, and inherited `flock` open-file descriptions, not PID/mtime ownership guesses. Capacity changes require quiescence across all extant slots, including after metadata loss. Permission/symlink/metadata/tool failures fail closed. Close leases exactly once at terminal cleanup, never unlink live files or unlock shared descriptions. Parent death must not free capacity while its child still holds the inherited lease. Guarded startup verifies the inherited FD identity before any task; no lease means no descriptor change for ordinary runs. This coordinates cooperating local clients using the same root, not distributed/server-side requests or unrelated processes. No server/fan controls.

Retain wrap requests made before the runner provides control. First message wins; accepted wraps are idempotent, and queued wraps still cancel without spawning. Never reattach control after cancellation or completion. Let the child runtime classify terminal causes; a cancellation during asynchronous post-exit recording must not rewrite an earlier completed outcome.

One child per call. No nesting (`PI_DELEGATE_CHILD`).

Foreground spawn waits for a slot (parent blocked). Local foreground also takes the local slot.

Foreground `timeoutMs` expiry auto-promotes the job to background, detaches parent Esc, and returns a short nonterminal check-in (`terminal: false`, `jobId`, last tools, `quietForMs`). No thinking tail. Slot remains held. Parent continues with `jobId`, `wrap`, or `cancel`.

Collect waits until terminal, wait budget, or `checkIntervalMs` with no child events. Each wait starts a fresh quiet interval; later child events restart it. Waiting and wrap requests must not reset the reported `quietForMs` activity age. Peeks, explicit wait budgets and aborts still return sooner. 60s sampling is internal and must not add parent-token receipts while the child is making progress.

`session_shutdown` aborts running jobs and drops the queue. Do not notify for shutdown-induced aborts. Terminal jobs (including queued cancellation and thrown runners) drop runner/control references, retaining only collectible snapshots rather than subprocess closures and uncapped RPC state. Late control callbacks cannot reattach to terminal jobs.

Background completion notice (interactive TUI/RPC only): after the final snapshot, hold ~200ms. If the parent agent is still running (`ctx.isIdle()` false), keep holding — do not `sendMessage` yet. `sendMessage` queues a follow-up that collect cannot unsend. Once idle and not consumed, `pi.sendMessage` `{ deliverAs: "followUp", triggerTurn: true }`. Preview only; `jobId` remains the full result. Success `display: false`; failure `display: true`. Print/JSON stays pull-only. At most one notice per job. Collecting a terminal snapshot cancels it, including mid-turn collect after the job already finished.

One full card per launch, keyed by original tool-call ID, not the reusable short job ID. While active, pin the full card above the editor with header `delegate · <jobId> · <kind> · <model id>` (model once), task, live status and latest tool action. The transcript contains only a stable `accepted — card pinned above editor` receipt; expanding it may show the native session path, not a duplicate card. At terminal completion, remove the pinned card and finalize the original transcript row as `delegate · <kind> · <model id> · <jobId>` plus task/status/result. Do not stream activity in transcript rows. Generic activity and optional local `tg n/s` belong in pinned cards, never raw thinking fragments. Child command failures do not set the overall job status. No success-green host shell around a still-running background receipt.

Freeze the origin snapshot after acceptance: suppressing invalidation alone is insufficient because unrelated repaints read the snapshot again. Finalize and invalidate the origin row once at terminal completion, even after a background return or foreground timeout without collect. This avoids repeated screen/scrollback resets when live cards move above Pi's regular-mode viewport; completion may still cause one redraw. Release row callbacks on terminal/shutdown; observer failures must not affect child outcomes or accounting. Both render slots read shared result state at render time (Pi invokes renderCall before renderResult). Keep the first report text block unchanged; configured-capability and outcome data each use a separate bounded block.

Collapsed final cards show up to three rendered Markdown lines of the answer/error. Expand shows the full returned answer, task, last three tools and archive path for complete recorded history. Recording warnings stay visible. Host/validation errors without details fall back to result content. A `tool_result` hook marks `details.ok: false` as `isError: true` (Pi ignores `isError` returned directly by execute).

Collect/wait/peek/wrap/cancel rows are compact historical receipts, not duplicate cards/tool lists. Terminal receipts say result/failure collected; pending returned receipts explicitly say status was observed at the check. Errors still include a collapsed explanation. Expanded receipts can show the result and session path.

Persist terminal UI details once in `delegate-job-state` custom entries, excluded from model context. Restore the active branch from these entries and tool results via original tool-call identity. Never downgrade terminal state with a late pending result or attach old jobs to reused short IDs. Pending historical jobs with no live scheduler are labelled status unavailable. Persistence failures show a separate display warning without changing job outcomes; archives remain independent.

Pinned full-card stack while jobs are queued or running:

```
delegate · d0001 · review · hosted/model
Task: Review timeout and abort handling
● Running — reading file
→ read  delegate/jobs.ts
delegate  N run  M wait  local x/maxLocalConcurrent · ctrl+o details
```

Project only displayed metadata/tool fields into the panel state: no clocks, usage, raw thinking or hidden tool IDs. Preserve acceptance order, live activity/queue reason, local generation rate and wrap requests. Cap at 12 rows and half the terminal height. Reserve header/task/status where space permits, then latest tool/warning; Ctrl+O expands task and recent-tool details within the budget. Label undisplayed jobs as `+N more` with IDs. Truncate each rendered line to terminal width and degrade to compact header/status on tiny terminals. In TUI mount once, repaint only changed display state, hide while idle, and remove on shutdown. Do not repeatedly call `setWidget` (Pi deletes/reinserts its key). RPC receives deduplicated plain-card string arrays, bounded to ten rows and 100 columns; never factories.

In regular mode, group the existing top-level components in a native Container and insert spare rows before the above-editor widget container. Keep the panel and existing editor/footer bottom-aligned while a short transcript grows into scrollback. Render original components once per frame; preserve their identity, focus, ordering and invalidation. Measure the existing editor/footer and sibling widgets before rendering the card, reducing its height budget to leave a transcript row. Only flatten the native plain widget Container for this measurement; custom layouts use a conservative fallback. Do not patch the renderer, write terminal escapes, replace the editor/footer, or change Pi settings. Preserve the bottom after small shrinks, but do not retain pages of filler after large collapses or resizes. Fullscreen uses its own layout root. Hide padding while idle and unwrap on disposal/shutdown/reload, following Pi's stable TUI reference and preserving foreign roots/wrappers.

## Outcome observations

Keep worker status distinct from task assessment. Version-1 outcomes contain execution disposition, response-lifecycle state, observed limitations and optional bounded RPC evidence. Task assessment is always `not-performed`; never infer task/test success from prose, exit code, tools, message count or length. `done` remains a worker result, not a correctness verdict. Budget/response gaps do not rewrite earlier terminal causes; health/cleanup warnings stay separate.

Count finalized assistant `message_end` observations, including empty/error/intermediate messages, separately from retained phase responses and partial streams. Record task RPC write and native settlement flags, open response, unanswered delivered wrap and phase omissions. No new default retention/enforcement. Missing evidence from legacy/custom runners is unknown, not zero; metadata is not an inference count or proof of useful reports.

Detach outcome evidence and limit arrays at scheduler, receipt, archive and card boundaries. Snapshot terminal input before asynchronous recording. Drop malformed/unsupported restored claims and outcomes contradicting archive worker fields; rebuild must not invent missing evidence or overwrite source metadata. Use a separate ≤512-byte terminal block, qualify completion notices/cards, and report outcome coverage rather than task-success rates. Strip only exact separate trailing data blocks for rendering, never an ambiguous suffix in report prose.

## Configured capabilities

Capture the resolved kind's requested tools before launch; a model override must not grant or remove tools. Interpret selection exactly like Pi CLI (comma split, trim, ignore empty, case-sensitive names), not with wildcard/alias assumptions. This is `source: configured`, never a tool-readiness acknowledgement or command/test-availability claim. Expose listed shell and write/edit tools, unknown-name count and `filesystemSandbox: false`; read-only prompt intent is not write protection.

Bound the snapshot to 64 names of at most 128 encoded JSON bytes each, with explicit omissions and complete positive builtin declarations. Bound the separate parent-visible text block to 512 bytes without consuming the first report's cap. Keep data detached across admission, progress, collection, archive and card restoration. Drop unsupported/contradictory metadata without inventing legacy capabilities. Show it separately from evidence in expanded results; do not duplicate it when falling back to returned content. No tool schema/description, prompt, configured tools, default or model selection changes are part of this reporting feature.

## Shared local-delegation switch

`/delegate-local` uses the native `ctx.ui.select` dialog with a current ON/OFF label, active/draining count and marked current option first. Esc is a no-op. Support direct `on`, `off`, `status` and argument completion. A picker pending during shutdown must not mutate shared state afterward. Polling and footer resources begin only at session start and are disposed on shutdown; UI failures must not affect admission.

Use `<agent-dir>/delegate-local/`, independent of archive overrides. Persist an atomic, revisioned ON/OFF state (default ON). Apply to every local-model kind/override using the existing classifier; never alter hosted routing or model/prompt config. OFF refuses new local work before recording, holds accepted queued work without occupying slots, and allows admitted work to drain. Polling resumes queues on ON without a new tool call or reload. Cancellation/shutdown and queue bounds still apply to held jobs. Unreadable state fails closed for local dispatch, not hosted work.

Publish a unique active reservation before reading the switch for admission; release only after the runner has settled, including failure/cancellation cleanup. OFF status must either count an in-progress admission or prevent it from starting. Revision-check activity snapshots so a concurrent toggle cannot produce a false OFF/idle result from an older scan. Surface admission/cleanup errors without corrupting job outcomes or losing queue bounds. Do not silently expire reservations owned by dead parents: orphan children may still run. Unknown/dead-owner reservations preclude idle and require verified manual recovery. This is a per-user same-machine participating-client gate, not a cross-process concurrency limit or a server/GPU lock.

## Spawn

Reuse `../child-runtime/` for process/JSONL/truncate.

Always:

```
--mode rpc --session <unique-private-run-file> --no-extensions --no-skills --no-prompt-templates
--no-context-files --model --thinking --tools --system-prompt
```

`--offline` only when the agent config has `offline: true`.

Never `-p`, `--no-session`, `--continue`, `--fork`, `--append-system-prompt`. Default delegation has no explicit `--extension`; the opt-in runtime guard and benchmark guard below are exceptions. The child session must be a newly allocated run archive, never the parent session. Task is an RPC `prompt` on stdin, not argv.

Stdin JSONL (`\n` only, no Node `readline`): `prompt`, `steer` (wrap), `abort` (cancel). After `agent_settled`, close stdin so RPC exits. Dialog `extension_ui_request` → `cancelled: true`.

Correlated rejection of the initial RPC prompt (`id: p1`, `success: false`) is a terminal error: preserve its message, close stdin, terminate the child, and release the slot. Unrelated responses do not terminate the run. Keep the first terminal cause when errors, timeout, or abort race.

Preserve the last assistant message's provider error separately from its text and return the error before any partial answer. A successful retry replaces earlier errors. Model token-limit termination (`stopReason: "length"`) is a failure with an explicit incomplete-answer explanation, including thinking-only/empty answers. The explanation precedes partial text and is subject to the normal output cap. A natural completion shortened only by `maxOutputBytes` remains successful.

Build the completed model identifier from Pi's separate `message.provider` and `message.model` fields, without stripping slashes from a namespaced model ID. If either field is missing or empty, retain the last known identifier (initially the configured model).

The stdout reader bounds each LF-delimited record to 8 MiB, independently of `maxOutputBytes` and pipe chunk boundaries. Discard recognized oversized non-answer events (including cumulative transcripts and tool-result images); never silently discard an oversized assistant/control record or unknown layout. Those fail as `protocol-error` with an explicit limit message. Log discarded records as `oversized_event_skipped`. Final answer extraction joins all text blocks of the last assistant message in each delivered wrap phase in source order, excluding thinking/tools. Correlate sent wrap text with delivered user-message events; send time and RPC acknowledgement are not phase boundaries. Keep the preceding report and labelled follow-up separate, with assistant-event ordinals and task/wrap phase provenance. Do not select reports by length or wording. A retry replaces earlier errors within its phase; errors from the final phase precede all retained evidence. Empty/missing wrap-up output is explicit and failed. Preserve the no-wrap last-message contract.

Bound individual text/error snapshots at ingestion without mutating raw events. Keep at most eight phases (first plus latest seven), label omissions and preserve full native archives. Share the combined output budget so a long report cannot hide the follow-up; tiny caps must disclose truncation. Bound pending wrap-text correlation to 64 distinct digests and refuse excess distinct requests rather than silently lose provenance.

Opt-in library guarded execution (`RunPiChildInput.execution`, passed through by `runChild`) is separate from delegate config/default activation. Withhold the task until the private guard's readiness matches its nonce/version/builtin tool set. For an early wrap, acknowledge gate closure before task dispatch and steer only after dispatch. RPC command success is not enforcement acknowledgement. Use public builtin definition factories, preserving schemas and prompt metadata; check the finalization gate at actual tool-body entry, including prepared parallel calls. Drain active bodies; disallow fresh ones. This is not a filesystem/process sandbox.

Expose requested versus enforced `draining`/`answering` states, including acknowledged active counts, in events and result details. First request and grace deadline win; no reopening or increased active counts after acknowledgement. A process-start soft budget excludes queue/wait time and requests finalization. Enforce grace until process exit, including a shutdown grace after natural settlement; an independent stricter hard limit still wins. Kill/reap before releasing scheduler capacity. Preserve partial reports and bounded text-only open-stream evidence, labelling streams incomplete rather than finalized; never retain thinking/tool arguments as answer text. New failed stop reasons: `guard-error`, `finalization_timeout`, `execution_budget`, `incomplete-output`. Keep existing terminal-cause precedence. Guarded metadata invalidates legacy calibration snapshots/estimates, including reload/rebuild, without losing measured usage.

Env: `PI_DELEGATE_CHILD=1`, `PI_DELEGATE_CHILD_DEPTH=1`.

Child is `pi` (or `node <pi-script>`) plus those flags. Never a vendor CLI (`codex`, `claude`, …). On child end, append one JSON line to `~/.pi/agent/delegate.log` (`PI_DELEGATE_LOG=0` off, `PI_DELEGATE_LOG=/path` override). Record cmd/args, pid, hardTimeout/duration, exit, stopReason, JSONL event types, stderr. If assistant text is empty, tool result text is that dump.

## Durable accounting

Archive all accepted kinds, local and hosted, before queueing. Use private UUID directories under `<agent-dir>/delegate/runs` (`PI_DELEGATE_ARCHIVE_DIR` override). Keep native session JSONL, custom prompt, task, and atomic versioned metadata linking the original parent session and tool call. No automatic expiry, pruning, or storage-size eviction. Never store provider credentials/environment dumps. Refuse launches when recording cannot be established; surface later failures without hiding child outcomes.

Finalize once on every terminal path, including queued cancellation, thrown runners, and shutdown. Accounting's scheduler `onSettled` hook runs during shutdown even though notification `onTerminal` remains suppressed. Drop live meters when runs finish. Partial/unfinished provider usage remains flagged as a lower bound. Queued and running statuses are unfinished in reports/infobar; recovered queued records also carry incomplete usage, without marking the owner dead or changing its queued status. Do not infer that another process's unfinished run is dead, or modify its metadata during recovery.

Use normalized provider input/output/cache buckets, not character estimates. Streaming usage replaces the current pending turn; only finalized records add turns. Native entry IDs deduplicate reconstruction. Include reported failed attempts and compaction/branch-summary usage; never recount retainedTail copies or reasoning already included in output. Missing/all-zero usage is unknown, not free. Per-run metadata/native entries are authoritative; the append-only `usage.jsonl` export contains revisioned per-run snapshots and can be rebuilt without deleting old rows. Consumers choose the highest revision per run (last row on ties), so a delayed rebuild cannot supersede newer terminal state.

Use a separate `ctx.ui.setStatus("delegate-usage", ...)` entry: `delegated N · local N · saved —`, plus `!partial` for session-attributable gaps or `!archive` for errors whose session cannot be identified. Known other-parent errors must not contaminate session counters/reports. Totals are scoped to the originating parent session UUID, not active branch or short job ID. Restore on resume/reload, reset for a different session, clear on shutdown. Do not attach child usage to the parent's standard `usage` field. `saved` stays unavailable without matching calibration and known reference rates. Complete successful local runs may show `saved ~$X`, their calibrated hosted-child API-equivalent value; never claim measured net savings. `!estimate` marks partial coverage, separate from token/archive health. A local provider/model maps to a hosted reference and thinking level, never an automatic fallback. Snapshot validated profile and public rates per run; do not reprice history or backfill legacy records. Match both model IDs, kind, thinking levels, tools and custom prompt hash; reject newly selected profiles older than 90 days. Price each projected request using prompt/output ratios and alternative cache shares, including request-wide pricing tiers. Do not equate local KV hits with hosted cached input.

`/delegate-stats [session|today|all|rebuild]` displays a UI-only report with totals, runtime, outcomes, incomplete records and latest ten transcript paths. Today groups by creation time in local time. No model calls, transcript injection, or automatic continuation. Expanded tool results show archive paths; recording warnings remain visible when collapsed.

## Opt-in calibration runner

`bench/index.ts` is a separate, manually loaded extension, not a package entrypoint or parent tool. It runs fresh paired synthetic recon fixtures with explicit output path/spend approval, isolated copies, alternating order and strict outcome/scope scoring. No pre-existing results are imported. Preserve raw events, native sessions, public model/settings manifest, guard receipts and failed/partial evidence. Fit only mutually successful complete pairs (at least four distinct tasks) and publish no profile for an interrupted campaign; retain all failure/incompleteness diagnostics.

Only benchmark children explicitly load `bench/guard.ts`. They require a successful startup handshake before any prompt, conservative per-request API-metadata reservation, finalized usage accounting, request/time limits, no compaction and fail-closed termination on guard refusal. Ordinary hook exceptions are not a request veto. Unknown usage/spend stops the campaign; do not promise an invoice cap or a filesystem sandbox. Never toggle servers/fans or silently spend on calibration from normal delegation/stats. Document profile settings, failure rates, sample count, observed variation, API cache assumptions and coverage.

## Tests

`xvfb-run -a npm test` (unit + offline CLI load/UI checks on Linux). `npm run test:unit` does not need Pi.

Pi unit children and termination are mocked; never send OS signals for fake PIDs. Linux capacity tests may spawn/stop their own offline Node fixtures, never model workers or unrelated processes. CLI smoke uses temporary configuration with no user overlay or credentials, loads the package through the installed CLI, and exercises renderers without model requests. Do not deep-import private unbundled Pi loaders.

Runtime regressions cover prompt rejection and slot release, signal isolation, multi-block answers, per-record/chunk framing, UTF-8/CRLF, large useful records, skipped transcripts/images, explicit bounded failure for oversized useful/junk records, provider errors ahead of partial output, token-limit failures, and qualified model identities. Wrap regressions cover report/steering races, acknowledgements, shorter corrections, repeated wrap phases, empty/missing/error replies, successful retries, abort/protocol failure, bounded retention and caps that reserve follow-up space. The factory result probe passes a real runtime-produced mocked wrap result through foreground and collection paths.

Guard regressions cover startup withholding, early/repeated controls, acknowledgement rejection/loss, preflight/body races, active drain, budget/grace/hard deadlines, cancellation, incomplete streams, stale controls, held occupancy until closure, and cleanup. An offline real-Pi probe checks private guard startup, early finalization acknowledgement, preserved builtin metadata, drained shell work and blocked prepared writes without sending a task or making a model call.

Shared-capacity regressions use independent processes and different working directories, distinct groups/model IDs, parent death and inherited-child occupancy, stable inode reuse, live-capacity conflicts, metadata loss, unsafe permissions/symlinks and missing locking support. Scheduler tests cover queue bounds/FIFO, hosted/independent-group bypass, parent-local limits, acquisition/release errors, reentrant observers, held occupancy until runner closure and poll cleanup. An offline real-Pi probe releases the parent descriptor after verified startup, confirms the child still blocks another acquisition, then verifies release on child closure; it stops before task dispatch/model requests.

Lifecycle regressions verify that success, failure, thrown runners, cancellation, and shutdown release runner/control references while snapshots remain collectible. Accounting regressions cover native session compatibility, live/footer and resume behavior, multi-turn/cached/retry/compaction totals, missing usage, duplicate collects, crash tails, queued cancellation, concurrent processes, private permissions, write failures and non-expiring retention. CLI probes keep RPC stdin open until asynchronous command completion, then close it.

UI regressions cover collapsed result previews, model-once headers, no raw thinking, narrow widths, frozen live transcript rows and terminal finalization without collect, receipt non-duplication, terminal callback release, cancellation, UI persistence failure, branch/reload restoration and reused short IDs. Mount the widget as a real sibling above the editor and drive scheduled regular-mode repaints with off-screen launch rows to assert live progress does not clear scrollback. Verify full-card identity/task/status/tool content in the dock, bounded Unicode widths, overflow, expansion and idle height changes there. Assert no duplicate live transcript card and transfer to a finished transcript card at completion. Exercise tall inputs, sibling widgets and resize while idle. Also assert actual viewport-relative panel/footer rows from a short transcript through growing parent output, small shrink, terminal resize and idle/reuse; checking only repaint counts misses a floating panel. Verify editor focus and component-tree restoration. Keep Pi-free layout tests for single-pass rendering, bounded shrink padding, fullscreen passthrough, renderer replacement and cleanup with dead UI callbacks. Pi-free unit tests must cover one mount, thinking-only update deduplication, idle/reuse, RPC string fallback, and dead UI observers. CLI lifecycle probes inject a mock child runner, never a real worker or model request.

Scheduler tests: local jobs never overlap at `maxLocalConcurrent: 1`; hosted is not blocked by the GPU queue; fg wait budget includes queue time; quiet wait does not kill; wrap steers / queued wrap cancels; promoteBackground detaches Esc; hard timeout optional; shutdown drops queue.

Local-control tests cover persistent defaults/toggles, native picker selection/cancellation, direct commands, cross-process visibility and counts, reservation/admission races, concurrent-toggle snapshots, held queue wakeup, hosted independence, model overrides, lifecycle cleanup, crash uncertainty, store failures, queue bounds after admission failure, UI observer failures and polling/picker shutdown. Use isolated temporary stores and mock runners; never benchmark or call real models.

Notify tests: exactly-once terminal notice; wait/peek of terminal suppresses; running peek does not; success display false; failure display true; preview clip; no-UI/print no send; shutdown no send; onTerminal throw does not break scheduler; busy parent defers send; collect during busy suppresses; isBusy throw still sends.

## Stop

- Do not edit agent instruction files.
- If tests fail, fix them. If you cannot, stop and report.
