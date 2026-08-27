# delegate — implementation contract

One routing tool. Four named agents. Child model is config. No nesting. Do not add a second parent tool.

## Goal

One routing tool. Four named agents. Child model is config (any Pi model id). No nesting.

## Layout

```
delegate/
  README.md SPEC.md config.json
  index.ts config.ts spawn.ts display.ts view.ts tg.ts
  prompts/{recon,implement,review,oracle}.md
  tests/{config,spawn,display,tg}.test.ts
```

Repo root has `package.json` (`pi.extensions: ["./delegate"]`). This directory has no package.json.

User overlay: `~/.pi/agent/delegate.json` merged onto shipped `config.json`. Missing overlay is fine.

## Tool

Name: `delegate`  
Label: `Delegate`  
Description must say: named agents, model from config, no nesting.

| Field | Required | Rules |
|---|---|---|
| `task` | yes | non-empty, max `maxTaskChars` |
| `kind` | yes | `recon` \| `implement` \| `review` \| `oracle` |
| `cwd` | no | existing directory |
| `timeoutMs` | no | integer, passed through to the child |
| `model` | no | any Pi model id. Kind keeps tools/prompt/thinking/offline. |

No model allowlist. No fallback chain. No GPU/process manager.

One child per call. No nesting (`PI_DELEGATE_CHILD`).

Header: `delegate  <kind> → <alias>  <model id>` + live `tg n/s` when child model looks local + live thinking tail.
Under it: last 3 finished tools, then one live row. Expand shows child answer.

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

## Stop

- Do not edit agent instruction files.
- If tests fail, fix them. If you cannot, stop and report.
