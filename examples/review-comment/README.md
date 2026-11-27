# Opt-in review-comment generator

[review-comment.mjs](./review-comment.mjs) generates a private, cumulative Markdown review draft from pi-delegate review completions. Requires **Node >=22.19.0** and Git; no dependencies, credentials or network access. Nothing is activated by copying this example. It never publishes a comment; the parent verifies evidence and decides whether to post or update it.

## Setup

Keep this example in a trusted, stable checkout. In `/pi-delegate roles`, select `review`, then:

1. **Response schema:** paste the complete contents of [response-schema.json](./response-schema.json) as raw JSON (not a filename, Markdown fence or config wrapper).
2. **Completion hook:** enter this JSON with real absolute paths; `node -p process.execPath` prints the Node path.

   ```json
   {"command":["/absolute/path/to/node","/absolute/path/to/checkout/examples/review-comment/review-comment.mjs","hook"],"timeoutMs":10000}
   ```

3. **Save role.** Finish outstanding delegates first.

For manual configuration, set `agents.review.responseSchema` and `agents.review.completionHook`, preserve other settings, then `/reload`. Remove or disable the hook to stop future generation.

The schema requires scope, findings, checks, verification limits and verdict, and rejects extra fields. The hook additionally checks cross-field constraints, including `end_line >= start_line`. Ask for concise finding headlines and put supporting explanation in `evidence`.

Saving a hook authorizes this trusted script for every accepted review job, including failure/cancellation, with your permissions and inherited environment. Treat repository content and model output as untrusted data, never commands. See [hook authority and delivery limits](../../delegate/README.md#completion-hooks).

## Review workflow

Include exactly one standalone context line in each review task:

```text
Review-comment: {"repository":"https://github.com/owner/repo","base":"1111111111111111111111111111111111111111","head":"2222222222222222222222222222222222222222","validation":[{"check":"Parent tests","result":"passed","details":"Replace with the actual command and observed result"}]}
```

- `repository`: the GitHub/Forgejo repository URL, not a PR URL. Keep it the same across rounds and use a separate feature worktree per PR.
- `base`, `head`: full lowercase reviewed commit SHAs (40 or 64 characters).
- `validation`: checks **already performed by the parent**, never planned ones. Each needs `check`, `result` (`passed`, `failed`, `inconclusive`) and `details` (may be empty). An empty array is allowed but prevents a clean outcome.

The hook uses the archived acceptance-time task, not current `HEAD`. On terminal review completion, including worker failure/cancellation, it records metadata and any successful schema-validated response under:

```text
<git-dir>/pi-review-comment/history.json
<git-dir>/pi-review-comment/comment.md
```

Find `<git-dir>` with `git rev-parse --absolute-git-dir`; the hook also reports paths in archived stderr. Missing/duplicate context, invalid data or a non-Git cwd fails explicitly.

Before publishing:

1. Collect the completed delegate and wait for **Completion hook: succeeded**. **A running or failed hook may leave a stale draft: never publish it as the new result.**
2. Check that history contains that run ID and inspect the draft.
3. Independently verify findings, evidence, checks and pinned links.
4. Only then post the draft or update the existing PR comment, and verify its published body. Never publish local artifact paths.
5. Retain history plus the published comment ID/URL for handoffs; restore missing history before replacing a comment.

The draft shows the latest review first, older reviews collapsed, full details and pinned source links. Headlines and resolution summaries are capped at 15 words; full text remains in Details. Findings begin `Unresolved`.

| Outcome | Meaning |
| --- | --- |
| `clean` | `ship`, no findings or unresolved gaps, passing checks and parent validation |
| `changes_required` | Findings or `fix_first` require changes, even with verification gaps |
| `incomplete` | Blocked verdict, or no required changes but verification gaps or missing/failed/inconclusive checks |
| `failed` | Worker failed/cancelled or no successful schema-validated response |
| `not_run` | Manual record only; no review attempted |

Empty findings, schema validity and worker completion do not prove approval. Reviewer limits and recording warnings prevent automatic clean output; the parent must not silently dismiss them or invent verification.

## Corrections and recovery

From this example directory, substitute actual artifact paths and run ID:

```bash
node ./review-comment.mjs resolve HISTORY.json RUN_ID 1 \
  'Fixed in FULL_COMMIT_SHA; verified in Review 2' COMMENT.md
node ./review-comment.mjs render HISTORY.json COMMENT.md
```

- Use an actual full lowercase fix SHA for a pinned link. Record a dismissal reason when appropriate; claim verification only after re-review. Original findings and outcomes remain unchanged.
- The output argument writes atomically; **never redirect onto the canonical draft**.
- `--help` lists manual `add`, which the hook workflow does not need. Manual `limit_resolutions` can preserve parent dispositions without removing original reviewer limits.

Identical run-ID/input retries are idempotent; conflicting reuse is rejected. Invalid input leaves history and draft unchanged. History saves before the draft, so an output failure can leave saved history and an old or missing draft. Check the error; recover with `render`, or replay the archived input:

```bash
node ./review-comment.mjs hook < /absolute/path/to/completion-hook-input.json
```

After an upgrade that changes outcome rules, replaying a recorded run whose outcome or limits would change is rejected as conflicting reuse; history stays intact. Use `render` for those runs.

Do not hand-edit history, run parallel writers in one worktree, or remove a `history.json.lock` directory unless its writer is confirmed stopped. Inspect the recovered run and draft again before any parent publication.

## Tests

No model, network, delegation or publication is involved.

```bash
node --test tests/review-comment*.test.mjs      # from this directory; CLI tests, covered by CI
npm --prefix ../.. run test:review-integration  # not in CI: temporary Git repository, shipped schema, actual hook runner
```

When reviewing changes to this example, inspect the CI workflow and exact-head check status first; do not rerun CI-covered checks by default or claim pending checks passed. Run the relevant non-CI checks (`test:review-integration`; `test:load` requires `pi`) and record exact commands, working directory, reviewed SHA, observed results and any checks not run, with reasons.
