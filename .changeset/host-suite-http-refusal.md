---
"@smthrs/kernel": minor
"@smthrs/testing": patch
---

`HttpClient.layerNoop()` now refuses with an `HttpClient.HttpUnavailable`
cause on its `TransportError` reason, and `HttpClient.isUnavailable(error)`
tells that refusal apart from a live request that failed in the network. The
message is unchanged.

`HostSuite`'s unsupported `httpTransport` case accepts only that refusal. A
bundle wired to a real fetch client used to pass it, because a failed DNS
lookup for the probe address raises the same `TransportError`.

`FlowEngineLike` forgets a submission the engine refused, so a later `run`
with the same execution id or idempotency key submits again instead of
waiting forever.
