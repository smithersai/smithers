---
title: "Hand work to a durable worker"
description: "Declare a durable queue, suspend a flow until a worker records its result, and run the worker as a layer with bounded concurrency."
sidebar:
  order: 10
---

A `DurableQueue` moves work out of the flow that asked for it. The flow offers a
payload, parks, and resumes when a worker persists a result. Requests and recorded
results survive the process that made them.

## Declare the queue

```ts
import { DurableQueue } from "@smthrs/flow"
import * as Schema from "effect/Schema"

export const Renders = DurableQueue.make({
  name: "Renders",
  payload: Schema.Struct({ page: Schema.String }),
  success: Schema.String,
  idempotencyKey: ({ page }) => page
})
```

`idempotencyKey` is required. The payload key scopes an occurrence counter;
the execution ID and occurrence ordinal also contribute to the queue item ID.
Distinct offers of the same page create distinct items, including within one
execution. Replaying the same occurrence derives the same ID for queue deduplication.
Business-level deduplication across distinct offers or runs is the caller's job.
`success` defaults to `Schema.Void` and `error` to `Schema.Never`.

## Offer work from a flow

```ts
const rendered = DurableQueue.process(Renders, { page: "home" })
```

`process` offers the payload under the name `DurableQueue/<name>`, attaches a
completion token, and suspends the execution until a worker records the handler's
exit against it. The success and error channels are the queue's declared schemas,
so the caller sees the worker's own outcome. While suspended, the execution's
waiting annotation has reason `event` and the item's completion token.

Invalid payloads and offer encoding failures die with `SchemaError` without
retrying. The final offer failure of an exhausted retry schedule also becomes a
defect. The typed error channel is reserved for the worker's declared error.

`retrySchedule` bounds how a failing offer is retried. The default retries with
exponential delays capped at one minute and never gives up, so a caller that
wants a bound supplies its own:

```ts
import * as Schedule from "effect/Schedule"

const bounded = DurableQueue.process(Renders, { page: "home" }, {
  retrySchedule: Schedule.recurs(5)
})
```

## Run the worker

`DurableQueue.worker` is the layer form: it forks the worker into the layer's
scope, so it starts with the composition and stops with it.

```ts
import * as Effect from "effect/Effect"

export const RendersWorker = DurableQueue.worker(
  Renders,
  ({ page }) => Effect.succeed(`<html>${page}</html>`),
  { concurrency: 4 }
)
```

`concurrency` defaults to `1` and must be a positive safe integer;
`DurableQueue.makeWorker` and `DurableQueue.worker` throw a `RangeError`
otherwise. `makeWorker` is the underlying effect, for a host that wants to fork
it itself.

The handler's exit is what the waiting flow receives. A handler that fails with
the queue's declared error type resumes the caller with that typed failure; a
handler that dies resumes it with a defect. An interrupt-only handler exit records
nothing and requeues the item without consuming an attempt. Mixed failures are
recorded with interrupt reasons removed.

Each item runs as a durable execution named by the deferred it completes. Its
first step runs the handler and records the handler's exit; its second records
that exit against the caller's deferred. A completion the store refuses is
retried by the engine on its own, from half a second up to a minute between
tries and without a limit, and never runs the handler again, so the caller always
receives the handler's exit once the store records it. Until the handler's exit
is recorded, a crash runs the handler again on the next delivery: make its side
effects idempotent using a business key in the payload.

The persisted queue never drops an item. A delivery whose execution could not
start, because the engine was unavailable, is redelivered on the queue's own
schedule, and every delivery attaches to the same execution.

A worker completes only the wait its own `process` call created: an item stored
under ID `key` must carry a token for `DurableQueue/<name>/<key>`. An item whose
token is malformed or names any other wait point is logged at error level and
acknowledged without running the handler. The worker links its span to the
offering span only when the stored trace and span ids are 32 and 16 lowercase hex
characters.

A completion the store refuses is logged at warning level with the queue name
each time the step retries it.

## When to reach for it

A durable queue is the right shape when the work has a different lifetime or a
different scaling story from the flow that asked for it: a render farm, a batch
of uploads, anything where the caller should park rather than hold a slot. When
the work belongs to the same run, an action is simpler and keeps the step in the
plan. When it is its own unit of work with its own journal,
[a child execution](./run-a-child-flow.md) is the closer fit.

## Related pages

- [Wait for an external signal](./wait-for-an-external-signal.md): the deferred
  and token machinery the queue's reply channel is built on.
- [Suspension and replay](../concepts/suspension-and-replay.md): what the caller
  is doing while the worker works.

A store take failure logs a warning and terminates the worker as a defect; the host owns recovery.
Successful takes continue consuming items. An item whose execution fails or is interrupted, for example while
the engine's store is unavailable, logs a warning; the queue delivers it again and the worker takes the next
item. Completion retries remain durable steps in the item's flow.
Malformed-token diagnostics bound and escape token excerpts and schema errors before queue logging.
