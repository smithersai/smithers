---
title: "Events, signals, and cursors"
description: "Shared integration identity, deduplication, and durable acknowledgement."
---

`Core.ExternalEvent` normalizes a source, event name, correlation, JSON payload,
dedupe key, and receipt time. `Core.SignalName` builds and validates the
`integration:<source>:<event>` namespace. A source names its own identity;
the host chooses which flow starts or which waiting run receives a signal.

`RawInbound.idempotencyKey` identifies the delivery across redelivery. Stable
provider identities prevent duplicate dispatch. Never derive it from receipt
time or omit it when a provider may redeliver.

`Core.CursorStore` retains a source's committed position. Commit a proposed
cursor only after the batch it acknowledges has been handled. Storage and
migrations remain independent of a provider adapter.

A polled event reaches the control plane through `Core.Channel.fromSource`. Its
`handle` is the batch handler of `Core.Source.runWithCursor`: every event
starts a flow or signals a run under its dedupe key, and the cursor commits
only after the control plane took the whole batch. See the
[polling source guide](../guides/polling-source.md).
