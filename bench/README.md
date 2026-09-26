# Calibration and benchmarks

[Quick start](../README.md) · [Delegate usage](../delegate/README.md)

Opt-in benchmarks calibrate the API-equivalent value of successful local work against a hosted alternative. This is **not measured net savings**, a subscription refund or a general quality assessment. Normal delegation and stats never launch benchmarks or call the alternative.

## Configure profiles

Configure recon with a local model, then add its hosted pricing reference to `~/.pi/agent/delegate.json`. Replace both example IDs; the local ID must match recon's model:

```json
{
  "localAlternatives": {
    "ollama/local-model": { "model": "provider/hosted-model", "thinking": "low" }
  },
  "calibrationProfiles": []
}
```

These settings replace the shipped map/list; alternatives are pricing references, not fallbacks. After a successful campaign, move `calibration.json` somewhere persistent, add its **absolute path** to `calibrationProfiles`, then `/reload` (stops outstanding children).

Profiles must match models, role, thinking levels, tools and prompt. Profiles older than 90 days are not selected for new jobs. Missing or incompatible profiles disable estimates, not delegation.

## Run a fresh campaign

The runner is not auto-loaded. With models and credentials configured, run from the repository root:

```bash
pi -e ./bench/index.ts
```

The campaign uses recon's model and mapped alternative. Pass recon's actual thinking level explicitly; shipped recon uses `off`, shown below. Omitting it uses the benchmark's `low` default, producing a profile that will not match `off` runs.

```text
/delegate-calibrate {"out":"/tmp/delegate-calibration-new","budgetUsd":5,"localThinking":"off"}
```

This makes real model calls with a **$5 API-metadata budget, not a provider billing cap**. Use provider-side limits too. `out` must be a new absolute directory with an existing parent. Artifacts persist until removed; keep them private and outside installed package clones. These profiles cover successful paired recon tasks, not general coding/review workloads.

## Safety and coordination

- **No sandbox:** fixture directories do not confine shell tools. Use trusted prompts, models and configuration.
- Have the local server ready. Stop submitting local delegates in all sessions and wait for existing jobs to finish; coordinate other clients separately. The benchmark bypasses delegate scheduling and does not manage servers or shared slots.
- `/delegate-calibrate-cancel` or closing the session cancels work but retains evidence. Incomplete campaigns do not publish profiles.

## Local recon prompt evaluation (opt-in)

`runReconEval` in `bench/recon-eval.ts` compares two explicit prompts using the same local model, builtin recon tools and thinking `off`. Four synthetic tasks cover targeted lookup, stale documentation, PATH-versus-installation evidence, and unavailable web tools with no shell fallback. Each arm gets fresh files; arm order alternates. The private output contains both prompts, native sessions, raw events, tool calls, answer words, elapsed time and automatic evidence checks. Added/changed fixture files and prohibited tool calls are flagged separately from worker completion.

From the repository root, after coordinating local clients as above:

```bash
node --experimental-strip-types --input-type=module <<'JS'
import { runReconEval } from './bench/recon-eval.ts';
await runReconEval({
  out: '/tmp/recon-eval-new', // must not exist
  baselinePromptPath: '/tmp/recon-baseline.md',
  candidatePromptPath: `${process.cwd()}/delegate/prompts/recon.md`,
  model: 'local-qwen38/qwen38-q4km',
  contextWindow: 65536, maxTokens: 32768, // verify against your model metadata
  env: process.env,
});
JS
```

Defaults: one repeat (eight runs), **12 provider requests and 120 seconds per run**, enforced by the existing benchmark guard and runtime timeout. `repeats` accepts 1–5, `maxRequests` 1–32 and `timeoutMs` 1000–900000. An optional `signal` cancels work while retaining evidence. The runner never changes servers or model configuration; it bypasses ordinary delegate scheduling. No hosted calls or savings profile are produced.

**Every result still requires manual review.** Fact/citation matching cannot detect contradictions or prove correctness; automatic boundary checks are deliberately narrow, not a shell sandbox. Review each answer and raw tool trace for factual accuracy, supporting citations, scope compliance and unnecessary work. Do not promote a prompt on length/speed alone.

## Validation

From the repository root, without model calls:

```bash
node --test --experimental-strip-types bench/tests/*.test.ts
```
