---
title: "Compose nodes into a plan"
description: "Build the AST a flow body returns: constants and failures, parallel joins, deferred maps, sequenced continuations, recovery arms, and unelaborated model steps."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/core/docs/guides/compose-nodes.md"
---

A node is an inert, pipeable value that records an AST. Every constructor and
combinator on this page builds data. None of them run anything.

## Constants and failures

```ts
import { Node } from "@smthrs/core"

const value = Node.succeed({ approved: true })
```

`Node.fail` is its counterpart, and its main use is inside a recovery arm, so a
plan shows that the arm cleans up and hands the failure back rather than
absorbing it:

```ts
import * as Schema from "effect/Schema"

class Rejected extends Schema.TaggedError<Rejected>()("Rejected", {
  reason: Schema.String
}) {}

const rethrown = Node.fail(new Rejected({ reason: "no reviewer" }))
```

The error enters key material, so two failures carrying different data are two
declarations. Error reflection includes `_tag`, own data fields, and nested
`cause` values; it excludes `stack`. Accessors are described without being
called, and unsupported field values are refused. Both constructors retain the value you pass by reference and read
it when `Graph.build` runs.

## Independent work

`Node.all` combines a record of independent nodes into one node whose value is
a record of their values:

```ts
const reviews = Node.all({
  api: Review({ path: "src/api.ts" }),
  cli: Review({ path: "src/cli.ts" })
})
```

Nothing in the record depends on anything else in it, so a scheduler may run
the members at the same time. A member that is not a node raises
`NodeBuildError` with code `invalid_all_member`, naming the member:

```text
flows/core/NodeBuildError: Node.all expected a Node at member "bad"
```

## Deferred transformation

`Node.map` records a function to apply to the eventual value. `Graph.build`
does not call it: only the function's identity enters the plan.

```ts
const count = Node.map(reviews, (result) => Object.keys(result).length)
```

Because the mapper is never called at plan time, its identity is all the plan
knows about it. An unannotated mapper gets process-local identity. See
[Keep a step key stable across processes](/guides/keep-a-step-key-stable/).

## Sequencing

`Node.andThen` sequences a node-producing builder after a node. `Graph.build`
evaluates the builder exactly once, against a symbolic placeholder, so the
downstream topology is visible before anything runs:

```ts
const plan = reviews.pipe(
  Node.andThen((result) => Report({ notes: result.api.notes }))
)
```

Read members from the placeholder to say what a later step consumes. Do not
compute on it: interpolation coerces it to the literal text
`[planned:api.notes]`, a conditional on it always takes the truthy branch, and
neither produces a diagnostic. Its `then` member is reserved and reads as
`undefined`, so nothing mistakes it for a promise. The whole rule is in
[Plan time](/concepts/plan-time/).

When the next step does not need the previous value, pass a node directly
instead of a builder:

```ts
const thenPublish = reviews.pipe(Node.andThen(Publish({ tag: "nightly" })))
```

## Recovery

`Node.catch` plans a recovery arm. Like `andThen`, the arm is built once at
plan time, against a symbolic error naming the protected node, so the recovery
topology is part of the plan:

```ts
const guarded = Review({ path: "src/api.ts" }).pipe(
  Node.catch({
    error: Rejected,
    onFailure: (error) => Node.succeed({ approved: false, notes: error.reason })
  })
)
```

The `error` schema selects which typed failures the arm handles, and the
remainder stays in the node's error type. Omit it and the whole typed error
channel is handled. The symbolic error carries the same placeholder rules as
`andThen`, `then` included.

An arm that returns something other than a node raises `NodeBuildError` with
code `invalid_continuation` during `Graph.build`.

## Model steps

`Node.dynamic` records an unelaborated model step. The planner does not
elaborate it: it stays a `Dynamic` node in the graph, which is the node kind
that participates in write-conflict analysis.

```ts
const draft = Node.dynamic({
  model: "smart",
  prompt: "Draft a release note from the changelog.",
  output: Schema.String
})
```

Passing an `output` schema types the node's success channel as that schema's
type. `flows` names the collaborators the step may call, as flow values or as
unresolved registry names, and `effects` declares the step's own envelope.

## Guarding a node value

`Node.isNode` narrows an unknown value:

```ts
const nodes = (values: ReadonlyArray<unknown>): ReadonlyArray<Node.Any> => values.filter(Node.isNode)
```

`Node.Success` and `Node.Error` extract one node's channels, and `Node.Ast` is
the recorded AST type.

## Where to go next

- [Inspect a built graph](/guides/inspect-a-graph/): read back what you composed.
- [Test a declaration without a host](/guides/test-a-declaration/): run the
  deferred callbacks and assert on their values.
