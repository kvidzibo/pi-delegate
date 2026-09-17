# child-runtime

Helpers for running Pi child processes over RPC. This is an internal library, not a standalone command or automatically loaded extension.

Use [`runPiChild` and its input/result types](spawn.ts) for the runtime contract. The [`runChild` adapter](../delegate/spawn.ts) supplies delegate-specific arguments, environment and diagnostics. Callers provide the prompt file and session arguments.

## Important constraints

- Wait budgets do not stop processes. `hardTimeoutMs` is the separate process-start kill limit; `0` disables it. Cancellation uses an `AbortSignal`.
- Returned text is bounded independently of native session history. A wrap-up reply must not replace the preceding report. Worker completion and response observations do not establish task correctness.
- Runtime cleanup must finish before the scheduler releases capacity. UI/observer failures must not change the worker outcome.

## Opt-in execution controls

These are library APIs, **not delegate configuration settings or defaults**. Ordinary delegation remains steer-only.

- **`execution`** enables guarded startup and finalization. The guard must acknowledge readiness before task dispatch. Finalization blocks new builtin tool execution while active tools drain; it does not sandbox shell work or unrelated processes.
- **`execution.headroom`** bounds outgoing request/tool-result text and reserves output space. It is a conservative byte policy, not exact token accounting. Native history remains unchanged. Enforcement requires trusted, compatible transports and extensions; direct model calls can bypass it.
- **`resourceLease`** accepts a borrowed Linux descriptor from the [shared-capacity broker](../delegate/capacity.ts) and requires guarded execution. The scheduler owns release after process closure; the runtime must not close the borrowed parent descriptor. This coordinates participating processes, not unrelated GPU work or server-side requests.

Guarded runs cannot reuse legacy savings calibrations. See the [implementation contract](../delegate/SPEC.md) when changing these boundaries; API types and tests contain the detailed behavior.

## Validation

Run from the repository root:

```bash
node --test --experimental-strip-types child-runtime/tests/*.test.ts
xvfb-run -a npm test  # includes offline Pi integration checks
```

Tests use mocked workers or owned offline processes, never model requests.
