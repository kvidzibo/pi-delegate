# child-runtime

Shared Pi child process helpers. Not loaded as an extension.

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

## Tests

```bash
node --test --experimental-strip-types child-runtime/tests/*.test.ts
```
