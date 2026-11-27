# Delegate

The extension provides the `delegate` tool, Roles editor, model picker, job controls and usage reports. Start with the [project README](../README.md) for installation, roles and safety limits; see [migration notes](../MIGRATION.md) when upgrading.

## Configuration

Shipped roles use hosted `openai-codex` models; configure a role to use a local model.

| Role | Model | Reasoning |
|---|---|---|
| `recon` | `gpt-6-luna` | `off` |
| `implement` | `gpt-6.1-sol` | `medium` |
| `review` | `gpt-6.1-sol` | `high` |
| `oracle` | `gpt-6-astra` | `high` |

Models come only from role configuration, for every role including reviews: the `delegate` tool rejects any `model` argument, even null or blank. Unavailable models are never replaced automatically.

### Menus

**`/pi-delegate roles`** edits every role field listed below. Short choices cycle inline. **Save role** persists; Esc discards the draft. **Add named role** requires an explicit available model and a nonblank prompt, and starts with tools `[]`, extensions `false` and reasoning `off`.

**`/pi-delegate models`** is a model-first picker followed by reasoning. It saves model and reasoning separately; Roles saves them together.

**Role check.** Both menus start the role once before saving a change to its model, reasoning, speed, tools or extensions, or when a role is added or re-enabled. The check sends one short prompt to the real provider through the normal job queue, so it uses a small amount of provider allowance and waits behind running local jobs. Esc cancels it and saves nothing. If the role does not answer, the menu shows the error and offers **Do not save** or **Save anyway**. Disabled roles and other edits are not checked.

- Model choices match `/model`: scoped models first when a scope is set, with **Tab** switching between scoped and all available models.
- Reasoning offers Pi's supported levels (including `xhigh`/`max` where supported); non-reasoning models offer only `off`.
- Saves preserve the complete user overlay and reject disk conflicts, unavailable models and uncertain catalogues.
- Saves apply to future jobs in this session; queued and running jobs keep their acceptance-time policy. Other sessions need `/reload`.

### Manual configuration

Add or override roles in `~/.pi/agent/delegate.json`, not in the installed package. [Shipped defaults](config.json) include the four starter roles and their full prompts. Replace `provider/model` with an available Pi model ID:

```json
{ "agents": {
  "recon": { "prompt": "Inspect the requested paths without editing.\nCite file:line evidence." },
  "writer": { "model": "provider/model", "prompt": "Write only the requested documentation. Report changed files." }
} }
```

Role names match `[a-z][a-z0-9_-]{0,63}`. New roles require nonempty `model` and `prompt` strings; a prompt replaces the entire role system prompt.

| Field | Default for a new role |
|---|---|
| `enabled` | `true`; `false` refuses new jobs |
| `tools` | All Pi tools (`["*"]`); `[]` disables tools |
| `extensions` | `false`; `true` enables normal Pi extension discovery, including configured MCP support. With `false`, a model whose provider is registered by an extension still loads that one extension (see [Extension providers](#extension-providers)) |
| `thinking` | `off` |
| `speed` | `standard`; `fast` or `ultrafast` requests an OpenAI Codex service tier (see [Speed](#speed)) |
| `responseTemplate` | Empty/omitted: unchanged response instructions |
| `responseSchema` | Omitted/`null`: no validation; a draft-07 object or boolean enables JSON validation |
| `responseRepairAttempts` | `2`; integer `0`–`2`, additional attempts after the initial response |
| `saveToFile` | `false`: return the response inline |
| `completionHook` | Omitted/`null`: disabled; `{ command: [...], timeoutMs: 10000 }` runs after termination |

- Omitted overlay fields inherit the existing role's values. Tool arrays replace rather than extend; shipped roles keep their explicit tool restrictions unless overridden.
- `extensions: true` can execute installed/configured extension code and expose additional tools. Skills, prompt templates and context-file discovery always stay disabled.
- Providers available only through parent extensions need separate child configuration or `extensions: true`.
- Invalid configuration prevents loading. Manual edits require `/reload` or a restart; **reload stops outstanding children**. Accepted jobs keep their original prompt and policy.

Delegation does not add `--offline` or change Pi's inherited `PI_OFFLINE` setting. Set `PI_OFFLINE=1` to suppress automatic networking such as model-catalogue refreshes; this does not block model requests or tools' network access.

### Extension providers

Some providers are registered by a Pi extension rather than built in or listed in `models.json`, for example `claude-bridge/…` from `pi-claude-bridge`. A role with `extensions: false` would otherwise start without that provider and fail with "Model not found".

Before the first such launch in a session, delegate starts a short Pi process that loads your configured extensions without starting a session and records which file registers each provider. A child whose model uses one of those providers gets that file as its only extra `--extension`. Limits:

- The extension runs whole in the child: its hooks apply, and any tools it registers are available if the role's `tools` allow them.
- Providers that an extension registers only after a session starts are not found. Set `extensions: true` for such a role.
- If the lookup fails, the child starts as before and reports the missing model.

### Speed

`fast` and `ultrafast` apply only to supported `openai-codex` models with ChatGPT sign-in; otherwise jobs run at standard speed. Both use more of your plan allowance; see OpenAI's [Fast and Ultrafast modes](https://learn.chatgpt.com/docs/agent-configuration/speed).

| Speed | Service tier | Models |
|---|---|---|
| `fast` | `priority` | All `openai-codex` models |
| `ultrafast` | `ultrafast` | GPT-6.2 Astra/Sol, GPT-6.1 Sol, GPT-6 Astra; eligible plans only |

- **Set speed for all Codex roles…** in the role list writes one speed into every `openai-codex` role in a single save. It changes no models, so it skips catalogue checks; roles stay individually editable.
- Changing a role's model in `/pi-delegate` resets a speed the new model lacks to `standard`. The role list marks unsupported speeds left by manual edits as inactive.
- A private child extension adds the tier to the child's own model requests, even with extension discovery disabled. The child re-checks the model and ChatGPT sign-in before each request.
- Job cards and run metadata record the speed requested at acceptance, shown after reasoning. The backend reports `default` even when Fast applies, so the tier is not confirmed, and cost reports count these jobs at standard rates.
- A model or plan without the requested tier may run at standard speed without an error, as observed for Ultrafast without plan eligibility. If the backend rejects a request, such as an unsupported tier name, the job fails with the provider error; Pi retries only transient provider failures.

### Limits and local capacity

Defaults are **8 running jobs, 1 local worker and 16 queued jobs per parent**; these are configurable. Local providers are `local-qwen*`, `llama.cpp` and `ollama`. Hosted work can proceed while local work waits.

Participating sessions sharing an agent directory also share **one local worker across all local providers**, independent of model ID and archive path. Raising `maxLocalConcurrent` does not raise this shared limit.

- Shared capacity requires Linux and `/usr/bin/flock`; unavailable or unsafe coordination fails closed for local work, not hosted work.
- Private lock files live under `<agent-dir>/delegate-capacity/`; never remove them while clients may be running.
- The child verifies and retains an inherited lease until it exits, including after parent death. This adds a startup check, not tool restrictions, runtime limits or enforced wrap-up.
- Reload older participating sessions to coordinate; unrelated server clients are not covered.

## Automatic checkpoints

**`/pi-delegate checkpoints`** configures periodic, text-only advice for the main agent. Default: off, role `goldfish`, every 10 rounds. The menu offers 10/20; manual `checkpoints.interval` accepts integers 1–1000.

```json
{ "checkpoints": { "enabled": true, "role": "goldfish", "interval": 10 } }
```

The advisor role is not shipped: create it in **Roles** first. It must be enabled with `tools: []` and `extensions: false`; no role or model is created or substituted. Save applies to future checks and persists globally; other sessions need `/reload`.

**Privacy/cost:** opting in sends conversation and tool excerpts to the advisor's provider and records them in the private, indefinitely retained delegate archives. Excerpts may contain secrets; there is no guaranteed redaction. Each check incurs the role's normal model cost and latency.

- **Counting:** a round is one assistant response with tool calls; parallel tools and a `codemode` batch count once. Failed tool attempts count; delegate waits/peeks do not. Mixed or incompletely recorded batches count conservatively. All tool-using work counts, not just implementation.
- **Packet:** recent request/clarification text, tool calls/results, assistant statements and previous checkpoint feedback from the current model-visible session, respecting context edits and compaction. It is capped at 20,000 characters or `maxTaskChars`, whichever is smaller, with labelled omissions, and excludes thinking, images, system prompts and tool-result metadata.
- **Evidence limits:** the advisor does not discover repositories, read referenced files or collect diffs. Its evidence can be incomplete, particularly after compaction.
- **Feedback:** the main agent waits for the advisor, then feedback appears in the transcript and main-agent context, capped at 6,000 characters; saved-to-file replies are read by the harness for delivery. It is unverified advice, not authorization, mandatory acknowledgement, a final review or proof the agent acted on it.
- **Failure:** missing, disabled or incompatible roles and advisor failures produce an unavailable message, and normal work continues. Checks wait up to `defaultTimeoutMs` including queue time, then request cancellation. There is no retry.
- **Lifecycle:** the counter resets when the main agent settles and follows the active session branch across reload/resume. An interrupted check is not replayed. Parent cancellation/shutdown cancels the advisor. Child agents never run checkpoints.

Active checks appear in Jobs; usage is included in Stats.

## Response templates and files

`responseTemplate` is free-form text appended to the role's system prompt as final-response instructions. Markdown headings and tables work; there is no placeholder substitution or enforcement. Blank text disables it.

```json
{ "agents": { "review": {
  "responseTemplate": "Use one row per finding; if none, say No findings. Do not invent resolutions or commits.\n\n| # | Severity | Finding | Resolution |\n|---|---|---|---|\n| 1 | High | <finding> | <actual resolution or unresolved> |",
  "saveToFile": true
} } }
```

`saveToFile` works independently of the template or schema. After a worker finishes, the harness (not the worker) writes the returned text to a unique private `pi-delegate-result-*` directory under the OS temporary directory, as `response.json` for validated JSON and `response.md` otherwise.

- The parent receives the path instead of the body, also as `details.responseFile`; repeated collection returns the same path.
- Nonempty failure/partial results are saved too, without changing their failure status. Empty results produce no file. A save failure reports a warning and falls back to inline text.
- Without a schema, files include wrap follow-ups and truncation notices; the `maxOutputBytes` limit still applies. Native session archives retain recorded history.
- Directories are `0700` and files `0600`. The extension never deletes them, but OS cleanup may; copy important reports elsewhere.

All response settings are captured when the job is accepted.

## JSON Schema validation

In **Roles → Response schema**, paste a complete JSON Schema. Syntax and schema errors keep the text for correction; Esc cancels. Empty text disables validation (`responseSchema: null`). **Repair attempts** cycles through 0, 1 and 2. For manual configuration:

```json
{ "agents": { "review": {
  "responseSchema": {
    "type": "object",
    "properties": {
      "summary": { "type": "string" },
      "issues": { "type": "array", "items": { "type": "string" } }
    },
    "required": ["summary", "issues"],
    "additionalProperties": false
  },
  "responseRepairAttempts": 2
} } }
```

- **Schema support:** requires Pi 1.5.0+. Ajv uses strict draft-07 validation, all errors and standard `ajv-formats` formats, without coercion, defaults or property removal. Self-contained `$ref` references work; unresolved external references, async schemas and unsupported keywords/drafts are rejected. `false` rejects everything; use `null` to disable an inherited schema.
- **Template:** the schema replaces template instructions while enabled, without deleting the saved template. The model must return one JSON value without fences or prose.
- **Repairs:** validation runs before truncation/saving. Invalid or oversized output gets precise feedback in the same child session, with tools disabled and calls blocked; a tool call during repair fails the job. Repairs share the original time limit, capacity slot and usage accounting. Cancellation, provider errors and token-limit failures are not retried as format errors.
- **Result:** the parent independently checks the final response. Only the latest validated JSON is returned, including after a wrap request; earlier attempts remain in the native session.
- **Failure:** exhausted repairs, missing settlement or JSON above `maxOutputBytes` fail with `response-format` and bounded diagnostics; truncated JSON is never returned as success. Failure diagnostics save as `response.md`. If saving fails, validated JSON stays inline with a separate warning.
- **Snapshot:** schema, retry count and output limit are saved privately at acceptance in `response-format.json` beside the archived prompt.

Validation establishes structure, not truth or task completion. Schemas are trusted user configuration, not a sandbox.

## Completion hooks

Each role, including custom and checkpoint roles, can run an executable after every job. No hooks are shipped or enabled automatically. Manual configuration:

```json
{ "agents": { "review": { "completionHook": {
  "command": ["/absolute/path/to/review-script", "--configured-argument"],
  "timeoutMs": 10000
} } } }
```

In **Roles → Completion hook**, paste only the inner `{ "command": …, "timeoutMs": … }` object. Empty text or `null` disables it; invalid input stays editable.

The executable path must be absolute. Arguments are literal: no shell, interpolation, tilde expansion or command splitting. Use an executable script with a shebang, or an absolute interpreter path followed by the script path. Timeout defaults to 10 seconds; the allowed range is 1–300,000 ms.

**Authority:** saving a hook authorizes that executable for every accepted job of the role, including failures, queued/running cancellation and shutdown. It runs in the job's cwd with Pi's permissions and inherited environment, independently of the child's tool restrictions. Only configure trusted scripts. Model responses and repository contents are untrusted data; never evaluate them as commands or infer publication destinations or permission from their prose.

### Input

The hook receives one version-1 JSON value followed by a newline on stdin:

| Field | Meaning |
|---|---|
| `version`, `event` | `1`, `"delegate.completed"` |
| `runId`, `jobId`, `role` | Durable run UUID, session-local job ID, configured role |
| `status`, `stopReason`, `exitCode`, `outcome` | Worker disposition, not task correctness; cancelled workers have `failed` / `aborted` |
| `model`, `requestedModel`, `reasoning` | Observed/result model, configured model and accepted thinking level |
| `cwd`, `durationMs` | Job directory and archived worker duration, excluding the hook |
| `parentSessionId`, `toolCallId` | Originating session and invocation |
| `paths` | Archive `dir`, `metadata`, `session`, `prompt`, `task`; optional saved response as `response` (otherwise null) |
| `recordingError` | Recording warning or null |
| `response.text` | Returned response or failure diagnostics; empty when no response exists |
| `response.schemaValidated` | True only for successful, schema-validated JSON |
| `response.json` | Parsed JSON, present only when `schemaValidated` is true |

Hooks work without **Save to file** or a response schema. A `done` status or validated schema is not a review approval.

### Execution and delivery

- **Asynchronous:** worker capacity is released before the hook starts, and collection can return **Completion hook: running**; collect again for its final status.
- **Status:** `succeeded`, `failed` or `timed_out` appears separately in receipts, cards and archived metadata, and never changes worker status or response text.
- **Output:** stdout is discarded; the last 4 KiB of stderr is kept in hook metadata. Do not print secrets.
- **Timeout:** kills the hook process group on POSIX (the direct process on Windows). Scripts should finish their work before exiting, not launch background services.
- **Shutdown:** shutdown/reload waits for pending hooks, up to their timeout. Cancellation does not undo hook side effects.
- **Delivery:** at most once per accepted job in the current process, with no retries or replay on reload; rejected jobs run no hook. Crashes can prevent delivery or leave an uncertain external outcome, so this is not a durable queue or exactly-once guarantee. Use `runId` for script-side deduplication.
- **Archive:** the accepted configuration and stdin payload are saved privately as `completion-hook-config.json` and `completion-hook-input.json` beside `metadata.json`.

Targeting, rendering and publication belong in the script; pi-delegate does not discover PRs or publish comments. The [review-comment example](../examples/review-comment/README.md) saves review history and a Markdown comment draft without publishing.

## Task handoff

Keep the task self-contained. Optional headings inside the `task` string:

```text
Goal: requested change
Allowed files: editable paths, including any new files/directories
Acceptance criteria: observable requirements
Validation: exact commands; existing tests may be outside the edit list
Setup/dependencies: permitted reversible setup and prerequisites, or none
Documentation: relevant instructions and docs to read/update
Stop rules: scope limits and concrete conditions to report
```

These are task-text conventions, not tool arguments. File ownership limits edits, not execution of authorized tests. Explicitly authorize new directories, setup and any isolated Pi integration tests; test processes must use temporary configuration and must not delegate work or make model requests. The shipped implementer and reviewer permit these tests; recon and oracle prohibit extra Pi processes.

The implementer reports completed/remaining requirements, changed files, checks actually run with results, unrun checks with reasons, and concrete blocker evidence. Treat this as a child-reported checklist, not parent-verified correctness.

Custom `prompt` overrides replace the shipped prompt and do not inherit its checklist, test permissions or review guidance.

## Reviews

Reviews use the configured `review` model. Tasks are dispatched without automatic diffs or prepared context: supply requirements, acceptance criteria, exact diff/artifact paths and scope, relevant repository constraints, and permitted validation commands.

Keep independent first-pass handoffs neutral: omit requests for approval, implementer self-assessments and other reviewers' verdicts. For fix verification, include the prior finding and reproduction, but require independent reassessment. The shipped reviewer prompt treats explanations and claimed results as unverified and checks for counterevidence before reporting defects; no findings remains a valid outcome. These are prompt conventions, not enforced blindness or proof of unbiased review.

`review` defaults to `read`, `grep`, `find`, `ls` and `bash`, without `write` or `edit`. Read-only behavior relies on its prompt, not shell write protection. Explicitly authorized checks may create and clean up temporary test files but must leave project files unchanged; `--offline` alone does not prevent model requests.

## Cross-extension busy query

Extensions may query delegate activity with `pi.events.emit('delegate:query-busy', { reply: busy => ... })`. The reply is synchronous: `true` means shutdown is underway, queued/running delegate jobs exist or a completion hook is pending. If no listener responds, availability is unknown; fail closed and treat delegate as busy. Invalid payloads are ignored.

## Job lifecycle

```json
{ "kind": "recon", "task": "Find test files and test commands; report paths and do not edit." }
```

Spawning requires non-empty `kind` and `task`. Spawns default to `background: true` and return a job ID immediately; `background: false` waits for completion or the initial `timeoutMs` budget. Optional `cwd` selects an existing directory, relative to the parent's cwd. Null, empty and whitespace-only optional arguments count as omitted; `false` and `0` keep their meanings.

| Action | Arguments |
|---|---|
| Wait / collect | `{ "jobId": "d0001" }` |
| Peek | `{ "jobId": "d0001", "timeoutMs": 0 }` |
| Request wrap-up | `{ "jobId": "d0001", "wrap": true }` |
| Cancel | `{ "jobId": "d0001", "cancel": true }` |

- **Waiting:** `timeoutMs` is a wait budget, **not a kill timeout**; foreground expiry leaves the child running in the background. Each collection starts a fresh quiet interval (60 seconds by default) that child events restart. `quietForMs` reports actual child inactivity, not time spent waiting. Completion notices are previews only; collect again for the final result.
- **Wrap:** advisory. It asks the child to finish without interrupting its current turn or tools; wrapping a queued job cancels it. For a suspected stall, wrap, wait again, then inspect a fresh peek before cancelling. Silence alone does not prove a stall.
- **Stopping:** cancel stops the child, and shutdown stops all outstanding jobs. The `hardTimeoutMs` setting limits runtime; `0` (default) disables it.
- **Parent interrupt:** **Esc interrupting the parent cancels all its running and queued delegates**, including background jobs and jobs from earlier turns, and suppresses their completion notices. An interrupted foreground wait is not promoted to background. Until child cleanup finishes, receipts report `cancellationRequested: true`, remain nonterminal and retain capacity. Normal parent completion, wait timeouts and dismissing a menu with Esc leave background jobs running.
- **Limits:** timer arguments and configuration must not exceed 2,147,483,647 ms.

## Results and history

Compact cards and receipts read `d0001 · implement · ● Running · Luna · high · 1m 23s`: job ID, role, status, model alias, thinking level and runtime (or `queued 12s`). **Ctrl+O** expands the full model, output, recent tools and archive paths.

- **Finished cards** keep the recorded duration and say `needs validation`: the parent must check the result. Finished and cancelled cards are neutral; failures are red. Failed/cancelled rows show the task and last recorded tool.
- **Previews:** tasks wrap to two lines with an ellipsis; clipped results show the hidden line count. Saved-response paths appear only when expanded.
- **Timing:** completed results expose `durationMs` and a readable `Duration` (for example `4m 36s`), matching the archived `metadata.json`. It excludes queue wait and is zero if cancelled before starting; use archived timing when a result is unavailable. Check receipts freeze elapsed runtime (or queue time) and, after the first check, the interval since the previous one.
- **Generation rate:** running cards show an approximate `~tg 42.0/s`; finished headers and stats show the run average. Local models are timed from the first generated token. Hosted models are timed from the start of each reply, which includes network and prompt-processing time, so treat the rate as a lower bound; it stays low during hidden reasoning.
- **Receipts:** returned answers are capped; inspect the native session for more. Capability receipts describe configured tools, not verified availability or sandboxing. Outcome receipts describe execution, not task correctness.

| Command | Shows |
|---|---|
| `/pi-delegate jobs` | Live, scrollable view of every active/queued job and its full task |
| `/pi-delegate summary` | Transcript table of this session's runs in launch order: job ID, role, model, reasoning, status, duration, tokens and totals |
| `/pi-delegate stats [session\|today\|all\|rebuild]` | Recorded usage in a scrollable panel, without model calls or chat output |

Panels scroll with ↑/↓, Page Up/Down and Home/End; Esc goes back. In stats, **1/2/3** switches Session/Today/All, and `rebuild` reconstructs usage summaries, not running jobs.

The summary is display-only, never sent to the model, and stays as a snapshot on resume. Running jobs show elapsed time and tokens so far (`…`); `+` marks partial usage, a lower bound. Job IDs restart after reload or resume, so `#` is the unique row number. RPC mode shows the table as a notice.

The footer shows `⑂ <total>|<local%>` once total tokens are nonzero. The local share is rounded (`<1%` for a positive share below 1%) and omitted when zero; `|~$X` appears only for positive savings. Savings are a calibrated API-equivalent estimate, not measured net savings. Incomplete usage, recording warnings and estimate coverage are omitted from the footer; see stats.

To enable savings estimates, set `calibrationProfiles` to absolute profile paths and `localAlternatives` to the matching hosted model/thinking references, then `/reload`. Profiles must match models, role, thinking, tools and prompt; profiles older than 90 days are not selected for new jobs. Missing or incompatible profiles disable estimates, not delegation.

| Data | Default | Override |
|---|---|---|
| Archives | `~/.pi/agent/delegate/` | `PI_DELEGATE_ARCHIVE_DIR` (absolute path) |
| Diagnostics log | `~/.pi/agent/delegate.log` | `PI_DELEGATE_LOG` (path; `0` disables the log, **not archives**) |

Archive retention is indefinite. Keep archives private: they can contain sensitive prompts and tool output.

## Development

Parent guidance lives in [index.ts](index.ts); role prompts, models and tool policy live in [config.json](config.json). Keep role/model policy out of `AGENTS.md`.

Test from the repository root with `node --test --experimental-strip-types delegate/tests/*.test.ts` and `npm run test:load`. The [implementation contract](SPEC.md) covers runtime changes; see [child-runtime](../child-runtime/README.md) for RPC and shared-capacity requirements.
