# child-runtime

Helpers for running Pi child processes over RPC. This is an internal library, not a standalone command or automatically loaded extension.

Use [`runPiChild` and its input/result types](spawn.ts) for the runtime contract. The [`runChild` adapter](../delegate/spawn.ts) supplies delegate-specific arguments, environment and diagnostics. Callers provide the prompt file and session arguments. Hosts that are not Pi must supply an explicit `invocation` (executable plus prefix arguments); the default invocation reuses the current Pi CLI. Compiled hosts also supply `leaseGuardPath` for their packaged local-worker helper.

## Important constraints

- Wait budgets do not stop processes. `hardTimeoutMs` is the separate process-start kill limit; `0` disables it. Cancellation uses an `AbortSignal`.
- Returned text is bounded independently of native session history. A wrap-up reply must not replace the preceding report. Worker completion and response observations do not establish task correctness.
- Runtime cleanup must finish before the scheduler releases capacity. UI/observer failures must not change the worker outcome.

## Local-worker capacity

`resourceLease` accepts a borrowed Linux descriptor from the [shared-capacity broker](../delegate/capacity.ts) and requires an explicit `leaseStartupMs`. Before sending the task, lease-only startup verifies the child's inherited descriptor. It preserves the caller's extension-discovery flags, does not replace tools, and does not change steering/runtime deadlines. The private lease helper is always loaded explicitly. Local delegation uses a 15-second startup deadline. The scheduler releases capacity after process closure; the runtime never closes the borrowed parent descriptor. This coordinates participating processes, not unrelated GPU work or server-side requests.

Execution/headroom guard APIs are retired. Both runtime entry points refuse stale `execution` options rather than silently launch without the requested policy. Wrap remains advisory steering. Read-only finalization/headroom metadata schemas remain for existing archives and custom-runner results; historical guarded metadata still excludes incompatible savings estimates.

See the [implementation contract](../delegate/SPEC.md) for runtime boundaries.

## Validation

Run from the repository root:

```bash
node --test --experimental-strip-types child-runtime/tests/*.test.ts
xvfb-run -a npm test  # includes offline Pi integration checks
```

Tests use mocked workers or owned offline processes, never model requests.
