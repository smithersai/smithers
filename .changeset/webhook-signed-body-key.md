---
"@smthrs/integrations": minor
---

`Core.Channel.signedBodyKey(body)` derives a webhook delivery's idempotency key from the SHA-256 of its signed body. A
delivery id header is not signed, so a key read from one let a captured delivery replay under a new id and start a
second run. The webhook ingress guide now keys on the body and no longer requires an `x-delivery` header; a receiver
that keyed on that header should switch to `signedBodyKey`.
