---
title: "The sync policy"
description: "How an Electric collection retries shape requests on an Effect Schedule, what reconnect does, what happens when a schedule ends, and how sync events map to offline, reconnecting and up to date."
---

An Electric collection sends shape requests for as long as it lives: a first
load (from the start, or from a stored handle and offset when the collection is
persisted), and long polls for changes. The sync
policy decides how long a request waits before it is sent again after a
failure.

## What counts as a failure

A request that fails on the network, its body breaking off included, or that
Electric or a proxy answers with a 5xx or 429, is a failure. The collection publishes `Failed` on `sync` (with the
`status` when there was one), steps the policy with a `ShapeSource.RequestFailed`, waits
the delay the policy returns, and sends the request again.

A 4xx other than 429, or a response that can't be read or decoded, is not
retried: Electric stops the shape (`Stopped`) until `reconnect`. A 2xx whose
body ends but isn't a whole batch (cut short, empty, or not Electric's, such as
a gateway's HTML page) stops it too, with no status. The collection reads every
2xx batch of the shape's log in full before Electric sees it, because Electric takes a response's
offset from its headers before it reads the body, and would skip that batch
when the shape restarts. So the shape stops before Electric takes the offset,
and `reconnect` sends the same request again: no row is skipped. A 2xx of the
shape's log without Electric's headers (`electric-handle`, `electric-offset`,
and `electric-cursor` on a live request or `electric-schema` on any other)
stops it the same way, before Electric sees it. A request Electric aborts
itself is neither a success nor a failure.

A whole batch can still stop the shape. A row the collection's schema refuses,
or a `parser` that throws, stops it after Electric took the batch's offset:
restarted where it stopped, the shape would ask from the offset after that
batch and skip every row in it. So `reconnect` never lets Electric restart a shape in
place: it ends the shape's session and starts a new one from the last batch
the collection committed, or from the start if it committed none. The batch is
asked for again: its rows arrive once they all decode, and until then it stops
the shape again.

## The policy is a `Schedule`

Pass any `Schedule.Schedule<unknown, ShapeSource.RequestFailed>` as `retry`:

```ts
import { ElectricCollection, SyncPolicy } from "@smthrs/effect-electric"
import * as Schedule from "effect/Schedule"

ElectricCollection.make({
  // ...
  retry: SyncPolicy.backoff({ initial: "500 millis", max: "30 seconds" })
})

ElectricCollection.make({
  // ...
  retry: Schedule.spaced("2 seconds").pipe(Schedule.upTo({ times: 10 }))
})
```

`SyncPolicy.backoff({ initial, max })` waits `initial`, doubling after each
failure in a row up to `max`, forever. Each wait is jittered to between 80% and
120% of its delay (`Schedule.jittered`), so devices that lost the same server
don't all return at once.

`SyncPolicy.defaultPolicy` is `backoff({ initial: "1 second", max: "10 seconds" })`.
A collection given no `retry` uses it, so a device that went offline syncs
again by itself within about 10 seconds of coming back.

## `retry-after`

A 5xx or 429 that carries `retry-after` says how long the server needs. The
collection reads it, as delay seconds or an HTTP date, into the failure's
`retryAfterMs` (at most `SyncPolicy.MAX_RETRY_AFTER_MS`, 1 minute), and waits
at least that long, whatever the policy's delay: the default policy would
retry a `503` with `retry-after: 5` after about 1, 2 and 4 seconds, each sent
before the server is ready, and now waits 5 seconds each time. A longer policy
delay stands. `reconnect` still ends the wait at once. Apply the same floor to
your own schedule with `SyncPolicy.respectingRetryAfter(schedule)`; the
collection applies it to every `retry`.

## `reconnect`

`reconnect` ends every wait at once: each request waiting out the policy is
sent now. It also restarts a stopped shape, keeping its rows, as a new Electric
stream from the last batch the collection committed. A shape restarts however
many times in a row it stopped; `@electric-sql/client` 1.5.28's own restart
gives up after 50.
Call it when the device comes back online, or when a person asks to try again.
After `evict`, the shape's next request asks from the start (`offset=-1`).

## When a schedule ends

A schedule that ends, such as `Schedule.recurs(3)`, hands the last failure to
Electric, and Electric stops the shape: `sync` publishes `Stopped`, with the
`status` of a 5xx or 429, or none for a network failure. The shape waits for
`reconnect`. The default policy never ends.

## What the events mean for a UI

`sync` publishes the latest event first, then each one as it happens, so a UI
built after the shape stopped still shows it stopped:

| Event                     | Means                                                   | A UI can show                |
| ------------------------- | ------------------------------------------------------- | ---------------------------- |
| `Sent`                    | a request went out                                      | nothing new                  |
| `Succeeded`               | a request was answered with a 2xx and a whole batch     | up to date                   |
| `Failed` without `status` | the network failed; the request waits on the policy     | offline                      |
| `Failed` with `status`    | a 5xx or 429; the request waits on the policy           | reconnecting                 |
| `Stopped`                 | Electric gave up on the shape; it waits for `reconnect` | stopped, with a retry action |

A request in flight may be a long poll that Electric holds open for up to 20
seconds, so the absence of `Succeeded` for a while is not a failure by itself.
Decide how long a request may stay unanswered before the UI says so, and start
that clock from the last `Failed` or from opening.
