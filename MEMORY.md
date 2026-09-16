# Validated lessons

- A queued steering request is not a delivered phase boundary. Preserve the preceding answer until its matching user-message event, then retain labelled follow-ups with independent space in the return budget; test both wrap/report event orderings.

- Freeze complete tool-result envelopes before consolidating return paths: omitted empty fields, capped content, and retained answer details can differ intentionally. A baseline factory probe catches differences that text-only assertions miss.

- A background job's launch row outlives its tool call: update it from scheduler snapshots keyed by the origin tool-call ID, and test completion without collect plus reused short IDs after reload. Release its invalidation callback at terminal.

- A queued archive is still unfinished after a parent crash: flag it incomplete on recovery without declaring the owner dead or changing its queued status.

- Archive corruption without a readable parent ID cannot safely be attributed to a session; display global archive health separately from session usage completeness.

- Guard status/notification callbacks as observers: a dead UI must not change child outcomes or prevent archive finalization. Test throwing UI adapters.
- RPC stdin EOF can shut Pi down before an asynchronous slash command finishes. CLI probes must keep stdin open until their correlated completion notice, then close it.

- Pi's bundled CLI can work while private unbundled loader imports fail on undeclared experimental dependencies. Smoke-test packages through an isolated offline CLI; use RPC UI notifications for probe results because Pi redirects extension console output to stderr.
- Release terminal scheduler control/runner callbacks even when keeping capped results: closures can retain the subprocess and uncapped RPC state. Verify ownership cleanup deterministically in unit tests, then confirm collection with a separate forced-GC probe.
- Correlate tool activity by call ID before comparing names or arguments: distinct identical calls and overlapping same-name calls need separate history and in-flight state.
- A cancelled child may resolve normally: recheck the abort signal after persisting its evidence and before publishing a campaign result, especially on the final iteration. Test cancellation on the last child, not only between jobs.
- Freeze accepted live transcript snapshots, not just invalidations: unrelated repaints can reread them and make Pi's regular renderer clear scrollback. Keep progress in a single mounted widget, finalize history once, and test off-screen cards with the real renderer.
- ANSI-aware truncation emits resets even with an identity theme. Strip terminal sequences from plain RPC previews, and test background coverage after resets as well as on trailing padding.
