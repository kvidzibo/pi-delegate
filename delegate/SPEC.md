# delegate — implementation contract

One routing tool. Four named agents. Child model is config. No nesting. Do not add a second parent tool.

## Goal

One routing tool. Four named agents. Child model is config (any Pi model id). No nesting.

Background spawn returns `jobId` immediately. Local/GPU children share `maxLocalConcurrent` (queue, do not overlap). Hosted children use `maxConcurrent` only. Do not start/stop GPU servers.

## Layout

```
delegate/
  README.md SPEC.md config.json
  index.ts config.ts spawn.ts display.ts view.ts tg.ts jobs.ts
  prompts/{recon,implement,review,oracle}.md
  tests/{config,spawn,display,tg,jobs}.test.ts
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
| `timeoutMs` | no | spawn: child timeout (starts when process starts, not while queued). `jobId`: wait budget. `0` with `jobId` = peek |
| `model` | no | any Pi model id. Kind keeps tools/prompt/thinking/offline. |
| `background` | no | `true` = return `jobId` now; child keeps running. Parent Esc does not kill it |
| `jobId` | collect | wait or peek. Cannot combine with `background` |

No model allowlist. No fallback chain.

`maxConcurrent` = max running children (local + hosted).  
`maxLocalConcurrent` = max running local children (`isLocalModel`).  
`maxQueued` = max jobs waiting for a slot. Overflow refuses.

Eligible-first FIFO: a hosted job may start while a local job waits on the GPU slot.

One child per call. No nesting (`PI_DELEGATE_CHILD`).

Foreground spawn waits for a slot (parent blocked). Local foreground also takes the local slot.

`session_shutdown` aborts running jobs and drops the queue.

Header: `delegate  <kind> → <alias>  <model id>` + `bg <jobId> <status>` when background/collect + live `tg n/s` when child model looks local + live thinking tail.
Under it: last 3 finished tools, then one live row. Expand shows child answer, or task when still queued/running.

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
--mode json -p --no-session --no-extensions --no-skills --no-prompt-templates
--no-context-files --model --thinking --tools --system-prompt
Task: <task>
```

`--offline` only when the agent config has `offline: true`.

Never `--session`, `--continue`, `--fork`, `--extension`, `--append-system-prompt`.

Env: `PI_DELEGATE_CHILD=1`, `PI_DELEGATE_CHILD_DEPTH=1`.

## Tests

`npm test` (unit + factory load). `npm run test:unit` does not need Pi.

No live child. Factory-load smoke must pass without a user overlay.

Scheduler tests: local jobs never overlap at `maxLocalConcurrent: 1`; hosted is not blocked by the GPU queue; child timeout starts at spawn; shutdown drops queue.

## Stop

- Do not edit agent instruction files.
- If tests fail, fix them. If you cannot, stop and report.
