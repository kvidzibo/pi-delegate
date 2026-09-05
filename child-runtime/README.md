# child-runtime

Shared Pi child process helpers. Not loaded as an extension.

`delegate` keeps argv, env, slots, and agent config. This package owns:

- nest / cwd / task / UTF-8 truncate
- `pi --mode rpc` invocation, temp prompt, bounded LF-only JSONL framing (`jsonl.ts`), stdin prompt/steer/abort
- prompt-rejection cleanup; provider errors before partial answers; explicit failed/incomplete output on model token limits
- all text blocks in the final assistant message; canonical `provider/id` from Pi's separate provider/model metadata
- optional `hardTimeoutMs` kill, process-group kill (injectable in tests), dialog UI cancel
- child diag (cmd, pid, JSONL event types); empty assistant text becomes that dump

Nest marker is `PI_DELEGATE_CHILD=1`.

RPC records have an 8-MiB transport limit independent of the returned-answer cap. Known oversized non-answer records are discarded up to the next LF; useful/unknown oversized records fail explicitly. Prefix recognition follows Pi's type-first serialization and fails closed for unfamiliar layouts.

## Tests

```bash
node --test --experimental-strip-types child-runtime/tests/*.test.ts
```
