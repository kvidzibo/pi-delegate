# Delegate

The native-only extension provides the `delegate` tool, full Roles editor, model picker, job controls and usage reports. Version 0.28.0 removes the MCP interface; see [migration](../MIGRATION.md). Start with the [project README](../README.md) for installation, roles and safety limits.

## Configuration

Shipped models use `openai-codex`:

| Role | Model | Reasoning |
|---|---|---|
| `recon` | `gpt-6-luna` | `off` |
| `implement` | `gpt-6.1-sol` | `medium` |
| `review` | `gpt-6.1-sol` | `high` |
| `oracle` | `gpt-6-astra` | `high` |

All role defaults are hosted; configure a role to use a local model.
User role configuration takes precedence over these defaults. Models come only from role configuration; the `delegate` tool rejects any `model` argument, including null or blank values. This applies to every role, including reviews.

Use **`/pi-delegate roles`** (or Roles in `/pi-delegate`) to edit enablement, model, supported reasoning, tools with all/none, extension discovery, the full multiline prompt, an optional multiline response template, raw JSON Schema, repair attempts and Save to file. Enablement, extensions, repair attempts, Save to file and short reasoning lists cycle inline. Select **Save role** to persist; Esc discards the draft. **Add named role** requires an explicit available model and nonblank prompt; menu-created roles start with tools `[]`, extensions `false` and reasoning `off`.

**`/pi-delegate models`** retains the model-first picker followed by reasoning. Both paths share model selection and persistence. Use Roles to save model and reasoning together; the model-first picker saves them separately. Model choices match `/model`: scoped models when set, otherwise all available models. Reasoning comes from Pi's supported levels (including `xhigh`/`max` when supported); non-reasoning models offer only `off`. Saves preserve the complete user overlay and reject disk conflicts, unavailable models and uncertain catalogues. They apply to future jobs in this session; queued/running jobs retain their acceptance-time policy. Other sessions need `/reload`.

Add or override roles in `~/.pi/agent/delegate.json`, not in the installed package. [Shipped defaults](config.json) include the four starter roles and their full prompts. Replace `provider/model` with an available Pi model ID:

```json
{
  "agents": {
    "recon": { "prompt": "Inspect the requested paths without editing.\nCite file:line evidence." },
    "writer": {
      "model": "provider/model",
      "prompt": "Write only the requested documentation. Report changed files."
    }
  }
}
```

Role names match `[a-z][a-z0-9_-]{0,63}`. New roles require nonempty `model` and `prompt` strings; prompts replace the entire role system prompt, not append to it. JSON `\n` represents a newline.

| Field | Default for a new role |
|---|---|
| `enabled` | `true`; `false` refuses new jobs |
| `tools` | All Pi tools (`["*"]`); `[]` disables tools |
| `extensions` | `false`; `true` enables normal Pi extension discovery, including configured MCP support |
| `thinking` | `off` |
| `responseTemplate` | Empty/omitted: unchanged response instructions |
| `responseSchema` | Omitted/`null`: no validation; a draft-07 object or boolean enables JSON validation |
| `responseRepairAttempts` | `2`; integer `0`–`2`, additional attempts after the initial response |
| `saveToFile` | `false`: return the response inline |

Omitted overlay fields inherit the existing role's defaults. Tool arrays replace rather than extend them; use `tools: ["*"]` to give a starter role all tools. Shipped roles keep their explicit tool restrictions. Extension opt-in can execute installed/configured extension code and expose additional tools; skills, prompt templates and context-file discovery remain disabled.

Roles appear in the launch schema, native Roles editor, model picker and history. All role fields are editable in the native Roles editor; manual JSON remains optional. Accepted jobs retain their original prompt and policy. Legacy role `offline` and `context` keys are ignored and preserved on saves. Invalid configuration prevents loading. Manual edits require `/reload` or restart; **reload stops outstanding children**.

`docs` can now be defined like any other custom role. Old `agents.docs` entries need a `prompt` or must be removed; they are no longer ignored. Historical runs remain readable. Automatic diff/full-file context preparation and `base`/`head` job arguments remain unsupported. Supply context in the task instead.

Repository snapshot capture and safety audits have been removed. Legacy `snapshots`
configuration is ignored and preserved on settings saves. Existing stored snapshots
are not deleted; remove them manually if no longer needed.

Delegation does not add `--offline` or change Pi's inherited `PI_OFFLINE` environment setting. Set `PI_OFFLINE=1` explicitly to suppress automatic networking such as model-catalogue refreshes; this does not block model requests or tools' network access. Without it, startup may perform automatic networking. Providers available only through parent extensions need separate child configuration or explicit role `extensions: true`; extensions are disabled by default.

Defaults are **8 running jobs, 1 local worker and 16 queued jobs per parent**. In addition, participating sessions sharing an agent directory share **one local worker across all local providers**, independent of model ID and archive path. Raising `maxLocalConcurrent` does not raise this shared limit. Hosted work can proceed while local work waits. Per-parent limits are configurable; local providers are `local-qwen*`, `llama.cpp` and `ollama`.

Shared capacity requires Linux and `/usr/bin/flock`; unavailable or unsafe coordination fails closed for local work, not hosted work. Private lock files live under `<agent-dir>/delegate-capacity/`; never remove them while clients may be running. The child verifies and retains an inherited lease until it exits, including after parent death. This adds a startup check, not tool restrictions, automatic runtime limits or enforced wrap-up. Reload older participating sessions to coordinate; unrelated server clients are not covered.

## Automatic checkpoints

Open **`/pi-delegate checkpoints`** for Automatic checks, Advisor role, Interval, Save and Back. Default: off, role `goldfish`, every 10 main-agent tool-using rounds. The menu offers 10/20; manual `checkpoints.interval` accepts integers 1–1000. A round is one assistant response with tool calls: parallel tools and a `codemode` batch count once. Delegate waits/peeks do not count; mixed or incompletely recorded batches count conservatively. Failed tool attempts count. Checks apply to all tool-using work, not just implementation.

Example user overlay, after creating a suitable role in **Roles**:

```json
{
  "checkpoints": { "enabled": true, "role": "goldfish", "interval": 10 }
}
```

The role must be enabled with `tools: []` and `extensions: false`; its model, prompt, reasoning and output policy stay in **Roles**. No role/model is created or substituted. Save applies here to future checks and persists globally; other sessions need `/reload`. Esc/Back discards the draft. Existing jobs keep their policy.

At the interval, the main agent waits for the advisor through the existing scheduler. The packet contains recent request/clarification text, recent tool calls/results, assistant statements and previous checkpoint feedback from the current model-visible session projection. It respects context edits/compaction and is capped at 20,000 characters or `maxTaskChars`, whichever is smaller, with labelled omissions. It excludes thinking, images, system prompts and tool-result metadata. It does **not** discover repositories, read referenced files or collect diffs; its evidence can be incomplete, particularly after compaction.

**Privacy/cost:** opting in sends those excerpts to the configured advisor provider and records them in existing private, indefinitely retained delegate archives. Tool excerpts may contain secrets or other sensitive data; there is no guaranteed secret redaction. Each check incurs the role’s normal model cost and latency.

Feedback appears in the transcript and main-agent context before the next step, capped at 6,000 characters. It is unverified advice—not authorization, mandatory acknowledgement, a final review or proof the agent acted on it. Active checks appear in Jobs; usage is included in Stats. Saved-to-file replies are read by the harness for delivery.

The counter resets when the main agent settles and follows the active session branch across reload/resume. An interrupted check is not replayed from history. Parent cancellation/shutdown cancels its advisor without reviving the parent. Missing, disabled or incompatible roles and advisor failures produce an unavailable message and allow normal work to continue. Checks wait up to `defaultTimeoutMs` (including queue time); expiry requests cancellation instead of leaving an advisory job running unattended. There is no automatic checkpoint retry. Child agents never run checkpoints.

## Response templates and files

`responseTemplate` is free-form text appended to the role’s system prompt as final-response instructions. Markdown headings and tables work; there is no placeholder substitution or schema enforcement. Empty/whitespace-only text disables it. For example:

```json
{
  "agents": {
    "review": {
      "responseTemplate": "Use one row per finding; if none, say No findings. Do not invent resolutions or commits.\n\n| # | Severity | Finding | Resolution |\n|---|---|---|---|\n| 1 | High | <finding> | <actual resolution or unresolved> |",
      "saveToFile": true
    }
  }
}
```

`saveToFile` works independently of the template or schema. After a worker finishes, the harness writes its returned text to a unique private `pi-delegate-result-*` directory (`response.json` for validated JSON, otherwise `response.md`) under the OS temporary directory (usually `/tmp`). The parent receives the path instead of the body, also available as `details.responseFile`; repeated collection returns the same path. The worker is not instructed to save anything. Nonempty failure/partial results are saved too, without changing their failure status. Empty results produce no file. A save failure reports a warning and falls back to inline text.

Without a schema, files include wrap follow-ups and truncation notices; the existing `maxOutputBytes` limit still applies. Native session archives retain recorded history. Temporary directories are private (`0700`), files are owner-only (`0600`), and the extension does not delete them on collection or reload. OS cleanup may remove them; copy important reports elsewhere. All response settings are captured when the job is accepted.

## JSON Schema validation

In **Roles → Response schema**, paste a complete JSON Schema into Pi's multiline editor. JSON syntax and Ajv schema errors keep the editor text for correction; Esc cancels. Empty text disables validation (`responseSchema: null`); **Save role** persists the draft. **Repair attempts** cycles through 0, 1 and 2.

For manual configuration:

```json
{
  "agents": {
    "review": {
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
    }
  }
}
```

Requires Pi 1.5.0+. Ajv uses strict draft-07 validation, all errors and standard `ajv-formats` formats, without coercion, defaults or property removal. Self-contained `$ref` references work; unresolved external references, async schemas and unsupported keywords/drafts are rejected. `false` is a schema that rejects everything, not the disable switch; use `null` to disable an inherited schema.

The schema replaces template instructions while enabled; it does not delete the saved template or render Markdown. The model must return one JSON value without fences or prose. Validation runs before truncation/saving. Invalid or oversized output gets precise feedback in the same child/session, with tools disabled and calls blocked during format repairs. Repairs share the original time limit, capacity slot and usage accounting; no task restart or model substitution occurs. Cancellation, provider errors and token-limit failures are not retried as format errors. A tool call during repair terminates with an explicit error before tool lookup, preventing extra automatic turns.

The parent independently checks the final response. Only the latest validated JSON is returned, including after a wrap request; earlier attempts remain in the native session, not concatenated into the JSON. If repairs are exhausted or settlement is missing, the job fails with `response-format` and bounded diagnostics. JSON above `maxOutputBytes` fails rather than returning truncated JSON as successful. Successful saved JSON uses `response.json`; failure diagnostics use `response.md`. If saving fails, validated JSON stays intact inline and the file warning is reported separately. Schema, retry count and output limit are privately snapshotted at acceptance in `response-format.json` beside the archived prompt.

Validation establishes structure, not truth or successful task completion. Schemas are trusted user configuration, not a sandbox; enabled third-party extensions still execute with normal permissions.

## Task handoff

Keep the task self-contained. Optional headings inside the existing `task` string:

```text
Goal: requested change
Allowed files: editable paths, including any new files/directories
Acceptance criteria: observable requirements
Validation: exact commands; existing tests may be outside the edit list
Setup/dependencies: permitted reversible setup and prerequisites, or none
Documentation: relevant instructions and docs to read/update
Stop rules: scope limits and concrete conditions to report
```

These are task-text conventions, not additional tool arguments. File ownership limits edits, not execution of authorized tests. Explicitly authorize new directories, setup, and any isolated Pi integration tests; test processes must use temporary configuration and must not delegate work or make model requests. The shipped implementer and reviewer permit these tests; recon and oracle still prohibit extra Pi processes.

The implementer reports completed/remaining requirements, changed files, checks actually run with results, unrun checks with reasons, and concrete blocker evidence. Treat this as a child-reported checklist, separate from worker execution and parent-verified correctness. Custom prompt overrides replace the shipped prompt and do not automatically gain this checklist.

## Reviews

Reviews use the configured `review` model, with no per-call override. To use another model, change the role in `/pi-delegate roles` before launching.

Tasks are dispatched without automatic diffs or extra prepared context. Supply requirements, acceptance criteria, exact diff/artifact paths and scope, relevant repository constraints, and permitted validation commands.

Keep independent first-pass handoffs neutral: omit requests for approval, implementer self-assessments, and other reviewers' verdicts. For fix verification, include the prior finding and reproduction, but require independent reassessment. The shipped reviewer prompt treats explanations and claimed results as unverified and checks for counterevidence before reporting defects; no findings remains a valid outcome.

These are prompt conventions, not enforced blindness or proof of unbiased review. Tasks remain free-form and unchanged. Custom review prompt overrides replace the shipped prompt and do not automatically gain its independence guidance.

`review` defaults to `read`, `grep`, `find`, `ls` and `bash`—no `write` or `edit` tools. Read-only behavior relies on its prompt, not shell write protection. Explicitly authorized checks may create and clean up temporary test files, but must leave project files unchanged. This includes isolated Pi integration tests, never delegated work or model requests; `--offline` alone does not prevent model requests. Existing user `tools` overrides still replace the defaults. Custom `prompt` overrides do not inherit this permission; after updating, finish outstanding jobs and `/reload` to use the new shipped prompt.

## Cross-extension busy query

Extensions may query delegate activity by emitting `pi.events.emit('delegate:query-busy', { reply: busy => ... })`. The reply is synchronous: `true` means shutdown is underway or queued/running delegate jobs exist; otherwise it is `false`. If no listener responds, availability is unknown; fail closed (treat delegate as busy). Invalid payloads are ignored. The listener is removed on session shutdown and re-registered for each session.

## Job lifecycle

Example tool arguments:

```json
{
  "kind": "recon",
  "task": "Find test files and test commands; report paths and do not edit."
}
```

Spawns default to `background: true` and return a job ID immediately. Set `background: false` to wait for completion or the initial `timeoutMs` budget. Omit `background` when collecting or controlling an existing job.

Null, empty-string and whitespace-only optional arguments are treated as omitted; `false` and `0` keep their meanings. Spawning still requires non-empty `kind` and `task`.

An optional `cwd` selects an existing working directory; relative paths resolve against the parent's cwd. Use the returned job ID for controls:

| Action | Arguments |
|---|---|
| Wait / collect | `{ "jobId": "d0001" }` |
| Peek | `{ "jobId": "d0001", "timeoutMs": 0 }` |
| Request wrap-up | `{ "jobId": "d0001", "wrap": true }` |
| Cancel | `{ "jobId": "d0001", "cancel": true }` |

`timeoutMs` is a wait budget, **not a kill timeout**. Foreground expiry leaves the child running in the background. Timer arguments and configuration must not exceed 2,147,483,647 ms. Each collection starts a fresh quiet interval (60 seconds by default); child events restart it, but an explicit wait budget may return sooner. `quietForMs` still reports actual child inactivity, not time spent waiting. Collect again for the final result; completion notices are previews only.

**Esc interrupting the parent cancels all its running and queued delegates**, including background jobs and jobs from earlier turns. An interrupted foreground wait is not promoted to background. Until child cleanup finishes, receipts report `cancellationRequested: true`, remain nonterminal, and retain capacity. Pending completion notices are suppressed so they cannot restart the parent after cancellation. Normal parent completion and wait timeouts leave background jobs running; dismissing a menu with Esc is not a parent interrupt.

Wrap is advisory: it asks the child to finish without interrupting its current turn/tools; wrapping a queued job cancels it. For a suspected stall, wrap, wait again, then inspect a fresh peek before cancelling. Silence alone does not prove a stall. Cancel stops the child. The separate `hardTimeoutMs` configuration limits runtime; `0` disables it. Shutdown stops outstanding jobs.

## Results and history

Compact job cards and receipts lead with job ID, role and status, followed by model alias, thinking level and runtime: `d0001 · implement · ● Running · Luna · high · 1m 23s`. Expanded headers show the full model. Live headers update runtime once per second (or `queued 12s` before starting); finished headers keep the recorded total duration. Timing is not repeated below the header. Historical cards without recorded thinking or timing omit it. Finished cards say `needs validation`: the parent must check the result. Completion appears once in compact cards; finished and cancelled cards are neutral, while failures remain red. Task previews wrap to two lines with an ellipsis when shortened; pinned cards and failed/cancelled check receipts retain their one-line task budget. Saved-response paths are expanded-only. Clipped result previews show how many rendered lines are hidden. `/pi-delegate jobs` opens a live, scrollable view of every active/queued job and its full task. Failed/cancelled rows also show the task and last recorded tool; cancellation is labelled explicitly. **Ctrl+O** expands full output, recent tools and archive paths, including raw cancellation diagnostics.

Returned answers are capped; inspect the native session for more recorded history. Capability receipts describe configured tools, not verified availability or sandboxing. Outcome receipts describe execution, not task correctness.

`/pi-delegate stats [session|today|all|rebuild]` shows recorded usage in a scrollable panel without model calls or chat output. Use ↑↓, Page Up/Down and Home/End to scroll, 1/2/3 to switch Session/Today/All in the interactive panel, and Esc to go back. The footer is hidden when total tokens are zero; otherwise it shows `⑂ <total>|<local%>` (rounded local share; `<1%` for a positive share below 1%), omitting `|<local%>` when local tokens are zero and adding `|~$X` only for positive savings. Savings are a calibrated API-equivalent estimate, not measured net savings. The footer shows no warning labels; missing estimates add nothing. Incomplete usage, recording warnings and estimate coverage remain in `/pi-delegate stats`.

Existing savings profiles remain supported: set `calibrationProfiles` to their absolute paths and `localAlternatives` to the matching hosted model/thinking references in `~/.pi/agent/delegate.json`, then `/reload`. Profiles must match models, role, thinking, tools and prompt; profiles older than 90 days are not selected for new jobs. Missing or incompatible profiles disable estimates, not delegation. This package no longer includes a profile-generation runner or prompt-evaluation tooling.

Archives default to `~/.pi/agent/delegate/`; `PI_DELEGATE_ARCHIVE_DIR` accepts an absolute replacement path. Retention is indefinite. Keep archives private: they can contain sensitive prompts and tool output. Rebuild reconstructs usage summaries, not running jobs.

Diagnostics default to `~/.pi/agent/delegate.log`. `PI_DELEGATE_LOG` changes the path; `0` disables diagnostics, **not archives**.

## Development

Parent guidance lives in [index.ts](index.ts); role prompts, models and tool policy live in [config.json](config.json). Keep role/model policy out of `AGENTS.md`.

Run from the repository root:

```bash
node --test --experimental-strip-types delegate/tests/*.test.ts
npm run test:load
```

The [implementation contract](SPEC.md) covers runtime changes; see [child-runtime](../child-runtime/README.md) for RPC and shared-capacity requirements. Execution/headroom guard APIs are retired; existing archive metadata remains readable.
