---
name: smithers-integrations
description: Change Smithers provider clients, outbound actions, webhook ingress, or delivery retry behavior.
---

# Smithers integrations

Read [the integrations README](../../../packages/smithers/agent/integrations/README.md) and the provider's tests before changing a client, action, or webhook. Outbound write calls may have acted even when a 5xx or connection loss hides the answer: report `outcomeUnknown` rather than retrying an ambiguous write. Clients never retry: they classify a failure (`retryable`, `retryAfterMillis`) and the flow engine's `retryPolicy` around the step is the only retry; a step maps errors with `Core.ActionFailure.fromIntegrationError`. Durable provider actions are irreversible flow actions; preserve the journal receipt and do not claim a remote side effect is atomically rolled back.

For inbound webhooks, the receiver caps body size before `Channels.ingest`; the channel then verifies, decodes, maps, and dispatches. Put `Core.Channel.signedBodyKey(body)` in `RawInbound.idempotencyKey` or redelivery has no replay protection; never key on an unsigned delivery header. Test duplicate deliveries and an ambiguous outbound response.
