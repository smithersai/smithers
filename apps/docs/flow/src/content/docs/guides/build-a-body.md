---
title: "Compose a body from branches and fan-out"
description: "Sequence steps, fan out and join, bound concurrency, decide between two continuations, and recover from a typed failure, all as static topology."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/flow/docs/guides/build-a-body.md"
---

A body is written in [`@smthrs/plan`](https://plan.smithers.sh/reference/api/)'s `Node` combinators. This guide
builds one release gate out of them: two checks in parallel, a report that joins
them, a decision, and a recovery arm.

Every combinator here is evaluated once, at plan time. Nothing in this file runs
a step.

## Declare the steps

```ts
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Schema from "effect/Schema"

export class GateFailed extends Schema.TaggedError<GateFailed>()(
  "release/GateFailed",
  { reason: Schema.String }
) {}

const Lint = Action.make("release/Lint", {
  payload: { target: Schema.String },
  success: Schema.String,
  error: GateFailed
})

const Types = Action.make("release/Types", {
  payload: { target: Schema.String },
  success: Schema.String,
  error: GateFailed
})

const Report = Action.make("release/Report", {
  payload: { lint: Schema.String, types: Schema.String },
  success: Schema.String
})

const Ship = Action.make("release/Ship", {
  payload: { report: Schema.String },
  success: Schema.String
})

const Explain = Action.make("release/Explain", {
  payload: { reason: Schema.String },
  success: Schema.String
})
```

## Fan out, then join

`Node.all` settles its members concurrently and answers a record keyed by member
name. Reading a field off the result records a reference path, so the join is an
ordinary step that receives real strings:

```ts
const checks = (target: string) =>
  Node.all({
    lint: Lint.call({ target }),
    types: Types.call({ target })
  })

const report = (target: string) =>
  checks(target).pipe(
    Node.bindPlanned((settled) => Report.call({ lint: settled.lint, types: settled.types }))
  )
```

`settled.lint` is a `Planned<string>`, not a string. Pass it into a payload;
never build a message out of it. The fan-in is a step for that reason: an action
that receives two strings, not a function in the body that tries to concatenate
placeholders.

`Node.all` fixes its width at plan time. To bound concurrency, use one `Node.all`
per batch and give the next batch the previous batch's result as payload. The
reference is what sequences them, and an operator reading the plan sees exactly
how many steps can be in flight.

## Decide between two continuations

`Node.branch` stores both arms. The predicate is digested and evaluated at run
time on the real value; the arms are built once, here:

```ts
const gate = (target: string) =>
  report(target).pipe(
    Node.branch({
      if: (text) => text.includes("clean"),
      then: (text) => Ship.call({ report: text }),
      else: (text) => Explain.call({ reason: text })
    })
  )
```

Both arms contribute their requirements to the node, because both are topology
the plan carries. A run takes one of them, but which one is not known until the
predicate sees the real value.

Write the decision as a `branch`, not as an `if` in the body. An `if` on a
planned value cannot read it, and an `if` on the payload is fine but produces a
plan that no longer describes the alternative.

## Recover from a typed failure

`Node.catch` is failure topology. With an `error` schema it handles only the
failures the schema accepts and leaves the rest in the node's error type:

```ts
export const Gate = Flow.make("release/Gate", {
  payload: { target: Schema.String },
  success: Schema.String,
  body: ({ target }) =>
    gate(target).pipe(
      Node.catch({
        error: GateFailed,
        onFailure: (failure) => Explain.call({ reason: failure.reason })
      })
    )
})
```

Without an `error` schema the whole domain error channel is handled and the
resulting node has no declared error type. Interpreter refusals still propagate.
The failure arm is built once at plan time against a planned error placeholder,
so `failure.reason` is a reference, like every other planned field.

## Compute, and order

Two smaller combinators finish the vocabulary:

- `Node.map(node, f)` computes on a step result. The function is digested and
  runs later, on the real value. This is where computation belongs, and only
  computation: a `map` that decides what happens next is a `branch` written
  wrongly.
- `Node.priority(node, n)` orders ready work, higher first. It changes latency
  and nothing else, and it never enters key material, so raising it cannot
  invalidate a recorded result. Children inherit it lexically, and a child that
  states its own keeps it.

```ts
const urgent = Node.priority(Lint.call({ target: "release" }), 9)
```

## When the shape depends on a result

Every combinator above fixes its topology before the run. When the shape itself
depends on something a step produced, that is a new round: settle this one and
carry the data in the next round's payload. See
[Trampoline rounds](/concepts/trampoline-rounds/).

## Related pages

- [Bodies are plans](/concepts/bodies-and-plans/): the rules behind the
  vocabulary, and the refusals a bad body earns.
- [Inspect the plan a body builds](/guides/inspect-the-plan/): read the nodes and
  edges this body produces without running it.
