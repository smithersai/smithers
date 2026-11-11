---
title: "Polling source"
description: "Start a flow or signal a run from each event a source polls, and commit the cursor only after the control plane took it."
---

A provider that cannot call you is polled. `Core.Source.runWithCursor` is the
durable poll loop and `Core.Channel.fromSource` is its door into the control
plane: each polled event starts a flow or signals a run through
`Channels.ingest`, and the cursor advances only past events the control plane
took.

```ts
import * as Channels from "@smthrs/control/Channels"
import { Core } from "@smthrs/integrations"
import { Effect } from "effect"

const door = Core.Channel.fromSource({
  name: "chat",
  route: Core.Channel.startFlow("triage")
})

// Once, at host startup.
const register = Effect.flatMap(Channels.Channels, (channels) => channels.register(door.channel))

// Inside a flow action: poll, start one flow per event, then commit the cursor.
const receive = Core.Source.runWithCursor("chat", poll, door.handle)
```

`poll` is yours: `(cursor: string | null) => Effect<Core.Source.Batch, IntegrationError>`.
It asks the provider for what came after `cursor` and answers with the events
and the cursor that acknowledges them. Give each event a `dedupeKey` built from
the provider's own stable identity, never from the time it was received.

The flow that calls `receive` needs `Core.CursorStore` (use `layerSql` so the
position survives a restart), the `Channels` service, and a durable host. Run
one driver per source.

## What the door guarantees

- **Only the source uses it.** A polled event has no signature. The door holds
  a random pass that never leaves the process, and its channel refuses any
  delivery without it as `Unauthorized`, before decoding or routing. Mounting
  the channel's name on an HTTP route opens nothing.
- **A batch polled twice starts each flow once.** The idempotency key is the
  event's `dedupeKey` and the delivered bytes leave out `receivedAtMs`, so the
  same event fetched again after a crash answers `AlreadyApplied`.
- **The cursor never passes an undelivered event.** `handle` routes the batch
  in order and fails at the first event the control plane did not take.

## Failures

`ingest` and `handle` fail with `IntegrationError`. `details.retryable` says
whether another attempt can clear it.

| Reason            | When                                                                                          | Retryable |
| ----------------- | --------------------------------------------------------------------------------------------- | --------- |
| `decode-failed`   | The event is not a valid `Core.ExternalEvent`, or its payload is not JSON.                    | No        |
| `delivery-failed` | The control plane is unavailable, or the door is not registered (`details.control` names it). | Yes       |
| `delivery-failed` | The control plane refused the start or the signal (`details.control` names the error).        | No        |
| `delivery-failed` | The start is `Parked`: it waits for a plan approval and has not launched (`handle` only).     | Yes       |
| `delivery-failed` | The dedupe key was already used for different content (`handle` only).                        | No        |

A signal to a run that has ended answers `Terminal`, and `handle` counts it as
delivered: nothing is left to receive it. Route a source to a flow whose start
is approved ahead of time, or an unapproved plan holds the cursor in place.
