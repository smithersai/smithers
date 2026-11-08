---
title: "Diff two plans"
description: "Compare a re-plan against the plan before it: what the verdict is, how a re-key is attributed to the field that caused it, how a step whose positional id moved is paired by its key, and why the report is in no digest."
sidebar:
  order: 5
---

"What is different about this run" is a set comparison, not archaeology.
`PlanDiff.diff` is that comparison as a value.

## Before you start

The examples run with `node <file>.ts` on Node.js 22.19.0 or later and need no
engine, database, or jj. Compiling a plan needs Effect's `Crypto` service, which
`@effect/platform-node` supplies. In a project that installed `@smthrs/flows`,
add this package and `@smthrs/flow` at the version of `@smthrs/flows` you have,
plus the platform package:

```bash
npm install @smthrs/plan@1.0.0-rc.16 @smthrs/flow@1.0.0-rc.16 @effect/platform-node
```

The outputs below are real output from the release that install line names.

## Compare a re-plan

Create `diff.ts`. It compiles the two drafts from
[Compile drafts into a plan](./compile-a-plan.md), edits one field of one
draft's body, compiles again, and compares:

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as KeyMaterial from "@smthrs/plan/KeyMaterial"
import * as Plan from "@smthrs/plan/Plan"
import * as PlanDiff from "@smthrs/plan/PlanDiff"
import * as Effect from "effect/Effect"

const readPr: Plan.NodeDraft = {
  id: "read-pr",
  material: {
    version: KeyMaterial.version,
    kind: "sealed",
    body: { action: "read-pr", pr: 4821 },
    inputs: [],
    layers: [],
    capabilities: ["net:get"]
  },
  effects: { reads: [], writes: ["pr.json"], boundaryMode: "hard" }
}

const runTests: Plan.NodeDraft = {
  id: "run-tests",
  material: {
    version: KeyMaterial.version,
    kind: "sealed",
    body: { action: "run-tests" },
    inputs: [{ _tag: "Ref", from: "read-pr", path: [] }],
    layers: [],
    capabilities: []
  },
  effects: { reads: ["pr.json"], writes: ["report.json"], boundaryMode: "hard" }
}

const compile = (nodes: ReadonlyArray<Plan.NodeDraft>) =>
  Plan.compile({ planId: "review-4821", flow: "example/Review", nodes })

export const compare = Effect.gen(function*() {
  const before = yield* compile([readPr, runTests])
  const after = yield* compile([
    readPr,
    { ...runTests, material: { ...runTests.material, body: { action: "run-tests", jobs: 4 } } }
  ])
  const changes: PlanDiff.PlanDiff = PlanDiff.diff(before, after)
  return changes.rekeyed.map((entry) => `${entry.id}: ${entry.changed.join(", ")}`)
}).pipe(Effect.provide(NodeCrypto.layer))

console.log(await Effect.runPromise(compare))
```

```bash
node diff.ts
```

```text
[ 'run-tests: body' ]
```

`compare` answers `["run-tests: body"]`. The edit moved one field of one node's
body, so that node re-keyed and the report says which field did it.

## The verdict is the key

Two nodes with the same key are the same step, under the same id or a moved
one. Nothing else needs saying, and `diff` says nothing else. Four lists come
back:

| Field       | Contents                                                              |
| ----------- | --------------------------------------------------------------------- |
| `added`     | Node ids in `next` that pair with no node in `previous`.              |
| `removed`   | Node ids in `previous` that pair with no node in `next`.              |
| `rekeyed`   | Nodes paired by id whose key moved, with `from`, `to`, and `changed`. |
| `unchanged` | Node ids in `next` paired with a node of the same key.                |

## The attribution is for a human

`Rekeyed.changed` is a list of field labels: `["body", "input[1]"]`. It is
derived by comparing declarations field by field, and it is deliberately part of
no digest. Changing how the report reads can never change what a plan hashes to.

The labels mirror the hashed declaration: the effect tier `kind`, the fields
the hashed material body folds, and the input positions:

```text
kind  body  layers  capabilities  effects  version  nondeterministic  placement  input[n]
```

An `input[n]` entry appears when that input's declaration changed, and also when
the declaration is unchanged but the node it references itself re-keyed. A node
re-keyed purely by an upstream edit is therefore attributed to the input
position that references it, even behind an unprojected `Pending`, rather than
reported as nothing changed.

`changed` is empty only when none of the compared fields moved, which means the
key moved for a reason the comparison does not model. Treat an empty `changed`
on a re-keyed node as a bug report, not as noise.

## Node ids are positional

A node id is the node's structural address in the body, such as
`root.flow.andThen`, not the name of its step. Adding a step to a flow can move
the steps around it to new addresses while their keys stay the same. `diff`
therefore pairs nodes in three passes, each over the nodes no earlier pass
paired:

1. The same id with the same key: unchanged.
2. The same key under a different id: the same step at a new address, reported
   as unchanged under its id in `next`.
3. The same id with a different key: re-keyed.

Whatever is left in `next` is `added`, and whatever is left in `previous` is
`removed`. `added`, `rekeyed`, and `unchanged` name nodes by their id in
`next`; `removed` names nodes by their id in `previous`.

Create `inserted.ts`. It compiles two steps, then the same two steps with a
third inserted before them, so every id shifts by one:

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as KeyMaterial from "@smthrs/plan/KeyMaterial"
import * as Plan from "@smthrs/plan/Plan"
import * as PlanDiff from "@smthrs/plan/PlanDiff"
import * as Effect from "effect/Effect"

/** A step whose id is its position, as a flow's structural ids are. */
const step = (position: number, action: string): Plan.NodeDraft => ({
  id: `step-${position}`,
  material: {
    version: KeyMaterial.version,
    kind: "sealed",
    body: { action },
    inputs: [],
    layers: [],
    capabilities: []
  },
  effects: { reads: [], writes: [], boundaryMode: "hard" }
})

const compile = (actions: ReadonlyArray<string>) =>
  Plan.compile({
    planId: "checks-1",
    flow: "example/Checks",
    nodes: actions.map((action, index) => step(index, action))
  })

const program = Effect.gen(function*() {
  const previous = yield* compile(["lint", "test"])
  const next = yield* compile(["format", "lint", "test"])
  console.log(PlanDiff.diff(previous, next))
}).pipe(Effect.provide(NodeCrypto.layer))

await Effect.runPromise(program)
```

```bash
node inserted.ts
```

```text
{
  added: [ 'step-0' ],
  removed: [],
  rekeyed: [],
  unchanged: [ 'step-1', 'step-2' ]
}
```

Only the inserted `format` step is new. `lint` and `test` moved from `step-0`
and `step-1` to `step-1` and `step-2` with the keys they had, so they come back
as `unchanged`.

## Comparison uses the key's own JSON semantics

Each compared field is projected through the same JSON mirror the keys are
derived from, so two `Date` bodies a generation apart attribute to `body` rather
than to nothing. The projection runs no accessor.

A field the projection refuses compares by an identity token scoped to that node
and field. The same value stays equal to itself, two distinct refused values
never compare equal, and `diff` stays a total function even for a value
canonical serialization would reject. `diff` never fails and never needs a
service.

## Reporting a re-plan

The pairing this is built for is a re-plan of the same flow: compile the flow
again against the current source and compare the result with the plan an
operator last saw. `added` and `removed` are the shape change, `rekeyed` is the
work that will not come from cache, and `unchanged` is everything a cache hit
will skip. That reading holds when a step is added or removed and ids move,
because `diff` pairs a moved step by its key, as
[Node ids are positional](#node-ids-are-positional) shows.

On a body built with `Flow.make`, `added` and `rekeyed` also list structural
nodes: each `AndThen` that sequences steps, and the `FlowCall` at `root`. Their
keys fold their children's keys, so they move whenever a child does, and they
run no work. Count steps as the entries whose material body names an `action`.

Create `replan.ts`. It appends a `Summarize` step to a two-step review and
compares the two plans:

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Action, Flow, Graph } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Plan from "@smthrs/plan/Plan"
import * as PlanDiff from "@smthrs/plan/PlanDiff"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const ReadPr = Action.make("review/ReadPr", { payload: { pr: Schema.Number }, success: Schema.String })
const RunTests = Action.make("review/RunTests", { payload: { diff: Schema.String }, success: Schema.String })
const Summarize = Action.make("review/Summarize", { payload: { report: Schema.String }, success: Schema.String })

const review = (summarize: boolean) =>
  Flow.make("review/Review", {
    payload: { pr: Schema.Number },
    success: Schema.String,
    body: (payload) => {
      const tested = ReadPr.call(payload).pipe(Node.bindPlanned((diff) => RunTests.call({ diff })))
      return summarize ? tested.pipe(Node.bindPlanned((report) => Summarize.call({ report }))) : tested
    }
  })

const compile = (summarize: boolean) =>
  Plan.compile({
    planId: "review-4821",
    flow: "review/Review",
    nodes: Graph.drafts(Graph.build(review(summarize), { pr: 4821 }))
  })

/** A step is a node whose material body names an action; the rest only compose steps. */
const isStep = (node: Plan.PlanNode) => {
  const body = node.material.body
  return typeof body === "object" && body !== null && "action" in body
}

const program = Effect.gen(function*() {
  const previous = yield* compile(false)
  const next = yield* compile(true)
  const changes = PlanDiff.diff(previous, next)
  const steps = new Set(next.nodes.filter(isStep).map((node) => node.id))
  console.log({
    added: changes.added,
    rekeyed: changes.rekeyed.map((entry) => entry.id),
    addedSteps: changes.added.filter((id) => steps.has(id)),
    rekeyedSteps: changes.rekeyed.filter((entry) => steps.has(entry.id)).map((entry) => entry.id)
  })
}).pipe(Effect.provide(NodeCrypto.layer))

await Effect.runPromise(program)
```

```bash
node replan.ts
```

```text
{
  added: [ 'root.flow.andThen', 'root.flow.then' ],
  rekeyed: [ 'root.flow', 'root' ],
  addedSteps: [ 'root.flow.then' ],
  rekeyedSteps: []
}
```

One step was added: `Summarize`, at `root.flow.then`. `ReadPr` and `RunTests`
moved under the new `AndThen` with the keys they had, so they are `unchanged`.
The other three entries are structure: two `AndThen` nodes and the `FlowCall`.

The command line prints the same comparison through
[`smthrs flow plan`](/cli/flow), and the plan card it renders is what
[`smthrs approvals approve`](/cli/approvals) binds a decision to.

## Next

- [Inspect the plan a body builds](../../../flow/docs/guides/inspect-the-plan.md):
  build a flow's graph and read its nodes before anything runs.
- [Step keys](../concepts/step-keys.md): why an upstream edit re-keys a
  downstream node whose own declaration did not change.
- [The plan value](../concepts/plan-value.md): the digests a diff sits beside.
