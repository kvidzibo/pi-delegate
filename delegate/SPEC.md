# delegate — implementation contract

One routing tool. Four named agents. Child model is config. No nesting. Do not add a second parent tool.

## Goal

One routing tool. Four named agents. Child model is config (any Pi model id). No nesting.

Background spawn returns `jobId` immediately. Local/GPU children share `maxLocalConcurrent` (queue, do not overlap). Hosted children use `maxConcurrent` only. Do not start/stop GPU servers.

## Layout

```
delegate/
  README.md SPEC.md config.json
  index.ts config.ts spawn.ts display.ts view.ts tg.ts jobs.ts notify.ts
  prompts/{recon,implement,review,oracle}.md
  tests/{config,spawn,display,tg,jobs,notify}.test.ts
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

One child per call. No nesting (`PI_DELEGATE_CHILD`).

Foreground spawn waits for a slot (parent blocked). Local foreground also takes the local slot.

Foreground `timeoutMs` expiry auto-promotes the job to background, detaches parent Esc, and returns a short nonterminal check-in (`terminal: false`, `jobId`, last tools, `quietForMs`). No thinking tail. Slot remains held. Parent continues with `jobId`, `wrap`, or `cancel`.

Collect waits until terminal, wait budget, or `checkIntervalMs` with no child events. 60s sampling is internal and must not add parent-token receipts while the child is making progress.

`session_shutdown` aborts running jobs and drops the queue. Do not notify for shutdown-induced aborts.

Background completion notice (interactive TUI/RPC only): after the final snapshot, hold ~200ms. If the parent agent is still running (`ctx.isIdle()` false), keep holding — do not `sendMessage` yet. `sendMessage` queues a follow-up that collect cannot unsend. Once idle and not consumed, `pi.sendMessage` `{ deliverAs: "followUp", triggerTurn: true }`. Preview only; `jobId` remains the full result. Success `display: false`; failure `display: true`. Print/JSON stays pull-only. At most one notice per job. Collecting a terminal snapshot cancels it, including mid-turn collect after the job already finished.

Header: `delegate  <kind> → <alias>  <model id>` + `bg <jobId> <status>` when background/collect + live `tg n/s` when child model looks local + live thinking tail.
Under it: last 3 finished tools, then one live row. Expand shows child answer, or task when still queued/running. Final errors show up to three non-empty explanation lines even when collapsed, with the full error on expansion. Fall back to result content for host/validation errors without details. A `tool_result` hook marks this tool's `details.ok: false` as `isError: true`, preserving structured results (Pi ignores `isError` returned directly by `execute`).

Sticky widget while jobs are queued or running:

```
delegate  N run  M wait  local x/maxLocalConcurrent
  run   <id>  <kind> → <alias>  …
  wait  <id>  <kind> → <alias>  gpu
```

## Spawn

Reuse `../child-runtime/` for process/JSONL/truncate.

Always:

```
--mode rpc --no-session --no-extensions --no-skills --no-prompt-templates
--no-context-files --model --thinking --tools --system-prompt
```

`--offline` only when the agent config has `offline: true`.

Never `-p`, `--session`, `--continue`, `--fork`, `--extension`, `--append-system-prompt`. Task is an RPC `prompt` on stdin, not argv.

Stdin JSONL (`\n` only, no Node `readline`): `prompt`, `steer` (wrap), `abort` (cancel). After `agent_settled`, close stdin so RPC exits. Dialog `extension_ui_request` → `cancelled: true`.

Correlated rejection of the initial RPC prompt (`id: p1`, `success: false`) is a terminal error: preserve its message, close stdin, terminate the child, and release the slot. Unrelated responses do not terminate the run. Keep the first terminal cause when errors, timeout, or abort race.

The stdout reader bounds each LF-delimited record to 8 MiB, independently of `maxOutputBytes` and pipe chunk boundaries. Discard recognized oversized non-answer events (including cumulative transcripts and tool-result images); never silently discard an oversized assistant/control record or unknown layout. Those fail as `protocol-error` with an explicit limit message. Log discarded records as `oversized_event_skipped`. Final answer extraction joins all text blocks of the last assistant message in source order, excluding thinking/tools.

Env: `PI_DELEGATE_CHILD=1`, `PI_DELEGATE_CHILD_DEPTH=1`.

Child is `pi` (or `node <pi-script>`) plus those flags. Never a vendor CLI (`codex`, `claude`, …). On child end, append one JSON line to `~/.pi/agent/delegate.log` (`PI_DELEGATE_LOG=0` off, `PI_DELEGATE_LOG=/path` override). Record cmd/args, pid, hardTimeout/duration, exit, stopReason, JSONL event types, stderr. If assistant text is empty, tool result text is that dump.

## Tests

`xvfb-run -a npm test` (unit + offline CLI load/UI checks on Linux). `npm run test:unit` does not need Pi.

Unit children and termination are mocked; never send OS signals for fake PIDs. CLI smoke uses temporary configuration with no user overlay or credentials, loads the package through the installed CLI, and exercises renderers without model requests. Do not deep-import private unbundled Pi loaders.

Runtime regressions cover prompt rejection and slot release, signal isolation, multi-block answers, per-record/chunk framing, UTF-8/CRLF, large useful records, skipped transcripts/images, and explicit bounded failure for oversized useful/junk records.

Scheduler tests: local jobs never overlap at `maxLocalConcurrent: 1`; hosted is not blocked by the GPU queue; fg wait budget includes queue time; quiet wait does not kill; wrap steers / queued wrap cancels; promoteBackground detaches Esc; hard timeout optional; shutdown drops queue.

Notify tests: exactly-once terminal notice; wait/peek of terminal suppresses; running peek does not; success display false; failure display true; preview clip; no-UI/print no send; shutdown no send; onTerminal throw does not break scheduler; busy parent defers send; collect during busy suppresses; isBusy throw still sends.

## Stop

- Do not edit agent instruction files.
- If tests fail, fix them. If you cannot, stop and report.
