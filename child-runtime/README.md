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

### Response observations

`ChildResult.evidence` is an optional, bounded `ResponseEvidence` snapshot from [`evidence.ts`](evidence.ts). `runPiChild()` records whether it wrote the task RPC, observed `agent_settled`, counted finalized assistant `message_end` events, retained latest-by-phase responses, omitted phases, has an unanswered delivered wrap, or observed an open/retained partial response. An open response is tracked even without guarded execution; this does not enable default stream retention or change terminal classification.

Task sent means written, not accepted or executed. Finalized counts include empty/error messages and intermediate responses, not unique model requests or useful/correct reports. Retained-response counts describe in-memory phase snapshots before the final display cap, not full-text delivery. Streaming deltas, user/tool messages and legacy event shapes do not increment them. Observations cover consumed RPC events, not direct/bypassed model calls or detached work. Copiers reject malformed counts; older/custom runners may omit this metadata. No task assessment is performed.

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

The parent withholds the task until a nonce-correlated readiness notice verifies the guard and requested tool set. An early wrap is retained, closes the gate and drains any already-active tools before task dispatch, then steers only after acknowledgement and task dispatch. Readiness is rechecked synchronously at dispatch, including after a caller's asynchronous startup handshake. A successful RPC response alone is not enforcement acknowledgement.

The guard wraps public Pi builtin tool definitions, preserving schemas and prompt metadata. Finalization synchronously closes their execution-body gate: already-running bodies may drain, but fresh calls are rejected, including calls prepared by parallel preflight. Removing active tools also discourages further attempts; prompt compliance is not the enforcement boundary. This is **not a sandbox**: existing shell work and unrelated processes retain their normal permissions.

The first explicit wrap, soft-budget or context-pressure request wins and starts one grace deadline; repeats cannot restart work or extend it. Timers begin in the running process, not the queue. `timeoutMs` is still only a parent wait budget; the caller's independent `hardTimeoutMs` can terminate sooner. On natural settlement, a child must also exit within grace. Deadline/acknowledgement failures terminate the process group (SIGTERM, then SIGKILL after five seconds); the scheduler holds capacity until the child actually closes.

`delegate_finalization` progress events and `ChildResult.finalization` distinguish `starting`, `running`, `requested`, `draining` and `answering`. Only `draining`/`answering` acknowledge enforcement; active-tool counts are reported then, not guessed before acknowledgement. Guard failure, grace expiry and soft-budget exhaustion produce `guard-error`, `finalization_timeout` and `execution_budget` stop reasons. Earlier runtime failure/cancellation/hard-timeout causes win races. Budget exhaustion remains unsuccessful even if the child exits zero with a useful partial report.

Completed phase reports survive guarded failure. If a guarded child dies before `message_end`, bounded text-only streaming evidence is retained alongside (never instead of) the last finalized response, even without a delivered wrap. It is labelled incomplete; thinking and tool arguments are excluded. An unfinished retry does not erase the latest finalized provider error. Open turns remain incomplete even if they contain only thinking or no text; only an empty-text marker is retained. Stream labels use the phase at `message_start`, so a later wrap echo cannot relabel in-flight task evidence. An unfinished stream cannot turn a zero exit into success (`incomplete-output`). `streamed-answer.ts` holds at most 32 blocks and one output cap of text. Raw observer events and native archives are unchanged.

Guarded runs invalidate legacy savings estimates, including on archive reload/rebuild. Existing calibration keys do not represent execution policy; a policy-aware calibration is required before estimates can cover these runs.

## Opt-in text headroom

Add `headroom` to the explicit `execution` policy to enable request-time protection. Example values, not package defaults:

```ts
headroom: {
  maxInputBytes: 65_536,
  maxToolResultBytes: 4_096,
  maxToolBatchBytes: 16_384,
  reserveTokens: 8_192,
}
```

This remains a **library opt-in, not a delegate configuration setting or default**. Readiness must acknowledge the exact policy hash before the parent sends its task. Models, output parameters, configured tools and saved prompts are not changed.

`headroom.ts` provides the pure `planHeadroom(payload, model, policy)` and stateful `HeadroomSession` used by the guard. Tool caps count JSON-encoded content individually and cumulatively across each outgoing request. Known OpenAI Completions/Responses (including Codex/Azure and grammar-tool outputs) and Anthropic Messages envelopes are supported. Only protocol-position tool-result bodies may be shortened; task, assistant/call history, signatures, schemas and other request fields are preserved. Omission markers are explicit. Native/session evidence is never rewritten.

The session preserves previously presented tool-result projections rather than re-clipping an earlier response's input prefix. Newest **fresh** results get remaining space first. Cache-marker movement is allowed without accumulating obsolete markers. Changed/disappeared/ambiguous result identities, an API change, or a fixed prefix that cannot fit cause refusal. Inspection is bounded to 4 MiB of raw JSON, 50,000 nodes, depth 64 and 4,096 tool results. Retained tool content is bounded by the aggregate policy cap.

Input ceiling: `min(maxInputBytes, contextWindow - reservedTokens) - 1024`, with the reserve equal to the larger of the policy minimum and actual requested output limit(s), or declared model maximum when absent. This deliberately allows at most one input byte per remaining declared token. It is **not tokenizer-exact, a full API-schema validator, or a guarantee about hidden server prompts, transport framing or inaccurate model/deployment metadata**. Azure deployment mapping must match the declared model limits. Other detectable model mismatches and Responses server-retained context references refuse. Unknown API/limits, opaque data, multimodal input and unfittable non-tool context refuse rather than guess.

Any clipping or 80% occupancy requests finalization and closes the shared execution-body gate before the shaped request proceeds. The parent receives the reason before gate acknowledgement, preserves the first request/grace deadline, and sends the existing wrap instruction. Requested finalization is not a delivered user-message boundary. Default Pi compaction is cancelled instead of spending on an implicit summary; final requests still pass through the same budget check.

Unsafe requests synchronously exit the dedicated child **before transport**. Ordinary Pi hook exceptions are swallowed, so throwing is not enforcement. A nonce-correlated RPC notice plus a bounded synchronous stderr receipt identifies refusal. The parent latches that cause while draining earlier stdout evidence. If both receipts are lost, reserved exit code 79 is reported explicitly as `refusal-exit`, not a confirmed receipt. Earlier terminal causes remain authoritative.

`finalization.headroom` records the policy hash, phase, sticky pressure flag, latest available payload/reservation/clipping counts and bounded refusal detail. Parent receipts distinguish these from execution-gate acknowledgement; scheduler snapshots and archives retain detached copies. Pressure/refusal produces `context_budget` even after a zero exit, unless an earlier execution-budget request or terminal failure wins. Available reports remain accessible; this does not claim task completion.

The guard runs last among explicit child file extensions and requires trusted compatible Pi transports that invoke `before_provider_request`. It does not cover custom streams/direct model calls that bypass that hook, earlier extensions' own compaction calls, server-side work, or arbitrary hostile code. It is not a sandbox. Offline tests exercise real Pi serialization and stream parsing through mocked HTTP, including swallowed hook errors, hard refusal and native evidence preservation.

## Inherited resource leases

On Linux, `runPiChild` and `runChild` accept a borrowed `resourceLease: { fd, dev, ino }` from the shared-capacity broker. Guarded execution is mandatory. The parent validates the owned/private regular file, inherits the open descriptor as child FD 3, and withholds the task until the guard acknowledges its expected device/inode identity. Missing/mismatched acknowledgement fails as `guard-error`; the runtime never silently drops the lease.

The broker/scheduler owns the parent descriptor and releases it only after the runner settles. Neither the runtime nor a caller-provided runner may close a borrowed descriptor. The inherited child descriptor preserves kernel occupancy if the parent dies; it closes with the child. This coordinates cooperating live child processes, not unrelated work or lingering server-side requests. Default runs inherit no resource descriptor and keep their original three-pipe stdio setup. See [shared capacity](../delegate/README.md#shared-capacity-api) for backend requirements and scope.

A lease can be combined with `execution.headroom`. The same readiness notice must acknowledge the requested tools, inherited device/inode and exact headroom policy hash. Neither proof substitutes for the other. Context pressure/refusal does not release the borrowed parent descriptor; its owner still holds it through runner closure.

## Tests

```bash
node --test --experimental-strip-types child-runtime/tests/*.test.ts
```
