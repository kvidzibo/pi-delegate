# pi-delegate

Delegate a focused coding task to a separate AI agent, keep working in the parent session, then collect the result. Built for the [Pi coding agent](https://github.com/earendil-works/pi), with configurable local or hosted models and bounded concurrency.

One parent tool, four agents. Child model is config — any id `pi` already knows.

| kind | job |
|---|---|
| `recon` | map / lookup (prompt says read-only) |
| `implement` | bounded edits + tests |
| `review` | review (prompt says read-only) |
| `oracle` | last-resort analysis (prompt says read-only) |

One child per call. No nesting. `background: true` returns `jobId` now. Local/GPU children share `maxLocalConcurrent` (default 1).

> **Security:** Pi packages run with your full system permissions. This one spawns child `pi` processes with `bash`. There is **no sandbox**. `offline` only skips Pi startup network; child `bash` can still use the network, write files, and read credentials. “Read-only” kinds are prompt policy only. Install only from a source you trust.

## Quick example

After [installing](#install) and [configuring](#config) a child model you can run, ask Pi:

```text
Use delegate to find this repository's test files and test commands.
Run a recon child in the background. Do not edit files.
Collect its result when it finishes.
```

The corresponding `delegate` tool arguments are:

```json
{
  "kind": "recon",
  "task": "Find this repository's test files and test commands. Report paths and commands; do not edit files.",
  "background": true
}
```

The launch returns a `jobId`. Collect it with another `delegate` call:

```json
{ "jobId": "d0001" }
```

`d0001` is illustrative: use the ID actually returned. Add `"timeoutMs": 0` to peek without waiting, or `"cancel": true` to cancel. These are tool-call examples, not a recorded run; model access and credentials must already be configured. A recon child's read-only instruction is not an enforced filesystem boundary.

**Design trade-off:** separate global and local concurrency caps let hosted work run alongside a limited number of local workers. When capacity is busy, accepted work queues rather than starting another worker; a full queue rejects new work. This bounds concurrent child jobs at the cost of waiting. See the [scheduler](delegate/jobs.ts) and [scheduler tests](delegate/tests/jobs.test.ts).

## Install

This README tracks repository source. npm packages and Git tags may be behind it; check the version you install before relying on newer features.

```bash
pi install npm:@kvidzibo/pi-delegate
```

Git:

```bash
pi install git:github.com/kvidzibo/pi-delegate@v0.4.0
```

Local checkout:

```bash
pi install /absolute/path/to/pi-delegate
```

Needs Pi on PATH. Do not `npm install` this repo; Pi supplies `@earendil-works/*` and `typebox`.

Do **not** also list `delegate` in `settings.json` `extensions`. Package load is enough.

## Config

Shipped `delegate/config.json` is **example models** (they become active defaults until you overlay). Set yours in `~/.pi/agent/delegate.json`. Omitted keys inherit shipped values, including `offline`. If you change a local agent to a hosted model, set `"offline": false`. Invalid overlay JSON prevents the extension from loading. Do not edit files inside a `pi install git:` clone.

```json
{
  "maxConcurrent": 8,
  "maxLocalConcurrent": 1,
  "maxQueued": 16,
  "agents": {
    "recon": { "model": "ollama/qwen3:8b", "offline": true },
    "implement": { "model": "openai-codex/gpt-5.6-luna" },
    "review": { "model": "anthropic/claude-sonnet-4-6" },
    "oracle": { "model": "openai-codex/gpt-5.6-sol" }
  },
  "localAlternatives": {
    "ollama/qwen3:8b": { "model": "openai-codex/gpt-5.6-luna", "thinking": "low" }
  },
  "calibrationProfiles": []
}
```

`model` is any `provider/id` from `pi` model list (Ollama, llama.cpp, Codex, etc.).

Per-agent keys: `model`, `tools`, `thinking` (`off|minimal|low|medium|high`), `offline` (adds `--offline` for the child `pi` process only).

Optional tool argument `model` overrides that call only. Kind keeps tools and prompt.

`timeoutMs` is a wait budget. It does **not** kill the child. Foreground expiry auto-backgrounds and returns a short check-in (`jobId`, last tools, `quietForMs`). Collect `jobId` again to wait; omit `timeoutMs` to wait until done or 60s quiet (silent inside the wait — no extra parent tokens while events flow). `timeoutMs: 0` peeks. `wrap: true` steers the child to finish (current tool may complete first). `cancel: true` kills. `hardTimeoutMs` in config (default `0`) is the only process-start kill. Local models (`local-qwen*`, `llama.cpp`, `ollama`) never overlap above `maxLocalConcurrent`. A running child keeps its slot. Hosted jobs still run in parallel. `session_shutdown` kills leftovers.

In TUI/RPC, a finished background job injects a short follow-up notice (preview only; full result still via `jobId`). Failures are visible; successes stay quiet in the transcript. Collecting a finished job suppresses the notice, including when the job finished mid-turn (notice waits until the parent is idle). Print/JSON stays pull-only. `session_shutdown` does not notify.

Background `implement` can race parent file writes. Progress callback failures do not invalidate accepted jobs or hide their collection receipts. Tool activity is correlated by tool-call ID, so identical or overlapping calls remain distinct; ID-less legacy events retain name-based matching.

Child is always a `pi` process (`--mode rpc --model <id>`). Codex/Anthropic/Ollama are providers behind that model id, not a separate CLI. Task goes on stdin as an RPC prompt. Each child end appends one JSON line to `~/.pi/agent/delegate.log` (cmd, pid, exit, JSONL event types, stderr). Task text is not on argv. `PI_DELEGATE_LOG=0` disables. `PI_DELEGATE_LOG=/path` overrides. Empty-answer tool results include the same dump so the parent is not blind.

Then `/reload` (or restart Pi) so the overlay is picked up.

## Job display

The **full active delegate card** stays pinned above the editor—not just a one-line status strip. It shows the job ID, kind, model identifier (once), task, live status and latest tool action. The scrolling transcript contains only a compact `accepted — card pinned above editor` receipt while the job runs. When it finishes, the pinned card disappears and that original receipt becomes the full finished card with its result, even without collection and after a foreground timeout. This keeps live changes out of off-screen transcript rows, which make Pi's regular renderer rebuild scrollback. Completion can still cause one redraw. Running/queued cards use neutral framing; a failed child command is not confused with overall job failure. Raw child thinking is never displayed.

While running:

```text
delegate · d0003 · review · xai/grok-4.6
Task: Review timeout and abort handling
● Running — reading file
→ read  delegate/jobs.ts
delegate  1 run  0 wait  local 0/1 · ctrl+o details
```

After completion, in the transcript:

```text
delegate · review · xai/grok-4.6 · d0003
Task: Review timeout and abort handling
✓ Finished
[Readable preview of the child result]
```

Collapsed finished cards show up to three rendered lines of the result. **Ctrl+O** (or your configured tool-expansion shortcut) shows the full returned result, the last three tool actions, and the native session path for the complete recorded history. Individual command failures are shown in tool details, not confused with overall job failure. Recording warnings and job errors remain visible when collapsed.

Wait/peek/wrap/cancel calls remain compact historical receipts, such as `d0003 · result collected` or `d0003 · checked · running at check`—never duplicate cards.

The pinned panel stacks active cards in acceptance order and retains running/queued/local-slot counts, optional local generation rate and wrap requests. **Ctrl+O** also expands pinned cards for more task/tool detail, within the panel's height limit. The panel uses at most **12 rows and half the terminal height**; regular mode reduces that budget further for the existing editor, footer and sibling widgets, leaving a transcript row. Overflow is labelled `+N more` with job IDs. Narrow/tiny terminals truncate fields or fall back to a compact header/status rather than pushing the input off-screen. Full results and recorded history remain available in finished cards and archived sessions; expanding a live transcript receipt shows its archive path.

In TUI mode the panel is mounted once and updated in place. **Regular mode anchors the full card stack and the existing editor/footer at the bottom even before output fills the screen**: a removable layout container puts spare rows above the cards. No Pi settings, renderer replacement or editor/footer replacement is needed. Fullscreen keeps Pi's native dock. The panel and added spacing disappear when idle; shutdown/reload restores the original component tree. Native terminal scrollback remains native (manually scrolling it still scrolls the terminal). RPC receives deduplicated plain card previews, capped at ten rows and 100 columns, never component factories. Parent-model tool results are unchanged.

Completion snapshots are saved as UI-only `delegate-job-state` session entries (including the capped answer, without raw thinking), so cards restore on reload/resume without model calls. Identity uses the original tool-call ID, not a short job ID that can repeat after reload. If an old or interrupted job has no saved completion, it is labelled historical with live status unavailable, never falsely left “running”. This does not resume jobs. `/reload` still stops outstanding children, as before.

Run `/reload` after updating the package to activate the new renderer.

## Child archives and session infobar

Every accepted local **and hosted** delegation is archived under `~/.pi/agent/delegate/` (or `<PI_CODING_AGENT_DIR>/delegate`). Set `PI_DELEGATE_ARCHIVE_DIR` to an absolute path to relocate it. **Retention is indefinite: no expiry, pruning, or size-based eviction.** Recording starts after installation/reload; old unrecorded usage cannot be recovered.

```text
runs/<UUID>/session.jsonl      Native Pi transcript, separate from parent /resume
runs/<UUID>/metadata.json      Parent session/tool-call IDs, model, kind, times, outcome, usage
runs/<UUID>/system-prompt.md   Snapshot of the custom child prompt
runs/<UUID>/task.md            Task, including jobs cancelled before they started
usage.jsonl                   Append-only export of finalized run summaries
```

Run UUIDs remain unique across processes and restarts even when short job IDs repeat. Native transcripts preserve what Pi records (messages, tool results, summaries), not unlimited raw tool output or referenced temporary files. Existing output/transport limits still apply. The custom prompt snapshot and tool configuration are recorded, not credentials, provider environment dumps, or full wire payloads.

New directories/files are private (`0700`/`0600` on POSIX); an existing archive directory must already be private and owned by you. **Transcripts can contain sensitive code, prompts, thinking, and tool output.** Nothing is uploaded automatically. Indefinite retention is not a backup against disk failure. Monitor disk space yourself; inability to establish recording refuses a new launch rather than deleting old data. Later recording errors are shown separately from the child's outcome, with partial usage retained where possible. `PI_DELEGATE_LOG=0` disables only the old diagnostic log, **not** this archive.

The infobar adds a separate status entry, without replacing Pi's normal parent-token counters:

```text
delegated 184k · local 162k · saved —
```

- **delegated:** recorded input + output + cache-read + cache-write tokens for all children of this parent session.
- **local:** the local subset, classified using the actual provider/model when available. This is offloaded work, **not net cloud savings**.
- **saved ~$X:** calibrated API-equivalent value of complete, successful local runs versus their configured hosted-child alternative. It is not measured net savings, parent-only execution cost, or a subscription refund. Failed/pending/incompletely recorded runs do not earn savings, but their usage still counts. Without matching calibration and known prices, this stays **saved —**.
- **!estimate:** only some eligible local runs have a monetary estimate (for example, older runs lack calibration). This marks coverage, not a confidence interval or guaranteed lower bound.
- **!partial:** unfinished, missing, or failed accounting attributable to this session; shown totals are known lower bounds. Reported usage from failed attempts counts too. All-zero provider placeholders are treated as missing, not as free work.
- **!archive:** archive errors that cannot be attributed to a parent session. This is separate from known partial usage; totals may be incomplete. `/delegate-stats all` shows the archive diagnostics. Errors known to belong to another parent do not mark this session partial.

Live cumulative usage is replaced, not repeatedly added; final assistant/tool/summarization usage is counted once. Reasoning is already in output. Compaction's retained message copies are not new inference. Totals restore on `/resume` and `/reload`, reset on `/new` and `/fork`, and remain session-wide when navigating `/tree`. Old sessions show recorded runs only. Background work, cancellation, and shutdown are included. No provider calls or model-context messages are generated by the infobar or reports.

```text
/delegate-stats          Current parent session (same as "session")
/delegate-stats today    Runs created today, in local time
/delegate-stats all      All recorded runs
/delegate-stats rebuild  Rebuild the export from retained sessions; append corrected snapshots
```

Reports separate local/hosted token buckets, outcomes, completed runtime and incomplete usage, and list the latest ten transcript paths. Expand a delegate result to see its transcript path. Inspect without model calls using `pi --export /path/to/session.jsonl /tmp/child.html`. To continue a child conversation, **fork it into a normal session** rather than modifying the archive in place.

The runtime passes the already-private archived `system-prompt.md` directly to Pi after a readability check, rather than creating a second temporary copy. The archive owns its lifetime; completion, cancellation, and failure do not delete it.

The per-run native transcript and metadata are the source of truth. Reports never sum repeated `jobId` collections or duplicated export rows. Export consumers must take the **highest `revision` per `runId`** (last row breaks equal-revision ties), not sum all rows. A delayed rebuild cannot supersede a newer terminal revision; `rebuild` appends corrections and never deletes historical rows. Atomic per-run metadata and separate UUID directories avoid cross-process lost updates. Unfinished runs are recovered as incomplete, without assuming another Pi process is dead or resuming its work. Missing/corrupt usage summaries can be reconstructed from native entries when identifying metadata remains intact; unreadable records are reported, not silently treated as zero.

Run `/reload` (or restart Pi) to activate these changes in existing sessions.

## Calibrated API-equivalent savings

Each `localAlternatives` entry maps a local **provider/model** to a hosted pricing reference and its thinking level. A string value is shorthand for `{ "model": "provider/model", "thinking": "low" }`. The shipped Qwen38 example references Luna. This is **not a fallback**: normal delegation and stats never call the alternative. An overlay replaces the whole map; `{}` disables it. `calibrationProfiles` is a replacement list of absolute JSON file paths (empty by default). No old benchmark results or guessed ratios are shipped.

At launch the extension selects a profile matching **both model IDs, kind, both thinking levels, tool set and exact custom prompt hash**. Newly selected profiles must be no older than 90 days. A model/settings change requires a new matching profile; a provider changing a model behind the same ID cannot be detected automatically. Profiles are trusted local data, limited to 256 KiB each, with schema validation. Missing, stale or invalid calibration never blocks work; `/delegate-stats` explains why savings are unavailable.

The profile contains successful-pair prompt/output ratios, the alternative's observed cache-read/write shares, sample counts, observed total-token ratio range and failed/incomplete-pair counts. At least four distinct mutually successful, fully recorded tasks are required. This is **provisional calibration conditional on success**, not a success-adjusted economic guarantee; a small or unrepresentative fixture set can give poor predictions. An observed range is not a confidence interval.

For each recorded local inference request:

```text
predicted prompt = (input + cacheRead + cacheWrite) × calibrated prompt ratio
predicted output = output × calibrated output ratio
predicted prompt buckets = predicted prompt × alternative's calibrated cache shares
estimated USD = sum(predicted buckets × reference API rates) / 1,000,000
```

Local KV-cache hits are not reused as API cache hits. Reasoning is already included in output. Request-wide pricing tiers apply to each **projected request**, not the session total; a real alternative may use a different number/shape of requests or different caching. Known positive input/output pricing is required; all-zero registry placeholders are unavailable. Rates come from Pi's model registry (not live invoice lookup). Electricity, hardware costs and parent coordination are not subtracted: the baseline is the same delegated task on the alternative model, not the parent solving everything directly.

Calibration and public rates are snapshotted in each run's metadata. Historical reports and rebuild use those snapshots, not today's prices/profiles; legacy runs are never retroactively assigned calibration. No provider credentials enter the snapshot. Per-request estimates follow the same replacement/deduplication/reconstruction rules as token accounting. The footer updates when a complete successful local run finalizes; `/delegate-stats` shows coverage and the latest runs' reference, ratios, sample diagnostics and capture dates.

### Run fresh comparison benchmarks (explicit opt-in)

The separate benchmark extension is **not auto-loaded** by the package. From a local checkout, with models and credentials already configured:

```bash
pi -e ./bench/index.ts
```

Then explicitly authorize a campaign via JSON command arguments, for example:

```text
/delegate-calibrate {"out":"/tmp/delegate-calibration-new","budgetUsd":5,"localThinking":"low"}
```

This example authorizes up to a **$5 API-metadata budget**, not an actual provider billing cap. No benchmark runs occur until this command is invoked. The output directory must be absolute, have an existing parent, and **not exist yet**. Artifacts are private and retained until you remove them; keep `calibration.json` somewhere persistent before adding its absolute path to `calibrationProfiles`. Do not put it in an installed package clone. Then `/reload`.

Defaults: 8 synthetic recon tasks × 2 repeats × 2 models = 32 sequential children, Qwen/current configured recon model at `low`, mapped alternative at its configured thinking level (default `low`), production recon tools and custom prompt. Optional JSON keys: `localModel`, `alternativeModel`, `localThinking`, `alternativeThinking`, `repeats` (1–10), `maxRequests` (1–100, default 12 per child), `timeoutMs` (1000–900000, default 120000 per child). To calibrate shipped production Qwen `off`, explicitly pass `"localThinking":"off"`; a low-thinking profile intentionally will not match off-thinking production runs.

Both arms get fresh copies of identical fixtures, tasks and strict expected results. They choose their own tool sequence; any fixture mutation fails scoring. Order alternates between arms. Raw RPC JSONL, native sessions, task results, budget receipts, a frozen manifest/prompt, and all failed evidence stay in the output directory. A profile is published only after the full campaign completes with enough usable pairs. Interrupted/unpaired arms remain in individual artifacts, not silently counted as completed pairs. The suite is a **small recon pilot**, not proof of general coding/review quality; broader workloads need separate profiles/suites.

**Budget safety:** each dedicated child loads a guard before receiving its task; absent guard acknowledgement means no task is sent. Before each provider request the guard reserves a conservative amount from declared context/output limits and the largest configured rates (including tiers). Finalized usage refunds unused reservation; missing usage retains it and stops further requests. Budget receipts must reconcile with the raw request count and priced usage before another arm can start; malformed or stale receipts stop the campaign. Changed thinking/tools or larger model limits/different prices also refuse before dispatch. Request limits, timeouts, recording failures and unresolved spend stop the campaign. Guard refusals terminate the dedicated process, since Pi logs ordinary hook exceptions and continues. Compaction is disabled for comparisons. Receipts distinguish known charges/reservations from unknown spend. Metadata inaccuracies and provider-internal retries/billing rules cannot provide an invoice-level guarantee; use provider-side limits as well. A budget too small for even one worst-case request refuses before spawning.

`/delegate-calibrate-cancel` or closing the benchmark session cancels work and retains evidence. The runner never starts/stops local servers, changes GPU fans or imports old comparisons. Run it when your configured local server is ready and other local work is idle; it does not coordinate with other Pi sessions' local slots. **Separate fixture directories are not a sandbox:** configured tools (including `bash`) and child processes retain your system permissions and provider access. Use only trusted prompts/models/configuration. The synthetic fixtures contain no user source code, but tools are not filesystem-confined.

## Errors and output limits

Rejected RPC prompts (for example, missing credentials) fail immediately with the child's error, clean up the process, and release its slot. Provider errors appear before any partial answer so output truncation cannot hide the cause. A model output-token cutoff (`stopReason: "length"`) is a failed job with an explicit incomplete-answer warning, even if no answer text was produced. Any partial answer remains available within the output cap. Validation and child failures are marked as errors in Pi and show a short explanation even when collapsed; expand for the full error.

Completed jobs retain capped results for later `jobId` collection within the session, but release runner/control references that would otherwise retain the subprocess and uncapped RPC state. Completed model identifiers preserve Pi's separate provider and model fields as `provider/id`; incomplete model metadata leaves the last known identifier unchanged (initially the configured model).

The final answer includes every text block from the last assistant message, in order. `maxOutputBytes` (default 65536) caps the returned text with a truncation notice. This is separate from the 8-MiB per-record RPC transport limit. Oversized, recognized non-answer events (such as cumulative transcripts and image tool results) are discarded without killing the child; their progress detail may be absent. Oversized assistant/control events or unknown layouts fail explicitly rather than silently returning an earlier answer. Discards appear as `oversized_event_skipped` in diagnostic event types.

## Tests

```bash
npm run test:unit       # no Pi required; this is what CI runs
xvfb-run -a npm test    # unit + CLI load/UI checks (Linux; needs `pi` and Xvfb)
```

Unit tests mock children and process termination; they never signal OS process groups. Load/UI checks start isolated, offline Pi CLI processes with temporary configuration, but never call models. The budget-guard startup probe also launches an isolated Pi child and terminates it after readiness, before sending any task. Job-card lifecycle probes inject a mocked child runner. Stability checks mount a real widget sibling above the editor and drive the installed regular-mode renderer with off-screen launch cards, verifying that scheduled live repaints do not clear screen/scrollback. Screen-coordinate regressions verify full-card headers, tasks, status and tool actions—not only a status strip—while a short transcript grows beyond the viewport. They also exercise expansion, tall inputs, sibling widgets, shrink, resize, idle/reuse, cursor/focus preservation and layout cleanup. Layout unit tests also cover single-pass rendering, fullscreen passthrough and renderer replacement. Pi-free unit tests cover widget mounting, thinking-only update deduplication, idle/reuse, RPC, and dead UI callbacks; CLI tests cover Unicode widths, card-height limits, explicit overflow and actual widget height changes. They use the installed CLI's loader, not private unbundled Pi imports; no separate `@earendil-works/pi-server` installation is needed. On systems without Xvfb, the underlying command is `npm test`.

CLI load/UI checks are omitted from GitHub Actions because runners have no `pi`.

See `delegate/SPEC.md`.
