# Delegate

The extension provides the `delegate` tool, model picker, job controls and usage reports. Start with the [project README](../README.md) for installation, roles and safety limits.

## Configuration

Use **`/pi-delegate`** for the options menu, or **`/pi-delegate models`** to select a role. Its model picker opens immediately; selecting a model continues to reasoning. Enter on the current model skips a model save. If no selectable model is available, reasoning still opens for the current model. Model choices match `/model`: scoped models when a scope is set, otherwise every available model. Reasoning choices come from Pi's supported levels for that model (including `xhigh` and `max` when supported); non-reasoning models offer only `off`. Unknown models cannot have reasoning selected until their metadata is available. Saves go to `~/.pi/agent/delegate.json` and apply to new jobs in this session; running and queued jobs keep their settings. Other sessions need `/reload`. Esc returns to the role list. Declining a save stays on that picker; successful saves are confirmed in the next dialog.

For manual configuration, override [shipped defaults](config.json) in that user file, not in the installed package. Replace `provider/model` with an available Pi model ID:

```json
{
  "agents": {
    "recon": { "model": "provider/model", "offline": false }
  }
}
```

Each role accepts `model`, `tools`, `thinking` and `offline`. Omitted fields inherit defaults; tool arrays replace rather than extend them. Invalid configuration prevents loading. Manual edits require `/reload` or restart; **reload stops outstanding children**.

Set `offline: false` when manually switching to a hosted model; the picker does this automatically. A per-call `model` override keeps the role's tools, thinking and offline setting. Providers available only through parent extensions must be configured separately for children, which disable extension discovery.

Defaults are **8 running jobs, 1 local worker and 16 queued jobs per parent**. In addition, participating sessions sharing an agent directory share **one local worker across all local providers**, independent of model ID and archive path. Raising `maxLocalConcurrent` does not raise this shared limit. Hosted work can proceed while local work waits. Per-parent limits are configurable; local providers are `local-qwen*`, `llama.cpp` and `ollama`.

Shared capacity requires Linux and `/usr/bin/flock`; unavailable or unsafe coordination fails closed for local work, not hosted work. Private lock files live under `<agent-dir>/delegate-capacity/`; never remove them while clients may be running. The child verifies and retains an inherited lease until it exits, including after parent death. This adds a startup check, not tool restrictions, automatic runtime limits or enforced wrap-up. Reload older participating sessions to coordinate; unrelated server clients and the calibration runner are not covered.

## Eval repository snapshots

Capture is **off by default**. Open **`/pi-delegate snapshots`** from the options menu to offer first-use audits globally, audit/re-audit the current repository, disable explicitly enabled capture, reset a repository to the global default, or choose a dedicated storage directory. The global default offers the audit workflow for repositories without an explicit setting; it never enables capture or captures automatically. Explicit `true`/`false` repository settings take precedence over the global default. Existing explicit `true` settings remain manual opt-ins, not evidence that the repository was audited.

For a new repository with the global offer enabled, startup asks whether the current agent should audit it before capture is enabled. The audit prompt disables capture for that repository before asking consent. No model call is made until you choose Yes. The audit requires an idle parent agent; if it is busy, capture stays disabled and you must retry when it is idle. It uses the current parent agent/model in a best-effort review of captured source, staged changes, Git history, storage and unsupported coverage; it reports findings without secret values and never snapshots or delegates. A complete report with no findings enables an explicit repository `true`; No, findings, blocked work or an incomplete report leave it disabled so you can retry from the menu. Results are bound to the pending audit/session/working tree and source/index/reachable-history state; changes during the audit or stale settings require a new audit. Delegate launches are refused during an audit, and unknown repositories requiring an audit cannot silently launch without capture. Queued jobs recheck safety permission at dispatch; re-auditing or disabling capture overrides their frozen capture policy. Refused jobs must be retried. Already-started captures are not retroactively erased. Reload, session/branch changes, compaction and parent interruption invalidate pending results. Approval is repository-wide and shared by linked worktrees, not a per-commit safety seal. Other worktrees or changes made after approval can introduce secrets. This is not a hard sandbox. The one-time startup snapshot notice remains informational and does not repeat on reload, captures or settings changes. The directory setting is global; changing it leaves existing captures in the old directory. Other open Pi sessions need `/reload`.

Manual configuration in `~/.pi/agent/delegate.json`:

```json
{
  "snapshots": {
    "directory": "/absolute/private/eval-snapshots",
    "defaultEnabled": true,
    "repositories": {
      "/absolute/primary/repository/root": false
    }
  }
}
```

Omit `defaultEnabled` (or set it to `false`) to keep first-use audits off by default. Setting it to `true` offers the audit workflow for Git repositories without an explicit override; it never captures or enables them automatically. Remove a repository key to make it follow the global audit-offer setting. Non-Git working directories are never captured.

Omit `directory` to use `<agent-dir>/delegate-snapshots/`, independently of transcript archive overrides. Keys are canonical absolute repository paths shown by the menu: the shared Git directory's parent when it is named `.git`, otherwise the shared Git directory itself. This normally means the primary checkout root; separate-Git-directory layouts can use a Git-directory key. Subdirectories and linked worktrees share that repository's setting/storage. Separate clones are separate repositories. Storage must be outside the checkout and primary repository, owned by you, private, and not reached through symlinks. Existing directories must have no group/other access (`chmod 700`); stored files likewise require private permissions (`chmod 600`). Validation errors identify the failing path and reason, with a permission-fix command when applicable; permissions are never changed automatically.

For enabled repositories, session startup prints capture status, snapshot count, stored-file size and storage directory once in the transcript, without adding model context. It is not a sticky widget and does not repeat on `/reload`, capture completion or settings changes. Open the snapshots menu for current counts. Counts include every completed capture, even when file contents are identical; size counts deduplicated objects, history bundles and capture manifests, not filesystem allocation blocks. Startup metrics scans are asynchronous and never delay child dispatch or cleanup. Browsing disabled settings creates no snapshot directories.

Each accepted job freezes its capture settings, but captures the **actual launch-time state**, after queue/capacity waits and before starting the child. Cancelled queued jobs are not captured. Failed capture or failure to persist its archive link blocks launch. Successful captures are linked by `repositorySnapshot` in the run's `metadata.json`.

Captures contain current tracked and non-ignored untracked files, executable modes, symlink targets, deletions, staged index entries, a binary staged patch, and a Git bundle rooted at the starting HEAD (no unrelated branch refs). Unborn repositories have no history bundle. Files and history bundles are SHA-256-addressed and verified before reuse; unchanged content and identical history are shared. Storage layout is `<directory>/<repository-id>/{objects,history,captures}/`; manifests describe file hashes, starting HEAD, coverage and provenance. The live checkout/index is never modified.

**Constraints:** capture requires Linux with `/proc` for pinned, descriptor-relative source reads that prevent ancestor-symlink races. Ignored untracked files are excluded, but tracked or non-ignored dependencies/caches can be captured. Empty directories, dependency installation and external services are not reproduced. Conflicted indexes, submodules/nested repositories and special tracked files are refused rather than silently producing incomplete captures. Non-UTF-8 filenames are refused. Limits are 128 MiB per regular file, 2 GiB total source and 100,000 paths. Capture checks file stability and compares two full source/index/HEAD reads; detected changes refuse launch. This is not an atomic filesystem snapshot or a repository write lock: coordinate concurrent writers for stronger guarantees.

**Privacy:** source and reachable Git history can contain secrets, including tracked or previously committed credentials. Captures are private, never uploaded or automatically deleted, and are not redacted because changing code would defeat reproduction. Review repository contents before approving an audit and enabling capture. The audit report must not include secret values; its coverage is best-effort and changes after approval can add secrets. No environment or credential files outside the repository are copied. This feature captures inputs only; it does not run Docker or grade results.

## Cross-extension busy query

Extensions may query delegate activity by emitting `pi.events.emit('delegate:query-busy', { reply: busy => ... })`. The reply is synchronous: `true` means shutdown is underway or queued/running delegate jobs exist; otherwise it is `false`. If no listener responds, availability is unknown; fail closed (treat delegate as busy). Invalid payloads are ignored. The listener is removed on session shutdown and re-registered for each session.

## Job lifecycle

Example tool arguments:

```json
{
  "kind": "recon",
  "task": "Find test files and test commands; report paths and do not edit.",
  "background": true
}
```

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

Compact job cards and receipts lead with job ID, role and status, followed by a short model alias. Expanded headers show the full model and configured reasoning effort (including `off`); historical cards without recorded effort omit it. Finished/unverified and cancelled cards are neutral; failures remain red. Clipped result previews show how many rendered lines are hidden. `/pi-delegate jobs` opens a live, scrollable view of every active/queued job and its full task. Failed/cancelled rows also show the task and last recorded tool; cancellation is labelled explicitly. **Ctrl+O** expands full output, recent tools and archive paths, including raw cancellation diagnostics.

Returned answers are capped; inspect the native session for more recorded history. Capability receipts describe configured tools, not verified availability or sandboxing. Outcome receipts describe execution, not task correctness.

`/pi-delegate stats [session|today|all|rebuild]` shows recorded usage in a scrollable panel without model calls or chat output. Use ↑↓, Page Up/Down and Home/End to scroll, 1/2/3 to switch Session/Today/All in the interactive panel, and Esc to go back. The footer is hidden when total tokens are zero; otherwise it shows `⑂ <total>|<local%>` (rounded local share; `<1%` for a positive share below 1%), omitting `|<local%>` when local tokens are zero and adding `|~$X` only for positive savings. Savings are a [calibrated API-equivalent estimate](../bench/README.md), not measured net savings. The footer shows no warning labels; missing estimates add nothing. Incomplete usage, recording warnings and estimate coverage remain in `/pi-delegate stats`.

Archives default to `~/.pi/agent/delegate/`; `PI_DELEGATE_ARCHIVE_DIR` accepts an absolute replacement path. Retention is indefinite. Keep archives private: they can contain sensitive prompts and tool output. Rebuild reconstructs usage summaries, not running jobs.

Diagnostics default to `~/.pi/agent/delegate.log`. `PI_DELEGATE_LOG` changes the path; `0` disables diagnostics, **not archives**.

## Development

Parent guidance lives in [index.ts](index.ts), child instructions in [prompts/](prompts/), and model assignments in configuration. Keep role/model policy out of `AGENTS.md`.

Run from the repository root:

```bash
node --test --experimental-strip-types delegate/tests/*.test.ts
xvfb-run -a npm test
```

The [implementation contract](SPEC.md) covers changes to runtime behavior. Guarded execution and shared-capacity APIs are opt-in library features, not delegate configuration defaults; see [child-runtime](../child-runtime/README.md).
