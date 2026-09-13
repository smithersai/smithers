---
title: "Handle a full queue"
description: "Read AdmissionReceipt.decision, tell rejected-full apart from a failure, and retry the same notification once a boundary has drained."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/notifications/docs/guides/handle-a-full-queue.md"
---

`admit` does not fail when the queue is full. It succeeds, and says so in the
receipt. A caller that treats the receipt as an acknowledgement loses the
notification in silence, which is the one failure this queue must never hide.

## Branch on the decision

```ts
import { NotificationQueue } from "@smthrs/notifications"
import type { Notification } from "@smthrs/notifications/Notification"
import * as Effect from "effect/Effect"

export const tell = (runId: string, notification: Notification) =>
  Effect.gen(function*() {
    const queue = yield* NotificationQueue.NotificationQueue
    const receipt = yield* queue.admit(runId, notification)
    switch (receipt.decision) {
      case "admitted":
      case "coalesced":
        // The queue retained it. `receipt.seq` is the sequence it committed at.
        return { retained: true as const, seq: receipt.seq }
      case "rejected-full":
        // Nothing was retained and nothing was journaled. The id is still free.
        return { retained: false as const, seq: undefined }
    }
  })
```

| Decision        | Retained | Journaled | `seq`       |
| --------------- | -------- | --------- | ----------- |
| `admitted`      | Yes      | Yes       | present     |
| `coalesced`     | Yes      | Yes       | present     |
| `rejected-full` | No       | No        | `undefined` |

`receipt.seq` is absent exactly when nothing was written, so an absent sequence
and a `rejected-full` decision are the same fact reported twice.

## Retry the same notification, unchanged

Because nothing was journaled, the id stays admissible. Once a boundary drains
and the run drops below its capacity, the identical call succeeds:

```ts
import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"

export const tellEventually = (runId: string, notification: Notification) =>
  Effect.gen(function*() {
    const result = yield* tell(runId, notification)
    if (result.retained) return result
    return yield* Effect.fail("queue-full" as const)
  }).pipe(Effect.retry({ schedule: Schedule.spaced("1 second"), times: 5 }))
```

Retry with the same `id` and the same content. Changing either turns the retry
into a different notification, and changing only the content is refused as
`notification_id_reused`.

## Choose the bound deliberately

`NotificationState.defaultCapacity` is 128 pending notifications per run.
`NotificationQueue.layerWith({ capacity })` sets a different bound for one
composition:

```ts
import { NotificationQueue } from "@smthrs/notifications"

export const roomyQueue = NotificationQueue.layerWith({ capacity: 512 })
```

Raising it makes a run absorb more before it refuses, and makes an undrained run
hold more. Two things follow from a non-default bound:

- `Projection.derive` replays every admission the run committed, whatever bound
  it was built at, but the state it projects still carries the default
  `capacity`. Read `items`, not `capacity`. See
  [the journal records](/concepts/journal-records/).
- A capacity that is not a finite number becomes zero, which refuses everything.
  That is deliberate: a misconfigured bound fails loudly rather than retaining an
  unbounded backlog.

## What a refusal is not

A `rejected-full` decision is not an error, and no `NotificationError` is
raised. The typed failures mean something else entirely:
`notification_unavailable` is the seam reporting that it serves nothing,
`notification_id_reused` is a producer bug, and `notification_invalid` is a value
that is not a notification. Storage problems arrive as a `Journal.JournalError`.
See [Troubleshooting](/troubleshooting/).

## When the alerter is refused

`Alerts` implements exactly this contract. A tick whose admission is refused
returns the alert in `Alerts.Tick.refused`, journals the refusal, and does not
call the sink, because paging about an alert the run will never read would send
an operator looking in the wrong place. The next tick tries again.
