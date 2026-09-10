---
title: "Follow a run over a WebSocket"
description: "Subscribe to a projection, read the snapshot and delta frames it answers with, resume from a cursor after a disconnect, and keep an idle connection alive."
sidebar:
  order: 3
---

`Projection.Subscribe` answers a snapshot followed by a live tail. Mount it on
the socket: `/projections/ws` is where the streaming half of the read path
belongs, because a request/response route would have to buffer the whole
stream.

## Subscribe

```ts
import { Projections } from "@smthrs/gateway/Projections"
import { Effect, Stream } from "effect"

const frames = Effect.gen(function*() {
  const projections = yield* Projections
  return projections.subscribe({ _tag: "run-summary", runId })
})
```

Over the wire, the request frame is the same shape as a snapshot's, with
`Projection.Subscribe` as the tag:

```json
{
  "_tag": "Request",
  "id": 1,
  "tag": "Projection.Subscribe",
  "payload": { "selector": { "_tag": "run-summary", "runId": "run-1" } },
  "headers": []
}
```

Send it on `/projections/ws` immediately after the upgrade. The socket is a
protected path, so a gateway bound with a credential needs
`Authorization: Bearer <token>` on the upgrade request itself. Node's global
`WebSocket` cannot set headers on an upgrade, so a credentialed client needs a
socket library that can, or a relay that adds the header for it.

## Read the frames

```text
snapshot-start   the snapshot begins, at this cursor
row              one row of the snapshot, repeated
snapshot-end     the snapshot is complete
delta            the selector's rows after one change
heartbeat        nothing changed, the connection is alive
```

Three rules make the tail easy to consume:

- **A delta is the whole row set**, recomputed rather than patched. Replace
  what you hold; do not merge. `run-events` is the exception, because its rows
  are the events themselves, so its delta is the one event that arrived.
- **The snapshot and the tail share one reconciled event buffer**, so a client that follows
  from the advertised cursor sees each later change exactly once.
- **Every frame but the heartbeat carries its selector**, so several
  subscriptions can share one socket.

## Resume after a disconnect

Keep the cursor from the last frame of a complete snapshot, or from the last
delta, and pass it as `after`. The subscription skips the snapshot and answers
only the deltas past it:

```ts
const resumed = projections.subscribe({ _tag: "run-summary", runId }, lastCursor)
```

```json
{
  "_tag": "Request",
  "id": 1,
  "tag": "Projection.Subscribe",
  "payload": {
    "selector": { "_tag": "run-summary", "runId": "run-1" },
    "after": {
      "selector": { "_tag": "run-summary", "runId": "run-1" },
      "projection": "run-summary",
      "runId": "run-1",
      "value": 6,
      "offset": 0
    }
  },
  "headers": []
}
```

Send back the cursor exactly as it arrived. It embeds the selector that issued
it, so a cursor from another selector, another run, or another projection is
refused with `malformed_request` rather than quietly resuming the wrong thing.
The full refusal list is in
[Subscriptions and cursors](../concepts/subscriptions.md#resuming).

Every snapshot frame carries the same cursor: the position the whole read
reached, not progress through delivery. Buffer the rows from `snapshot-start`
and commit them, and the cursor, only when `snapshot-end` arrives. If the
connection drops before `snapshot-end`, discard the partial snapshot and
re-subscribe without `after`. Resuming from a row you received before the cut
is accepted, because the cursor is valid, and answers only the deltas past the
snapshot, so the rows you never received are gone from your view until you
take a fresh snapshot.

A workspace subscription cannot resume. Re-subscribe without `after` and take
the snapshot again.

## Keep an idle connection alive

A followed subscription that has nothing to report emits a `heartbeat` every 30
seconds. A relay cuts an idle tunnel at 600 seconds, so this is what keeps a
quiet run's followers connected. If something in front of your gateway cuts
sooner, shorten the cadence at the bind:

```ts
import * as NodeGateway from "@smthrs/gateway/node/NodeGateway"

const gateway = NodeGateway.layer(health, { host: "127.0.0.1", port: 7331, heartbeatMillis: 10_000 })
```

One option governs both keepalives: the `Projection.Subscribe` heartbeat on
`/projections/ws` and the `Watch` keepalive on `/rpc/ws`. Unset, `Watch` beats
every 30 seconds and the projection socket beats at whatever cadence the
supplied `Projections` service was built with, which is also 30 seconds for
`Projections.layer`. To shorten the projection cadence alone, build the read
path with `Projections.layerWith({ heartbeatMillis: 10_000 })` instead.

`heartbeatMillis` must be a positive safe integer. Zero would turn the
keepalive into a tight loop, so a composition that asks for it is refused with
`bind_failed` before anything binds.

## Following the control plane instead

`ControlRpcs.Watch` on `/rpc/ws` follows a run's raw control events rather than
a projection, and the gateway merges the same kind of keepalive into it. It
arrives as a `ControlEvent` whose kind is
`GatewayServer.watchHeartbeatKind`, the literal `control.gateway.heartbeat`,
because `Watch` has no frame type of its own for a keepalive.

Ignore that kind, as every fold in this package already does with an unknown
kind. It repeats the last delivered sequence, so resuming from the last
sequence you saw does not rewind, and it carries the watched run id so routing
by run keeps working. A snapshot read, `follow: false`, never carries one: it
has to end.

For what `Watch` itself answers, see
[Watch a run](/pkg/control/guides/watch-a-run).
