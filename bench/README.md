# Calibration and benchmarks

[Quick start](../README.md) · [Runtime reference](../delegate/README.md)

`pi-delegate` can estimate the API-equivalent value of successful local work against a configured hosted child. This is **not measured net savings**, the cost of the parent solving the task directly, or a subscription refund. Normal delegation and stats never call the hosted alternative or launch benchmarks.

## Configure estimates

Add settings to `~/.pi/agent/delegate.json`, using model IDs available in your Pi setup:

```json
{
  "localAlternatives": {
    "ollama/qwen3:8b": { "model": "openai-codex/gpt-5.6-luna", "thinking": "low" }
  },
  "calibrationProfiles": []
}
```

Each map entry names a hosted pricing reference and its thinking level, **not a fallback**. A string value is shorthand for `{ "model": "provider/model", "thinking": "low" }`. The overlay replaces the whole map; `{}` disables it. The shipped Qwen38 example references Luna. No profiles, old benchmark results or guessed ratios are shipped.

After generating a profile, store it persistently, add its absolute path to `calibrationProfiles`, then `/reload`. That list also replaces rather than extends the shipped value.

## Run a fresh benchmark

This extension is **opt-in**, not part of the package's auto-loaded extensions. From a local checkout, with models and credentials already configured:

```bash
pi -e ./bench/index.ts
```

Explicitly authorize a campaign inside that Pi session:

```text
/delegate-calibrate {"out":"/tmp/delegate-calibration-new","budgetUsd":5,"localThinking":"low"}
```

This permits up to a **$5 API-metadata budget, not a provider billing cap**. Nothing runs until the command is invoked. The output path must be absolute, have an existing parent, and **not exist yet**. Artifacts are private and retained until you remove them; move `calibration.json` somewhere persistent before configuring it. Do not store it in an installed package clone.

Defaults: 8 synthetic recon tasks × 2 repeats × 2 models = 32 sequential children, using production recon tools and the custom prompt.

| JSON argument | Default / constraint |
|---|---|
| `out` | Required; new absolute directory |
| `budgetUsd` | Required; positive API-metadata budget |
| `localModel` | Configured recon model; must be classified as local |
| `alternativeModel` | Its mapped hosted alternative |
| `localThinking` | `low` |
| `alternativeThinking` | Alternative's configured level, otherwise `low` |
| `repeats` | 2; range 1–10 |
| `maxRequests` | 12 per child; range 1–100 |
| `timeoutMs` | 120000 per child; range 1000–900000 |

To calibrate shipped production Qwen at `off`, pass `"localThinking":"off"`. A low-thinking profile intentionally will not match off-thinking production runs.

Both models receive fresh copies of identical fixtures, tasks and strict expected results. They choose their own tool sequence; any fixture mutation fails scoring. Execution order alternates. Raw RPC events, native sessions, task results, budget receipts, frozen manifest/prompt and failed evidence remain in the output directory. Interrupted/unpaired runs stay in their individual artifacts, not counted as completed pairs.

A profile is published only after the full campaign completes with at least four distinct mutually successful, fully recorded tasks. This is a **small recon pilot**, not evidence of general coding/review quality. Broader workloads need their own profiles and suites.

`/delegate-calibrate-cancel` or closing the benchmark session cancels work and retains evidence. The runner never starts/stops servers, changes GPU fans or imports old comparisons. Run it with the local server ready and other local work idle; it does not coordinate local slots with other Pi sessions. Use `/delegate-local off` and wait for `OFF · idle` to pause ordinary delegates in participating sessions sharing the agent directory. This opt-in runner deliberately bypasses that switch; other local clients still need separate coordination. Restore `/delegate-local on` afterward.

### Budget and permission limits

- Each child must acknowledge a budget guard before receiving its task.
- Before each provider request, the guard reserves a conservative amount using declared context/output limits and the largest configured rates, including tiers. Finalized usage refunds unused reservation; missing usage retains it and stops further requests.
- Receipts must reconcile with raw request counts and priced usage before another model run starts. Malformed/stale receipts, changed thinking/tools, larger model limits or different prices refuse further dispatch.
- Request limits, timeouts, recording failures and unresolved spend stop the campaign. Guard refusals terminate the dedicated process; ordinary Pi hook exceptions are not a request veto. Compaction is disabled.
- A budget too small for one worst-case request refuses before spawning. Provider metadata, internal retries and billing rules prevent invoice-level guarantees: **use provider-side limits too**.

**Fixture directories are not a sandbox.** Tools, including `bash`, retain system permissions and provider access. Synthetic fixtures contain no user source code, but children are not filesystem-confined. Use trusted prompts, models and configuration.

## Profile matching

At launch, a profile must match both model IDs, kind, both thinking levels, tool set and exact custom prompt hash. Newly selected profiles must be no older than 90 days. Model/settings changes require matching calibration; a provider changing a model behind the same ID cannot be detected automatically.

Profiles are trusted local JSON data, schema-validated and limited to 256 KiB each. Missing, stale or invalid profiles never block delegation; `/delegate-stats` explains why savings are unavailable.

Profiles record successful-pair prompt/output ratios, the alternative's observed cache shares, sample counts, total-token ratio range and failed/incomplete-pair counts. Calibration is **conditional on success**, not a success-adjusted economic guarantee. Small or unrepresentative samples can predict poorly; an observed range is not a confidence interval.

## How estimates work

For each recorded local inference request:

```text
predicted prompt = (input + cacheRead + cacheWrite) × calibrated prompt ratio
predicted output = output × calibrated output ratio
predicted prompt buckets = predicted prompt × alternative's calibrated cache shares
estimated USD = sum(predicted buckets × reference API rates) / 1,000,000
```

Local KV hits are not treated as API cache hits. Reasoning is already in output. Pricing tiers apply to each projected request, not session totals; the real alternative could use different request shapes or caching.

Known positive input/output rates are required; all-zero placeholders are unavailable. Rates come from Pi's model registry, not invoices. Electricity, hardware and parent coordination are not subtracted. The baseline is the same task delegated to the hosted alternative.

Validated calibration and public rates are snapshotted per run, without credentials. Historical reports/rebuilds use those snapshots, not today's profiles/prices; legacy runs receive no retroactive calibration. Estimates use the same deduplication and reconstruction rules as token accounting.

Only complete, successful local runs earn estimates. The footer updates on finalization; `/delegate-stats` reports coverage, references, ratios, sample diagnostics and capture dates. See the [metric definitions](../delegate/README.md#usage-and-reports) for `!estimate`, `!partial` and `!archive`.
