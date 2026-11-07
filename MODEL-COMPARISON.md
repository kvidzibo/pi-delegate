# Model intelligence and cost comparison

**Last updated:** 2026-11-07 (UTC).

GLM-5.3-Flash and DeepSeek V4.1 Flash 1017 are the latest releases in AA’s [Z AI](https://artificialanalysis.ai/models/creators/zai) and [DeepSeek](https://artificialanalysis.ai/models/creators/deepseek) catalogues, source-verified on 2026-11-07. Other columns retain the earlier 2026-11-07 snapshot and were not reverified for this update.

A reference snapshot for choosing delegate models, not measured Pi-delegate performance or an automatic role configuration. Model availability and supported reasoning levels depend on your provider; select them in `/pi-delegate roles`.

Each cell: **score / USD**. Artificial Analysis Intelligence Index v5.0.1; scores rounded to integers and costs to three decimal places.

| Thinking | Terra 6.1 | Sol 6.1 | Luna 6 | Astra 6 | Grok 4.7 | Opus 5.5 | Fable 5.1 | GLM-5.3-Flash | DeepSeek V4.1 Flash 1017 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| None | 31 / $0.226 | — | 9 / $0.071 | — | — | — | — | — | 19 / $0.425 |
| Low | 29 / $0.071 | 35 / $0.161 | 10 / $0.005 | 43 / $1.424 | 31 / $2.922 | 35 / $0.976 | 39 / $4.471 | — | — |
| Medium | 38 / $0.169 | 46 / $0.359 | 18 / $0.042 | 52 / $2.732 | — | 48 / $2.451 | 43 / $5.564 | — | — |
| High | 42 / $0.259 | 50 / $0.591 | 21 / $0.073 | 55 / $3.239 | 35 / $6.184 | 52 / $3.465 | 47 / $7.540 | — | 29 / $0.456 |
| Xhigh | 45 / $0.401 | 52 / $0.764 | 23 / $0.104 | 55 / $3.659 | 35 / $7.772 | 57 / $6.047 | 50 / $10.847 | — | — |
| Max | 51 / $0.961 | 55 / $1.272 | 28 / $0.152 | 57 / $6.245 | — | 59 / $10.036 | 49 / $12.994 | 28 / $0.583 | 33 / $0.602 |

Costs are weighted averages per Artificial Analysis benchmark task, **not per chat request**. — = no result listed. Claude results use AA’s “Default Fallback” configuration; effort labels aren’t equivalent across providers. GLM-5.3-Flash’s single reasoning result uses AA’s Max classification, not necessarily a provider setting. DeepSeek’s non-reasoning result maps to None.

## Updating this snapshot

Recheck every listed model and thinking level against the source pages below, using the same Intelligence Index version throughout. Record the verification date and index version, round scores to integers and USD costs to three decimal places, and keep missing results as — (not zero). Use the weighted **cost per Intelligence Index task**, not the blended token price. Preserve the evaluated model versions and Claude configuration labels; mark any rows not reverified rather than implying a full refresh. This is a manual snapshot; scores, pricing and available models can change.

## Sources

- [Terra 6.1](https://artificialanalysis.ai/models/releases/gpt-6-1-terra)
- [Sol 6.1](https://artificialanalysis.ai/models/releases/gpt-6-1-sol)
- [Luna 6](https://artificialanalysis.ai/models/releases/gpt-6-luna)
- [Astra 6](https://artificialanalysis.ai/models/releases/gpt-6-astra)
- [Grok 4.7](https://artificialanalysis.ai/models/releases/grok-4-7)
- [Opus 5.5](https://artificialanalysis.ai/models/releases/claude-opus-5-5)
- [Fable 5.1](https://artificialanalysis.ai/models/releases/claude-fable-5-1)
- [GLM-5.3-Flash](https://artificialanalysis.ai/models/glm-5-3-flash) (chart data also available on the [GLM-5.3 release page](https://artificialanalysis.ai/models/releases/glm-5-3))
- [DeepSeek V4.1 Flash 1017](https://artificialanalysis.ai/models/releases/deepseek-v4-1-flash-1017)
