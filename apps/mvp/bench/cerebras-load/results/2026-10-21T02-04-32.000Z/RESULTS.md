# Cerebras load test

apps/mvp/bench/cerebras-load/results/2026-10-21T02-04-32.000Z/

Stopped: errors_above_20_percent. Charged token upper bound: 234458; estimated USD 0.24773.

## Burst observations

These burst observations do not establish sustained throughput.

| Concurrent | Requests/s | OK / 429 / other | TTFT p50/p95/p99 ms | Total p50/p95/p99 ms | Output tok/s | Est. USD |
|---:|---:|---:|---|---|---:|---:|
| 1 | 0.7 | 1 / 0 / 0 | 681.3/681.3/681.3 | 1011.1/1011.1/1011.1 | 180.1 | 0.0018 |
| 10 | 3.2 | 11 / 0 / 0 | 533.3/2192.5/2579.1 | 813.8/2614.1/2920.1 | 815.3 | 0.0200 |
| 25 | 5.0 | 27 / 0 / 0 | 489.2/1206.7/1317.6 | 784.9/1475.0/1573.7 | 1273.3 | 0.0543 |
| 50 | 6.4 | 52 / 0 / 0 | 838.0/4315.4/4835.7 | 1072.2/4613.5/5197.2 | 1626.0 | 0.1101 |
| 100 | 9.0 | 31 / 71 / 0 | 625.5/1692.1/2325.5 | 974.8/2183.6/2592.1 | 702.6 | 0.0616 |

```text
  1  p95 ########### 1011.1ms  errors  0.0%
 10  p95 ########################### 2614.1ms  errors  0.0%
 25  p95 ############### 1475.0ms  errors  0.0%
 50  p95 ############################################### 4613.5ms  errors  0.0%
100  p95 ###################### 2183.6ms  errors !!!!!!!!!!!!!!!!!!!!!!!!!!!! 69.6%
# = 100ms p95 total latency; ! = 2.5 percentage points errors
```

## Method and limits

Run from the repository root: `zsh -lc 'source ~/.zshrc >/dev/null 2>&1; node apps/mvp/bench/cerebras-load/run.ts'`. Offline checks: `node --test apps/mvp/bench/cerebras-load/stats.test.ts`. Each run writes raw.json, append-only requests.jsonl and journal.sqlite in a unique results directory. SDK route: HostModel.layerConfig(CHAT_MODEL, the endpoint default), openai-chat through @smthrs/model; every probe is an @smthrs/flow action recorded by the Node SQLite engine. No HTTP request is hand-written. Fetch only observes an allowlist of rate-limit headers. Provider error bodies, prompts, output and credentials are never recorded.

Closed-loop workers, concurrency 1/10/25/50/100/200, 1-second admission windows at each level, followed by drain (45-second request deadline). Immediately replace each completed request; no retry. Stop escalating when combined errors exceed 20%. 95% synthetic chat context ~1.5k input tokens, 5% ~7k; actual provider usage retained; maxTokens 256. The measured final ramp sets reasoningEffort none through the SDK so the 256-token cap produces chat text; TTFT is first text (or thinking, if emitted) delta. Initial default-reasoning calibrations had no decoded token deltas and are excluded from the final ramp. Total latency and TTFT are successful calls only; failures retain their individual latency in raw evidence. Aggregate output tok/s includes reasoning, over the full step including drain. Decode tok/s p50 is separately retained; a short output and client buffering limit its accuracy.

Before every dispatch reserve UTF-8 prompt bytes + 128 input tokens and 256 output tokens at $0.99/$1.49 per million input/output. Admission refuses any reservation crossing 2M tokens or $5, including in-flight requests. Complete usage settles reservations; clean 4xx refusals charge zero; unknown usage retains the upper bound. This is an estimated API cost cap, not a billing guarantee. Source: [SDK pricing table](../../../../../../packages/smithers/agent/model/src/internal/prices.generated.ts), [Cerebras pricing](https://www.cerebras.ai/pricing).

One Mac client, one outbound network region (not independently geolocated), one evening in America/Los_Angeles on 2026-10-20. Shared organization limits and concurrent eval traffic can affect results; no isolated account or cooldown between steps. This measures the provider route, not deployment auth, database, app latency or hundreds of people. Closed-loop offered load, shared prompt caching, short outputs, and SQLite overhead limit extrapolation. Unreached levels are unmeasured.

## Capacity scenarios and draft for Will

DAU alone does not imply throughput. Assume 10 agent calls/DAU/day (an ask may need multiple calls), an 8-hour active window, peak 10x that window's average, no cache credit, and 2x capacity headroom. At 8k tokens/call, 100/300/1,000 DAU imply 8/24/80M tokens/day; peak 21/63/209 RPM and 167k/500k/1.67M TPM; request provisioned limits of 42/125/417 RPM and 334k/1M/3.34M uncached TPM.

Today's latest saved passing eval (evals/results/agent-2026-10-21T01-25-16-080Z.json) reports 31 agent calls, 291,989 input + 18,610 output = 10,019 tokens/call. Using that more conservative observed average: 10.02/30.06/100.19M tokens/day; headroom targets 0.42/1.26/4.18M uncached TPM with the same RPM targets. The baseline.json contains scores, not usage; this usage receipt is the evidence. Costs and DAU assumptions are planning scenarios, not observed product usage.

[Published tier limits](https://inference-docs.cerebras.ai/support/rate-limits), checked 2026-10-20: Developer Qwen 150k uncached TPM, temporarily 750k total TPM and 300 RPM; Enterprise custom. Under these uncached peak/headroom assumptions all three scenarios need custom Enterprise limits; Developer can serve lower peaks or effective caching, which this run cannot guarantee. Our observed account headers may differ from published defaults.

Draft (Will sends): “We load-tested qwen-3.8-27b through our Smithers SDK from one Mac client on Oct 20. At concurrency 1: 1 requests, 0 HTTP 429s, 0 other failures, p95 TTFT 681.3ms and total 1011.1ms; At concurrency 10: 11 requests, 0 HTTP 429s, 0 other failures, p95 TTFT 2192.5ms and total 2614.1ms; At concurrency 25: 27 requests, 0 HTTP 429s, 0 other failures, p95 TTFT 1206.7ms and total 1475.0ms; At concurrency 50: 52 requests, 0 HTTP 429s, 0 other failures, p95 TTFT 4315.4ms and total 4613.5ms; At concurrency 100: 102 requests, 71 HTTP 429s, 0 other failures, p95 TTFT 1692.1ms and total 2183.6ms. We stopped at errors_above_20_percent, spending approximately $0.2477 and 234458 tokens. Please confirm our organization/project limits, whether 429s were uncached-token, total-token or request limits, and the recommended shared Enterprise or dedicated option. For staged 100/300/1,000 DAU, at 10 calls/day, ~8–10k tokens/call, peak 10x active-hour average and 2x headroom, please quote 42/125/417 RPM with 0.42/1.26/4.18M uncached TPM, corresponding total-token capacity, and burst/concurrency allowances. We want to validate 100–200 simultaneous streams with stable p95 latency. What throughput/latency commitments, region options and pricing can you offer?”
