# Validated lessons

- Pi's bundled CLI can work while private unbundled loader imports fail on undeclared experimental dependencies. Smoke-test packages through an isolated offline CLI; use RPC UI notifications for probe results because Pi redirects extension console output to stderr.
- Release terminal scheduler control/runner callbacks even when keeping capped results: closures can retain the subprocess and uncapped RPC state. Verify ownership cleanup deterministically in unit tests, then confirm collection with a separate forced-GC probe.
