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

In that session, explicitly authorize a campaign using recon's configured thinking level (`low` below). It defaults to recon's model and mapped alternative:

```text
/delegate-calibrate {"out":"/tmp/delegate-calibration-new","budgetUsd":5,"localThinking":"low"}
```

This makes real model calls with a **$5 API-metadata budget, not a provider billing cap**. Use provider-side limits too. `out` must be a new absolute directory with an existing parent. Artifacts persist until removed; keep them private and outside installed package clones. These profiles cover successful paired recon tasks, not general coding/review workloads.

## Safety and coordination

- **No sandbox:** fixture directories do not confine shell tools. Use trusted prompts, models and configuration.
- Have the local server ready. Pause ordinary delegates with `/delegate-local off`, wait for `OFF · idle`, and coordinate other clients separately. The benchmark bypasses this switch and does not manage servers or shared slots. Restore `/delegate-local on` afterward.
- `/delegate-calibrate-cancel` or closing the session cancels work but retains evidence. Incomplete campaigns do not publish profiles.

## Validation

From the repository root, without model calls:

```bash
node --test --experimental-strip-types bench/tests/*.test.ts
```
