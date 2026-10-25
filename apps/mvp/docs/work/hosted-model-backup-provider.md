---
title: A backup provider for the hosted model (parked)
status: parked
area: model
owner: model-path builder
updated: 2026-10-25 13:33 PDT
links: [model-endpoint.md, cerebras-rate-limits.md, ../features/model-endpoint.md, ../rulings.md]
---

## Parked — 2026-10-25

**What:** Let a hosted model role resolve to a primary model and an optional fallback, tried when the primary refuses for quota or credit (any 402 included), a refused key or an outage before any output, while a plain rate limit stays on the primary for the caller's durable backoff.

**Why parked:** Will, 2026-10-25 13:28 PDT (Telegram): "Please get it working with byok prioritize byok over our hosted inference our hosted cerebras inference is now a wip feature flagged and not being released or documented until post initial release". Hosted inference is off in production behind a flag until after the initial release, so a backup for it waits too. Will's earlier ask stands for when hosted inference returns (2026-10-21 12:29): "it's not even clear that cerebras will approve us they denied me in past so ideally we have a backup to get very fast cerebras inference".

**Design, built and tested, not landed:**
- A role's record gains `fallback` (a record with no fallback of its own); `CHAT_MODEL_FALLBACK` is the default model's fallback; `SUMMARY_MODEL` may name its own. `ModelRoles.resolve` composes the two with `fastModelFallback` from `@smthrs/model-host` inside the one served call, so the fallback runs before any refusal reaches the browser.
- `fastModelFallback` gains `options.when` (a predicate; the app passes "unavailable, but not `rate_limited`"), falls back on `out_of_credit` and any HTTP 402, hands `onFallback` the refusal, and is exported from the package root.
- The endpoint prices and records a call by the model that answered (`End.modelId` replaced by the fallback's id), logs `model.fallback` (role, both model ids, the refusal's code) and counts `smithers_model_fallbacks` by role; a fallback the Worker can't use leaves the primary answering and logs `model.fallback.unusable`.
- Tests covered: a 402 answered by the fallback and recorded as the fallback's; a plain 429 staying on the primary; an unusable fallback; `CHAT_MODEL_FALLBACK`, malformed and working; `SUMMARY_MODEL`'s own fallback.
- The Vercel AI Gateway also falls back across the providers of one model (`providerOptions.gateway.order` prefers, the rest follow) and across models (`models`), so a gateway primary covers one provider's outage; the backup above covers the gateway account itself refusing.

**Next step:** When Will turns hosted inference back on, rebuild from this design (the patch was kept outside the repository by the model-path builder) behind the hosted-model flag, with an e2e that sees a 402 primary answered by the fallback.

**Open questions for Will:** None now.
