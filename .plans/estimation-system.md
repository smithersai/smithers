# Estimation and the self-improving loop

Every piece of work the TUI runs gets a time and token estimate, and every
estimate is scored when the work settles. The scores feed the next estimate.

## The loop

```
  work requested
       |
       v
  predict ------------------> ledger: prediction {id, key, method, raw, value, low, high}
   ^   uses history + error stats
   |                                  work settles
   |                                       |
   |                                       v
  calibrate <---- score <---- observe ---> ledger: observation {id, actual, outcome}
```

`apps/tui/src/improve.ts` owns the loop and knows nothing about time or
tokens. It is generic over named metrics (`ms`, `tokens`).

| Step | Contract |
| --- | --- |
| predict | The instance returns a **raw** prediction for a subject. |
| record | `Ledger.predict` calibrates raw into the shown value and appends both. One prediction per id. |
| observe | `Ledger.observe` appends the actual. One observation per id. An observation without a prediction is still history. |
| score | Per metric: `ratio = actual / value` (shown) and `rawRatio = actual / raw`, plus whether the actual fell inside `[low, high]`. Only `done` work is scored. |
| calibrate | Bias is the geometric median of `rawRatio` over the last 30 scored predictions of the same method and kind. From 3 samples the raw value is multiplied by it. From 5 samples the interval is the 10th to 90th percentile of the residual ratios. |
| feed back | The instance puts recent scored examples (estimate next to actual) and the error stats into its next prompt. |
| fail | A predictor that errors or answers nothing usable appends a typed failure `{id, method, reason, message}` before any fallback stands in, so a fallback never poses as the method. The first failure toasts once. |

Calibration is fitted on raw predictions, never on calibrated ones, so the
prompt feedback and the multiplier cannot correct the same bias twice: if the
prompt removes the bias, the multiplier decays to 1.

Errors are log ratios. Durations and token counts are multiplicative: a 2x
miss on a 1-minute task and a 2x miss on a 1-hour task are the same miss.

The ledger is an append-only JSONL file. Folding it rebuilds every stat, so a
reload, a crash, or a second process loses nothing but in-flight work.

## First instance: time and tokens (`apps/tui/src/estimate.ts`)

| Work | Key | Method |
| --- | --- | --- |
| Chat turn | `turn:<seat>` | history of the same seat |
| Flow run | `flow:<name>` | history of the same flow; model when the flow never ran |
| Delegate | `delegate` | model (GPT-6 Luna), with the 12 past delegates whose subjects share the most words (Jaccard) as examples; class median without a model or after a recorded model failure |

Actuals come from the session records: duration is the sum of each request to
its outcome, so idle time between a worker's turns and queue time before its
launch are not work; tokens are the `usage.totalTokens` of every
`model-settled` event. Flow runs report no token usage, so they score duration
only. Each retry or resume of a flow run is a new attempt with its own id and
clock (`flow:<id>:<attempt>:<startedAt>`), estimated and scored on its own.

The model's prompt shows its earlier estimate only on examples it estimated,
and its error ratio is fitted on the `model` method alone.

The model call sends no token budget: the ChatGPT-subscription route refuses
`maxTokens` and no seat says which routes honor one.

The ledger lives at `<session dir>/<cwd slug>/evals/estimates.jsonl`. Worker
transcripts already on disk seed delegate history on first use.

The estimate shows on a running tab as `~7m·250k` (remaining time, total
tokens), on a queued tab as its whole estimate, and beside the elapsed time of
a working chat turn. The `tab.eta` flow answers "what is the ETA on all
tasks"; a queued tab's remaining time includes its wait for the first of three
worker seats to free.

## Adding another loop

Name a loop, choose its metrics and key, write its raw predictor, and call
`predict` when work starts and `observe` when it settles. Reuse `Ledger` for
recording, scoring and calibration.
