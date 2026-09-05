# Validated lessons

- A background job's launch row outlives its tool call: update it from scheduler snapshots keyed by the origin tool-call ID, and test completion without collect plus reused short IDs after reload. Release its invalidation callback at terminal.

- A queued archive is still unfinished after a parent crash: flag it incomplete on recovery without declaring the owner dead or changing its queued status.

- Archive corruption without a readable parent ID cannot safely be attributed to a session; display global archive health separately from session usage completeness.

- Guard status/notification callbacks as observers: a dead UI must not change child outcomes or prevent archive finalization. Test throwing UI adapters.
- RPC stdin EOF can shut Pi down before an asynchronous slash command finishes. CLI probes must keep stdin open until their correlated completion notice, then close it.

- Pi's bundled CLI can work while private unbundled loader imports fail on undeclared experimental dependencies. Smoke-test packages through an isolated offline CLI; use RPC UI notifications for probe results because Pi redirects extension console output to stderr.
- Release terminal scheduler control/runner callbacks even when keeping capped results: closures can retain the subprocess and uncapped RPC state. Verify ownership cleanup deterministically in unit tests, then confirm collection with a separate forced-GC probe.
