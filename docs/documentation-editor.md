# Documentation editing

The `docs` role improves readability, structure, formatting and duplication across
all selected documents in one job. It receives complete files inline—not a diff—
and has no tools. It proposes replacements; the parent decides what to apply.

## Start a job

Call `delegate_start` with `kind: "docs"`, a short task describing the audience,
`cwd`, `requestId`, and the full `base` commit SHA. For a PR, also supply its exact
`head` SHA and use a checkout of that revision. Use the PR's actual comparison
base, not an assumed local main/master.

Omit `head` to include dispatch-time local changes: committed branch changes,
staged/unstaged edits and non-ignored untracked files relative to `base`. The
Pi extension's `delegate` tool accepts the same `base`/`head` fields.

Collect the terminal result before applying anything. Empty selections complete
without a model call. Related unchanged documents are not injected; cross-file
checks cover only the selected set.

## Configure file selection

Defaults select `.md`, `.mdx` and `.markdown`, excluding directories named
`node_modules`, `vendor` and `generated`. Add repository-specific exclusions for
secrets, generated files or other material that must not reach the model/archive.

The provider is generic and can be used by any role for other UTF-8 text types:

```json
{
  "agents": {
    "docs": {
      "tools": [],
      "context": [{
        "source": "git-changed-files",
        "include": ["**/*.md", "**/*.mdx", "**/*.markdown"],
        "exclude": ["**/node_modules/**", "**/vendor/**", "**/generated/**"],
        "content": "full",
        "delivery": "inline",
        "maxBytes": 262144
      }]
    }
  }
}
```

Patterns use Node's `path.matchesGlob` against repository-relative paths. Context
lists replace inherited lists; at most one full-file provider is allowed. The
`docs` role requires exactly that provider and `tools: []`. Its model/reasoning
remain separately configurable. See [delegate configuration](../delegate/README.md#configuration)
for overlay location and reload requirements.

Capture runs after queue waits. `base` and `head` must be complete commit IDs;
committed contents come from Git blobs, while local contents come from the
worktree. Deletions are listed separately, without their old contents. Renames
are treated as deletion/addition. Symlinks, submodules, special files, binary or
invalid UTF-8 data, and unsafe paths are refused if selected. Worktree capture
also rejects conflicts and hidden index flags/sparse checkouts.

The serialized context defaults to **256 KiB**; `maxBytes` can be 1–1,048,576.
At most 128 paths may be selected. Limits fail rather than truncate or silently
batch. These are byte limits, not a guarantee that every configured model's
context window is large enough. Worktree reads and stale checks require Linux
`/proc` descriptor-relative IO. Capture detects observed drift; it does not lock
the repository or guarantee an atomic snapshot.

## Inspect and apply proposals

A successful result is strict JSON:

```json
{
  "files": [{ "path": "README.md", "content": "Complete revised Markdown" }],
  "summary": ["Consolidated duplicate instructions"],
  "concerns": []
}
```

Only changed files are returned; `files: []` means no edits. Every returned path
must be a unique captured path with complete content. Unknown fields, malformed
or incomplete output, out-of-scope paths and blank replacements of nonempty files
are rejected. Output is bounded by the existing `maxOutputBytes` setting (64 KiB
by default). If a replacement cannot fit, the agent should leave it unchanged
and report the limitation; malformed/truncated output never becomes a proposal.

Beside the job's archived `session.jsonl`:
- `files-context.json` holds original contents, paths, revisions and SHA-256 hashes.
- `docs-proposal.json` holds the validated result. It exists only after successful
  output validation and a source-hash check against the current worktree.

The parent must inspect the proposed diff, preserve factual meaning and warnings,
resolve concerns, and **recheck original hashes immediately before applying**.
Concurrent edits invalidate the proposal; rerun rather than overwrite them. The
exported `assertFilesUnchanged` helper supports this check, but no automatic
application tool or multi-file transaction is provided. Agent-rule/prompt edits
still need their normal approval. Stale or invalid results fail without changing
repository files; a syntactically valid proposal is not proof of editorial quality.

Inputs and proposals stay in the existing private, indefinitely retained archive.
They are not redacted. The tool-free role has no file access, but the host still
reads selected files and sends their contents to the configured model. Restrict
selection before launch; do not rely on the editing prompt as a privacy boundary.
