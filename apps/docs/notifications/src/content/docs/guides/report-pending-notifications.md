---
title: "Report what a run is waiting on"
description: "Read a run's undelivered notifications with NotificationQueue.pending, count steers for a run listing, and choose between the live read and the journal projection."
sidebar:
  order: 4
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/notifications/docs/guides/report-pending-notifications.md"
---

Pending is admitted minus promoted, and the queue owns both halves. A supervisor
that counted admissions alone would report a steer as waiting forever.

## Read the live answer

```ts
import { NotificationQueue } from "@smthrs/notifications"
import * as Effect from "effect/Effect"

export const pendingSteers = (runId: string) =>
  Effect.gen(function*() {
    const queue = yield* NotificationQueue.NotificationQueue
    const pending = yield* queue.pending(runId)
    return pending.filter((notification) => notification.delivery === "steer").length
  })
```

`pending` returns the notifications in admission order, across every lineage of
the run. It reads the same fold `drain` uses, so nothing can disagree with what
the next boundary will see.

The read does not take the queue's operation lock. A count taken while a
boundary drains is a count taken at some instant either side of it, and blocking
a supervisor behind a turn boundary would be the worse answer.

## Treat unavailability as unknown, not as zero

A control plane that lists runs annotates each one with its pending steer count.
When the queue is unavailable, the honest report is that the count is not known:

```ts
import { NotificationQueue } from "@smthrs/notifications"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"

export const steeringFor = (runId: string) =>
  Effect.gen(function*() {
    const queue = yield* NotificationQueue.NotificationQueue
    const pending = yield* queue.pending(runId)
    return Option.some(pending.filter((notification) => notification.delivery === "steer").length)
  }).pipe(
    Effect.catchTag("/notifications/NotificationError", () => Effect.succeed(Option.none<number>()))
  )
```

Catch the queue's own `NotificationError` and leave the field absent. Do not
catch the `Journal.JournalError`: a journal that fails is a failed listing, not
an unknown count, and reporting zero would tell an operator that nobody is
waiting.

## Live read or projection

Both answer the same question from the same records:

|            | `NotificationQueue.pending`                   | `Projection.derive`                                               |
| ---------- | --------------------------------------------- | ----------------------------------------------------------------- |
| Shape      | One `Effect` per call.                        | A `Stream` that replays and then follows.                         |
| Needs      | The queue service.                            | A journal, and nothing else.                                      |
| Capacity   | Whatever the layer was built at.              | Reports `NotificationState.defaultCapacity`, and replays past it. |
| Use it for | An answer now: a listing, an RPC, a decision. | A live view that must stay correct as entries arrive.             |

Use `pending` for a request. Use the projection for a feed: it replays what
every admission record committed, so it stays correct at a raised bound even
though the `capacity` it reports is the default. See
[the journal records](/concepts/journal-records/).

## Look at a pending notification

The values are full notifications, so a caller can report more than a count:

```ts
import type { Notification } from "@smthrs/notifications/Notification"

const describe = (notification: Notification) => ({
  id: notification.id,
  lineage: notification.targetLineageId,
  from: notification.provenance.sourceActor,
  urgent: notification.delivery === "steer",
  coalescing: notification._tag === "system-event" ? notification.coalescingKey : undefined
})
```

A pending alert is a `system-event` whose `coalescingKey` is
`Alerts.coalescingKey(runId, condition)`, which is how a UI groups repeated
reports of one condition into one row.
