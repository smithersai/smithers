---
title: "Troubleshooting"
description: "GitHub credentials, refusal, replay, and uncertain writes."
---

Missing GitHub credentials fail before any request. Configure
`SMITHERS_GITHUB_TOKEN` or `GITHUB_TOKEN` in the host. Explicit client
configuration and a supplied environment take precedence.

A rate-limit refusal is `retryable` and carries the server's
`retryAfterMillis`; the retry policy of the step that made the call waits it.
The clients never retry, so a call outside a flow step gets one attempt. A
write with `outcomeUnknown` may have acted; reconcile the remote result before
retrying. A normal refusal does not claim
a remote write happened. Durable action receipts survive restart.

Shared webhook receivers must preserve signed bytes, reject oversized bodies
before ingestion, and key each delivery with `Core.Channel.signedBodyKey` for
replay protection, never with an unsigned delivery header.
