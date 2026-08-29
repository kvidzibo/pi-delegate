# child-runtime

Shared Pi child process helpers. Not loaded as an extension.

`delegate` keeps argv, env, slots, and agent config. This package owns:

- nest / tools / cwd / task / UTF-8 truncate
- `pi --mode rpc` invocation, temp prompt, JSONL parse, stdin prompt/steer/abort
- optional `hardTimeoutMs` kill, process-group kill, dialog UI cancel
- child diag (cmd, pid, JSONL event types); empty assistant text becomes that dump

Nest marker is `PI_DELEGATE_CHILD=1`.

## Tests

```bash
node --test --experimental-strip-types child-runtime/tests/*.test.ts
```
