# child-runtime

Shared Pi child process helpers. Not a package extension entrypoint. `guard.ts` is loaded explicitly only for guarded child executions.

`delegate` keeps argv, env, slots, and agent config. This package owns:

- nest / cwd / task / UTF-8 truncate
- `pi --mode rpc` invocation, readability-checked caller-owned archived prompt, bounded LF-only JSONL framing (`jsonl.ts`), stdin prompt/steer/abort
- prompt-rejection cleanup; provider errors before partial answers; explicit failed/incomplete output on model token limits
- all text blocks in the final assistant message per delivered wrap phase, retaining the preceding report and labelled follow-ups; canonical `provider/id` from Pi's separate provider/model metadata
- optional `hardTimeoutMs` kill, process-group kill (injectable in tests), dialog UI cancel
- child diag (cmd, pid, JSONL event types); empty assistant text becomes that dump

Nest marker is `PI_DELEGATE_CHILD=1`.

`answers.ts` keeps bounded phase snapshots. A delivered user-message event matching a sent wrap closes the preceding phase, not the RPC acknowledgement or send time. Assistant ordinals describe observed `message_end` events; they are not native archive IDs. Responses are never selected by length or wording. The combined return cap reserves space for each retained phase, puts errors first and labels omitted history. Up to eight phases are kept (first plus latest seven); individual text/error snapshots are capped at ingestion without modifying events passed to observers or native archives. Distinct pending wrap texts are tracked by digest, with a bound of 64; excess distinct requests are refused until earlier ones are delivered.

RPC records have an 8-MiB transport limit independent of the returned-answer cap. Known oversized non-answer records are discarded up to the next LF; useful/unknown oversized records fail explicitly. Prefix recognition follows Pi's type-first serialization and fails closed for unfamiliar layouts.

## Opt-in guarded execution

`runPiChild` accepts an explicit `execution` policy:

```ts
execution: {
  tools: ["read", "bash"],       // exact builtin tool set; no custom tools
  finalizeAfterMs: 0,           // process-start soft budget; 0 disables
  finalizationGraceMs: 60_000,   // positive, bounded finalization/exit grace
  startupTimeoutMs: 15_000,      // positive guard-readiness deadline
}
```

`delegate/spawn.ts`'s `runChild` accepts the same policy without its `tools` member, deriving that list from the existing child `tools` argument to avoid conflicting capability declarations.

This is a library API, **not yet a delegate configuration setting or default**. No kinds, model selections, tool lists or saved prompts are changed by its addition. Normal delegation remains steer-only until separately configured activation is implemented. Callers must explicitly list the existing builtin tools they intend to expose. Ambient extension discovery stays disabled; the runtime adds its private guard alongside any caller-supplied explicit extensions. Only trusted explicit extensions are compatible with the guard.

The parent withholds the task until a nonce-correlated readiness notice verifies the guard and requested tool set. An early wrap is retained, closes the gate before task dispatch, then steers only after acknowledgement and task dispatch. A successful RPC response alone is not enforcement acknowledgement.

The guard wraps public Pi builtin tool definitions, preserving schemas and prompt metadata. Finalization synchronously closes their execution-body gate: already-running bodies may drain, but fresh calls are rejected, including calls prepared by parallel preflight. Removing active tools also discourages further attempts; prompt compliance is not the enforcement boundary. This is **not a sandbox**: existing shell work and unrelated processes retain their normal permissions.

The first explicit wrap or soft-budget request wins and starts one grace deadline; repeats cannot restart work or extend it. Timers begin in the running process, not the queue. `timeoutMs` is still only a parent wait budget; the caller's independent `hardTimeoutMs` can terminate sooner. On natural settlement, a child must also exit within grace. Deadline/acknowledgement failures terminate the process group (SIGTERM, then SIGKILL after five seconds); the scheduler holds capacity until the child actually closes.

`delegate_finalization` progress events and `ChildResult.finalization` distinguish `starting`, `running`, `requested`, `draining` and `answering`. Only `draining`/`answering` acknowledge enforcement; active-tool counts are reported then, not guessed before acknowledgement. Guard failure, grace expiry and soft-budget exhaustion produce `guard-error`, `finalization_timeout` and `execution_budget` stop reasons. Earlier runtime failure/cancellation/hard-timeout causes win races. Budget exhaustion remains unsuccessful even if the child exits zero with a useful partial report.

Completed phase reports survive guarded failure. If a guarded child dies before `message_end`, bounded text-only streaming evidence is retained alongside (never instead of) the last finalized response, even without a delivered wrap. It is labelled incomplete; thinking and tool arguments are excluded. An unfinished retry does not erase the latest finalized provider error. An unfinished stream cannot turn a zero exit into success (`incomplete-output`). `streamed-answer.ts` holds at most 32 blocks and one output cap of text. Raw observer events and native archives are unchanged.

Guarded runs invalidate legacy savings estimates, including on archive reload/rebuild. Existing calibration keys do not represent execution policy; a policy-aware calibration is required before estimates can cover these runs.

## Tests

```bash
node --test --experimental-strip-types child-runtime/tests/*.test.ts
```
