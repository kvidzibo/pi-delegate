# Model intelligence and cost comparison

**Last updated:** 2026-11-21 (UTC).

Sonnet 5.5 was verified for this update. Sol 6.2, Astra 6.2, and Gemini 4 Neon retain the 2026-11-20 snapshot. Fable 5.2 retains the 2026-11-14 snapshot; all other columns retain the 2026-11-07 snapshot.

A reference snapshot for choosing delegate models, not measured Pi-delegate performance or an automatic role configuration. Model availability and supported reasoning levels depend on your provider; select them in `/pi-delegate roles`.

Each cell: **score / USD**. Artificial Analysis Intelligence Index v5.0.1; scores rounded to integers and costs to three decimal places.

| Thinking | Terra 6.1 | Sol 6.2 | Luna 6 | Astra 6.2 | Gemini 4 Neon | Sonnet 5.5 | Grok 4.7 | Opus 5.5 | Fable 5.2 | Kimi K3.1 Pro |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| None | 31 / $0.226 | — | 9 / $0.071 | — | — | — | — | — | — | — |
| Low | 29 / $0.071 | 41 / $0.184 | 10 / $0.005 | 46 / $0.662 | 44 / $0.745 | 26 / $0.511 | 31 / $2.922 | 35 / $0.976 | 54 / $3.097 | — |
| Medium | 38 / $0.169 | 53 / $0.406 | 18 / $0.042 | 57 / $1.618 | 55 / $1.905 | 31 / $0.781 | — | 48 / $2.451 | 56 / $3.803 | — |
| High | 42 / $0.259 | 55 / $0.564 | 21 / $0.073 | 60 / $2.074 | 60 / $3.743 | 42 / $1.636 | 35 / $6.184 | 52 / $3.465 | 62 / $9.078 | — |
| Xhigh | 45 / $0.401 | 56 / $0.648 | 23 / $0.104 | 62 / $2.521 | 61 / $6.445 | 50 / $4.092 | 35 / $7.772 | 57 / $6.047 | 62 / $14.829 | — |
| Max | 51 / $0.961 | 57 / $1.014 | 28 / $0.152 | 62 / $3.998 | — | 55 / $10.021 | — | 59 / $10.036 | 65 / $26.539 | 46 / $3.681 |

Costs are weighted averages per Artificial Analysis benchmark task, **not per chat request**. — = no result listed. Claude results use AA’s “Default Fallback” configuration; effort labels aren’t equivalent across providers. Kimi K3.1 Pro’s single listed result uses AA’s Max-effort configuration.

## Updating this snapshot

Recheck every listed model and thinking level against the source pages below, using the same Intelligence Index version throughout. Record the verification date and index version, round scores to integers and USD costs to three decimal places, and keep missing results as — (not zero). Use the weighted **cost per Intelligence Index task**, not the blended token price. Preserve the evaluated model versions and Claude configuration labels; mark any rows not reverified rather than implying a full refresh. This is a manual snapshot; scores, pricing and available models can change.

## Sources

- [Terra 6.1](https://artificialanalysis.ai/models/releases/gpt-6-1-terra)
- [Sol 6.2](https://artificialanalysis.ai/models/gpt-6-2-sol)
- [Luna 6](https://artificialanalysis.ai/models/releases/gpt-6-luna)
- [Astra 6.2](https://artificialanalysis.ai/models/gpt-6-2-astra)
- [Gemini 4 Neon](https://artificialanalysis.ai/models/gemini-4-neon)
- [Grok 4.7](https://artificialanalysis.ai/models/releases/grok-4-7)
- [Sonnet 5.5](https://artificialanalysis.ai/models/claude-sonnet-5-5)
- [Opus 5.5](https://artificialanalysis.ai/models/releases/claude-opus-5-5)
- [Fable 5.2](https://artificialanalysis.ai/models/claude-fable-5-2)
- [Kimi K3.1 Pro](https://artificialanalysis.ai/models/kimi-k3-1-pro)
