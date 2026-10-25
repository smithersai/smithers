---
title: "Retry a run from a step"
description: "Start a new run that replays the steps a settled run finished before one of its steps and runs that step and everything after it again, without changing the original run."
sidebar:
  order: 13
---

`flow.retryFrom(source, { step })` starts a new execution of the flow that
retries the settled execution `source` from its node `step`. The new execution
runs with the payload `source` was admitted with. Every step attempt that
finished before `step` began is served from `source`'s record, so its body does
not run again; `step` and every step after it run. `source` is not changed: this
is a retry, not a history fork.

```ts
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const Load = Action.make("report/Load", { payload: { id: Schema.String }, success: Schema.String })
const Summarize = Action.make("report/Summarize", { payload: { text: Schema.String }, success: Schema.String })

const Report = Flow.make("report/Report", {
  payload: { id: Schema.String },
  success: Schema.String,
  body: Node.capture(
    {},
    ({ id }) => Load.call({ id }).pipe(Node.bindPlanned(Node.capture({}, (text) => Summarize.call({ text }))))
  )
})

// `summarize` is the node id of the Summarize step, as the run's node records
// name it (`NodeSettled.nodeId`, and `RunInspection` steps' `nodeId`).
const again = (source: string, summarize: string) =>
  Effect.gen(function*() {
    const retried = yield* Report.retryFrom(source, { step: summarize })
    return yield* Report.poll(retried)
  })
```

The call returns the new execution's id once the execution is admitted, without
waiting for it, as `start` does. Pass `executionId` to name it; a repeated call
with the same id, source and step joins the execution the first call admitted,
and the same id for another source or step fails with
`ExecutionIdentityConflict`. The new execution is a root run of its own, never a
child of the caller, so it outlives an action that starts it.

## What "before the step" means

Before is a position in `source`'s own journal, never a clock. The cutoff is the
first attempt record of the step's own work: its earliest
`flows.engine.attempt-started` or `flows.engine.attempt-finished` under one of
the step key digests its settlement names, or, for a `.child()` boundary, the
record of its child's spawn. Every attempt whose `attempt-finished` precedes the
cutoff is replayed, its failed attempts included, so a step that was mid-retry
continues its attempt count where `source` was.

- **Sequential steps.** Every step before the selected one replays.
- **Concurrent branches.** A step on another branch that finished before the
  selected step began replays. One that was still running when it began runs
  again, with its full history after the cutoff discarded.
- **A failed run.** Retrying from the step that failed replays the steps before
  it and runs the failed step again with a fresh retry budget.
- **A retry of a retry.** A replayed step's `attempt-finished` is re-emitted
  into the replaying run's journal, so a retry from a step another retry
  replayed works the same way.

## Child flows

A `.child()` boundary derives its child's execution id from the parent's id, so
the new execution's boundary names a new child. A boundary that settled before
the selected step carries the child `source` opened there: the new child is
seeded with all of that child's finished attempts and its own settled
boundaries, so it replays whole and no step of it runs again. The child is
carried only while the boundary's input is unchanged, which it is by
construction, since everything it was computed from replayed; a boundary whose
input differs runs its child afresh.

A boundary that is the selected step, or comes after it, runs its child again.

## Refusals

A retry that cannot start is refused with `FlowRuntime.RetryFromRefused` before
anything is written, and admits no execution:

| `code`           | When                                                                                               |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| `unsupported`    | The runtime keeps no history (`FlowRuntime.retryFrom` is absent), or the flow is placed elsewhere. |
| `not_found`      | No execution is recorded under `source`.                                                           |
| `other_flow`     | `source` is an execution of another flow.                                                          |
| `not_settled`    | `source` has not completed, failed or been cancelled.                                              |
| `step_not_found` | `source` recorded no node with this id.                                                            |
| `step_not_run`   | The node was skipped, interrupted before it settled, or dispatched nothing of its own.             |

## A changed declaration

Step keys are derived from the declaration, so a flow whose plan changed since
`source` ran would execute the steps it promised to replay. The new execution's
plan is compared, before any step runs, with the plan `source` recorded, by the
identity a resume compares. A different plan fails the new execution with the
interpreter refusal `plan_changed`; nothing replays and nothing runs. Retry the
whole run instead. A flow registered with process-local callback identity
records a different plan in every process, so it can be retried from a step
only in the process that ran it.

## Which runtimes

The durable engine (`@smthrs/engine-store`) implements it on every store it
runs on: SQLite in the browser (`@smthrs/platform-browser`, on OPFS), SQLite or
PostgreSQL on Node, and PostgreSQL behind the Cloudflare host. The memory engine
keeps no history to replay and refuses `unsupported`.

`TimeTravel.fork` from `@smthrs/time-travel` also branches a run at a frame, but
it is not this operation: it provisions a Jujutsu workspace for the child, so it
needs jj on the host and cannot run in a browser; it needs the time-travel store;
and its child keeps the parent as its `parent_run_id` and copies the parent's
journal prefix, where a retry is a root run of its own whose journal starts
fresh.

## Related pages

- [Suspension and replay](../concepts/suspension-and-replay.md): how a recorded
  step is served instead of executed.
- [Execution identity](../concepts/execution-identity.md): what a step key is
  derived from, and why a changed declaration re-keys a step.
- [Run a flow as a child execution](./run-a-child-flow.md): how a boundary's
  child id is derived.
