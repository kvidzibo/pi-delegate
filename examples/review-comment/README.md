# Opt-in review-comment generator

[review-comment.mjs](./review-comment.mjs) generates a private, cumulative Markdown
review draft from pi-delegate review completions. Requires **Node >=22.19.0** and
Git; no dependencies, credentials or network access. Nothing is activated merely
by copying this example. It never publishes a comment; the parent verifies evidence
and decides whether to post or update it.

## Setup

1. Keep this example in a trusted, stable checkout. The script need not be installed
   elsewhere. Use `node -p process.execPath` to find the absolute Node executable.
2. In Roles, select `review`. Paste the complete contents of
   [response-schema.json](./response-schema.json) as **raw JSON** in the
   response-schema editor (not a filename, Markdown fence or config wrapper).
   For manual configuration, use `agents.review.responseSchema`.
   The schema requires scope, findings, checks, verification limits and verdict;
   it rejects extra fields. The hook additionally checks cross-field constraints,
   including `end_line >= start_line`. Ask for concise finding headlines and put
   supporting explanation in `evidence`.
3. In the Roles completion-hook editor, enter this JSON, replacing both absolute
   paths with real paths on your machine:

   ```json
   {"command":["/absolute/path/to/node","/absolute/path/to/checkout/examples/review-comment/review-comment.mjs","hook"],"timeoutMs":10000}
   ```

   Select **Save role** to persist both settings. For manual configuration, use
   `agents.review.completionHook` and preserve other settings.
   Finish outstanding delegates before changing configuration; after manual config
   edits, run `/reload` so new jobs use them. Enable only when you want this workflow;
   remove/disable the hook to stop future generation.

Saving a hook authorizes this trusted script for every accepted review job,
including failure/cancellation, with your permissions and inherited environment.
Treat repository content and model output as untrusted data, never commands.
See [hook authority and delivery limits](../../delegate/README.md#completion-hooks).

## Review workflow

Include exactly one standalone context line in each review task:

```text
Review-comment: {"repository":"https://github.com/owner/repo","base":"1111111111111111111111111111111111111111","head":"2222222222222222222222222222222222222222","validation":[{"check":"Parent tests","result":"passed","details":"Replace with the actual command and observed result"}]}
```

Replace the sample with the actual GitHub/Forgejo repository URL (not a PR URL),
full lowercase reviewed commit SHAs (40 or 64 characters), and **checks already
performed by the parent**, never planned checks. Check objects require `check`,
`result` (`passed`, `failed`, `inconclusive`) and `details` (may be empty). Use an
empty validation array if none ran; that prevents a clean outcome. Keep the same
repository URL across rounds and use a separate feature worktree per PR.

The hook uses the archived acceptance-time task, not current `HEAD`. On terminal
review completion, including worker failure/cancellation, it records metadata and
any successful schema-validated response under:

```text
<git-dir>/pi-review-comment/history.json
<git-dir>/pi-review-comment/comment.md
```

Find `<git-dir>` with `git rev-parse --absolute-git-dir`; the hook also reports paths
in archived stderr. No separate formatter call or parent-created result JSON is
needed. Missing/duplicate context, invalid data or a non-Git cwd fails explicitly.

Collect the completed delegate and wait for **Completion hook: succeeded**. Check
that history contains that run ID, inspect the draft, and independently verify
findings, evidence, checks and pinned links. Only then may the parent explicitly
post the draft or update the existing PR comment and verify its published body.
Retain history plus the published comment ID/URL for handoffs; restore missing
history before replacing a comment. Never publish local artifact paths.
**A running or failed hook may leave a stale draft: never publish it as the new result.**

The draft shows the latest review first, older reviews collapsed, full details and
pinned source links. Headlines/resolution summaries are capped at 15 words; full
text remains in Details. Findings begin `Unresolved`.

| Outcome | Meaning |
| --- | --- |
| `clean` | `ship`, no findings or unresolved gaps, passing checks and parent validation |
| `changes_required` | Findings or `fix_first` require changes |
| `incomplete` | Blocked verdict, verification gaps or missing/failed/inconclusive checks |
| `failed` | Worker failed/cancelled or no successful schema-validated response |
| `not_run` | Manual record only; no review attempted |

Empty findings, schema validity and worker completion do not prove approval.
Reviewer limits and recording warnings prevent automatic clean output; the parent
must not silently dismiss them or invent verification.

## Reviewer validation

Inspect the CI workflow and current exact-head check status first. Do not rerun
CI-covered checks by default or claim pending checks passed. Independently discover
and run relevant non-CI checks, including `npm run test:review-integration` from
the repository root. Record provenance: exact commands, working directory, reviewed
SHA, observed results and any checks not run with reasons. Report material gaps
only. The CLI tests (`test:examples`) are covered by CI; `test:load` is non-CI
and requires `pi`.

The integration check uses a temporary Git repository, the shipped response-schema
compiler and the actual completion-hook runner; no model, network, delegation or
publication is involved. From this example directory, run it with:

```bash
npm --prefix ../.. run test:review-integration
```

## Corrections and recovery

From this example directory, substitute actual artifact paths and run ID:

```bash
node ./review-comment.mjs resolve HISTORY.json RUN_ID 1 \
  'Fixed in FULL_COMMIT_SHA; verified in Review 2' COMMENT.md
node ./review-comment.mjs render HISTORY.json COMMENT.md
```

Use an actual full lowercase fix SHA for a pinned link. Record a dismissal reason
when appropriate; claim verification only after re-review. Original findings and
outcomes remain unchanged. The output argument writes atomically; **never redirect
onto the canonical draft**. `--help` lists manual `add`; it is not required for the
hook workflow. Manual `limit_resolutions` can preserve parent dispositions without
removing original reviewer limits.

Identical run-ID/input retries are idempotent; conflicting reuse is rejected.
Invalid input leaves history/draft unchanged. History saves before the draft, so
an output failure can leave saved history and an old/missing draft. Check the error;
recover with `render`, or replay the archived input:

```bash
node ./review-comment.mjs hook < /absolute/path/to/completion-hook-input.json
```

Do not hand-edit history, run parallel writers in one worktree, or remove a
`history.json.lock` directory unless its writer is confirmed stopped. Inspect the
recovered run and draft again before any parent publication.

## Local tests

From this example directory:

```bash
node --test tests/review-comment*.test.mjs
```
