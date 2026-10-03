# Historical delegate eval pilot

Developer-only matched-task evaluations for prompt, model or reasoning changes. Six small fixtures reproduce **failure patterns**, not entire historical projects or sessions. They contain no private log dumps, user data, credentials or machine paths. The runner never reads your historical archives.

| Case | Role | Pattern |
|---|---|---|
| missing-directory | implement | Refusing an authorized new file because its directory is absent |
| test-ownership | implement | Confusing test-file ownership with permission to run tests |
| complete-deliverables | implement | Finishing only part of a multi-part request |
| cross-repo-path | recon | Searching only cwd rather than the supplied related repository |
| realized-menu-diagnosis | recon | Unsupported root cause instead of tracing realized-menu parenting |
| isolated-cli-test | implement | Completing a CLI regression with explicitly permitted subprocess validation |

`cases.ts` records originating run IDs and observed failures for provenance. The menu and CLI cases are **synthetic proxies**, not real GTK or Pi integration tests. The CLI case does not demonstrate that a restriction caused the historical premature stop. These simple cases cannot establish general coding quality.

Candidate role prompts in `prompts/` are eval-only. They are not loaded by the extension, do not change production defaults, and are excluded from npm along with this entire directory. Promotion requires manual review and a separate approved change.

## Setup and planning

Use a source checkout, Node 22.19+ and `pi` on PATH. Model calls need configured Pi model access. No extra npm dependencies are required. Each arm explicitly supplies model, thinking, model limits and both role prompts; the runner does not inherit delegate defaults or substitute models/levels. The guard rejects mismatched/clamped thinking or model metadata before provider dispatch.

Create an absolute JSON config file outside the checkout. Example **local-only** prompt comparison; replace `/absolute/pi-delegate` with your checkout and verify model limits against your Pi model metadata:

```json
{
  "out": "/tmp/delegate-history-new",
  "budgetUsd": 0,
  "repeats": 2,
  "timeoutMs": 120000,
  "maxRequests": 12,
  "arms": [
    {
      "id": "baseline",
      "model": "local-qwen38/qwen38-q4km",
      "thinking": "off",
      "contextWindow": 65536,
      "maxTokens": 32768,
      "prompts": {
        "recon": "/absolute/pi-delegate/delegate/prompts/recon.md",
        "implement": "/absolute/pi-delegate/delegate/prompts/implement.md"
      }
    },
    {
      "id": "candidate",
      "model": "local-qwen38/qwen38-q4km",
      "thinking": "off",
      "contextWindow": 65536,
      "maxTokens": 32768,
      "prompts": {
        "recon": "/absolute/pi-delegate/bench/evals/prompts/recon.md",
        "implement": "/absolute/pi-delegate/bench/evals/prompts/implement.md"
      }
    }
  ]
}
```

From the checkout:

```bash
npm run eval:historical -- --plan /tmp/delegate-history-config.json
# Inspect the plan, then explicitly launch real model calls:
npm run eval:historical -- --run /tmp/delegate-history-config.json
```

`--plan` validates options and reads prompts without writes, model calls or server probes. `out` must be a new absolute path outside the source checkout, with an existing parent. Two arms × six cases × two repeats means **24 child runs**, not 24 provider requests. Defaults are one repeat, 120 seconds and 12 provider requests **per run**; supported bounds are 2–8 arms, 1–5 repeats, 1–32 requests and 1–900 seconds. Optional `caseIds` selects a nonempty, duplicate-free subset of the table's IDs.

For a hosted arm, supply its actual `model`, supported `thinking`, limits and a `pricing` snapshot with `input`, `output`, `cacheRead`, `cacheWrite` rates per million tokens and optional `tiers` (see [calibration](../README.md)). Set a positive campaign-wide `budgetUsd` that covers at least one conservative full-context/output reservation. Every provider dispatch passes the existing budget guard; missing or unreconciled usage stops the campaign and marks spend incomplete. API-metadata estimates are **not actual charges, subscription cost or a provider billing cap**; use provider limits too. SIGINT/SIGTERM abort the active child and retain evidence.

Vary one factor at a time: identical models/thinking for prompt comparisons, identical prompts for model comparisons, then reasoning comparisons. Fresh files per arm and rotating arm order reduce contamination; repeat trials rather than treating one sample as a model ranking.

## Safety and results

- **No sandbox.** Models and validation code have your system permissions. Scope checks detect some fixture changes afterward; they do not prevent shell writes or network access. Use trusted models/prompts and fixtures. `offline` is not a network sandbox.
- Coordinate local clients yourself; this runner bypasses ordinary delegate scheduling and shared capacity. It never starts/stops servers or changes model, credential, calibration or extension configuration.
- Output is private (0700 directories, 0600 files) and retained until you remove it. Keep it outside Git; it can contain sensitive tool output despite sanitized initial fixtures.
- Implementation checks run the unchanged fixture tests with bounded Node subprocesses and an allowlisted environment. Readonly test changes, unexpected files/directories and symlinks fail scope checks. Validation is skipped when scope is invalid. Recon checks match expected evidence strings only.

`manifest.json` freezes prompt hashes, suite hash, model/limit/pricing settings and provenance. Each run saves copied fixtures, native session, raw events, answer, requested tools, elapsed model runtime, usage/budget receipt, scope changes and independent test/evidence checks. `summary.json` compares narrow check counts, worker completion, median runtime, tool calls, tokens and metadata cost. Runtime excludes subsequent independent fixture validation.

**Manual review remains required:** inspect claims, citations, contradictions, partial completion, tests actually requested/run, scope and blockers. Keyword matching and passing small fixture tests are not a general correctness verdict. Limited, cancelled, receipt/recording failures and incomplete campaigns must not be presented as complete comparisons. A request/budget/recording failure stops further runs; collected evidence remains available.

## Offline harness validation

```bash
node --test --experimental-strip-types bench/tests/historical-eval.test.ts
npm run test:unit
npm run check:package
```

Tests use injected workers and actual tiny fixture validation subprocesses, never model calls. The repository's normal CI includes the eval harness test and verifies the npm runtime allowlist; installed npm packages contain neither evals nor developer tests.
