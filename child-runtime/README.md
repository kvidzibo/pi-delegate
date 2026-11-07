# child-runtime

Helpers for running Pi child processes over RPC. This is an internal library, not a standalone command or automatically loaded extension.

Use [`runPiChild` and its input/result types](spawn.ts) for the runtime contract. The [`runChild` adapter](../delegate/spawn.ts) supplies delegate-specific arguments, environment and diagnostics. Callers provide the prompt file and session arguments. Workers reuse the current Pi CLI and load the source lease helper for local capacity. Version 0.28.0 is extension-only: standalone host invocation/helper injection and the MCP adapter are removed. See [migration](../MIGRATION.md); old running jobs cannot be adopted.

## Important constraints

- Wait budgets do not stop processes. `hardTimeoutMs` is the separate process-start kill limit; `0` disables it. Cancellation uses an `AbortSignal`.
- Returned text is bounded independently of native session history. Without a schema, a wrap-up reply must not replace the preceding report. Schema-enabled jobs return only the latest validated JSON; earlier attempts stay in the native session. Worker completion and response observations do not establish task correctness.
- Runtime cleanup must finish before the scheduler releases capacity. UI/observer failures must not change the worker outcome.

## Response validation

Optional `responseFormatPath` points to a private acceptance-time JSON snapshot (`schema`, `repairAttempts`, `maxOutputBytes`). The explicitly loaded `response-guard.ts` acknowledges readiness before dispatch, then uses Pi 1.5.0+'s pre-settlement boundary for up to two format-only repairs in the same session. Ajv validates draft-07 JSON without mutations; repair turns disable tools and block calls. Parent-side validation checks complete finalized text independently before truncation or saving. Invalid/oversized output or missing settlement fails with `response-format`; existing cancellation/provider failures keep precedence. Retries share the job's runtime and accounting. No schema means no helper, handshake or behavior change.

## Local-worker capacity

`resourceLease` accepts a borrowed Linux descriptor from the [shared-capacity broker](../delegate/capacity.ts) and requires an explicit `leaseStartupMs`. Before sending the task, lease-only startup verifies the child's inherited descriptor. It preserves the caller's extension-discovery flags, does not replace tools, and does not change steering/runtime deadlines. The private lease helper is always loaded explicitly. Local delegation uses a 15-second startup deadline. The scheduler releases capacity after process closure; the runtime never closes the borrowed parent descriptor. This coordinates participating processes, not unrelated GPU work or server-side requests.

Execution/headroom guard APIs are retired. Both runtime entry points refuse stale `execution` options rather than silently launch without the requested policy. Wrap remains advisory steering. Read-only finalization/headroom metadata schemas remain for existing archives and custom-runner results; historical guarded metadata still excludes incompatible savings estimates.

See the [implementation contract](../delegate/SPEC.md) for runtime boundaries.

## Validation

Run from the repository root:

```bash
node --test --experimental-strip-types child-runtime/tests/*.test.ts
npm test  # includes offline installed-Pi integration checks
```

Tests use mocked workers or owned offline processes, never model requests.
