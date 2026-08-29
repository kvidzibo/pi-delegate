# child-runtime

Shared Pi child process helpers. Not loaded as an extension.

`delegate` keeps argv, env, slots, and agent config. This package owns:

- nest / timeout / tools / cwd / task / UTF-8 truncate
- `pi` invocation, temp prompt, JSONL parse, abort/timeout, process-group kill
- child diag (cmd, pid, JSONL event types); empty assistant text becomes that dump

Nest marker is `PI_DELEGATE_CHILD=1`.

## Tests

```bash
node --test --experimental-strip-types child-runtime/tests/*.test.ts
```
