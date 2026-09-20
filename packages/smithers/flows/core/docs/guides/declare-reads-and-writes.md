---
title: "Declare what a step reads and writes"
description: "Attach an effect declaration to a flow or a node, keep each step inside the envelope it inherits, and choose what the planner does when two steps write the same path."
sidebar:
  order: 5
---

An effect declaration says which resources a step touches. The planner checks
that every step stays inside the envelope it inherited, and compares every pair
of writers to find the ones that would race. Both checks are plan-time data
work: nothing opens a file.

## Declare an envelope on the flow

A flow's declaration is the envelope for everything in its body:

```ts
import { Effects, Flow, Node } from "@smthrs/core"
import * as Schema from "effect/Schema"

const Publish = Flow.make({
  name: "publish",
  input: Schema.Void,
  output: Schema.Void,
  effects: Effects.make({
    reads: ["src/**"],
    writes: ["out/**"],
    mode: "expected",
    onConflict: "serialize"
  }),
  body: () =>
    Node.dynamic({ model: "smart", prompt: "Write the report." }).pipe(
      Node.withEffects(Effects.make({
        reads: ["src/index.ts"],
        writes: ["out/report.json"],
        mode: "hermetic",
        onConflict: "serialize"
      }))
    )
})
```

The step claims less than the flow granted, which is allowed. Claiming more is
not. For the coverage grammar behind "less", see
[Effect envelopes](../concepts/effects.md).

## Check the claim yourself

`Effects.narrow` applies the same three rules `Graph.build` applies, so you can
check a declaration in a test without building a graph:

```ts
const envelope = Effects.make({ reads: ["src/**"], writes: ["out/**"], mode: "expected", onConflict: "serialize" })
const step = Effects.make({ reads: [], writes: ["secret.txt"], mode: "hermetic", onConflict: "serialize" })

const result = Effects.narrow(envelope, step)
if (!result.ok) console.error(result.code, result.paths)
```

| Result code               | Cause                                                                 |
| ------------------------- | --------------------------------------------------------------------- |
| `effect_outside_envelope` | A read or write path the envelope does not cover. `paths` names them. |
| `effect_mode_widening`    | A `hermetic` envelope with an `expected` step.                        |
| `effect_tier_widening`    | A step whose tier is less reversible than the envelope's.             |

All three are fatal when `Graph.build` records them, so the graph has no key
material until you fix the declaration.

## Read the diagnostics from a build

```ts
import { Graph } from "@smthrs/core"

const Escaping = Flow.make({
  name: "escaping",
  effects: Effects.make({ reads: [], writes: ["out/**"], mode: "expected", onConflict: "serialize" }),
  body: () =>
    Node.dynamic({ model: "smart" }).pipe(
      Node.withEffects(Effects.make({
        reads: [],
        writes: ["secret.txt"],
        mode: "expected",
        onConflict: "serialize"
      }))
    )
})

console.log(Graph.diagnostics(Graph.build(Escaping)))
```

```text
[
  {
    _tag: '@smthrs/plan/GraphBuildError',
    code: 'effect_outside_envelope',
    node: 'root',
    path: [ 'secret.txt' ]
  }
]
```

`node` names the node whose declaration was refused, so you can find it in
your source by its structural position.

## Two writers of one path

Only `Dynamic` nodes count as writers. A plan built from `Node.succeed` records
no conflicts however its declarations overlap, which is the most common reason
a conflict test appears to do nothing.

```ts
const writes = Effects.make({
  reads: [],
  writes: ["out/report.json"],
  mode: "expected",
  onConflict: "serialize"
})

const racing = Graph.build(Node.all({
  a: Node.dynamic({ model: "smart" }).pipe(Node.withEffects(writes)),
  b: Node.dynamic({ model: "smart" }).pipe(Node.withEffects(writes))
}))
```

With `onConflict: "serialize"` the planner records the conflict and adds an
ordering edge, and the graph still keys:

```ts
console.log(Graph.conflicts(racing))
```

```text
[
  {
    nodes: [ 'root.all.a', 'root.all.b' ],
    paths: [ 'out/report.json' ],
    strategy: 'serialize'
  }
]
```

The edge it added is `{ from: 'root.all.a', to: 'root.all.b', reason: 'conflict' }`,
so a scheduler runs the two writers in a fixed order instead of at the same
time.

Change both declarations to `onConflict: "lane"` and the planner gives each
writer a lane derived from its node id, synthesizes a merge node, and joins
them to it:

```text
[
  {
    nodes: [ 'root.all.a', 'root.all.b' ],
    paths: [ 'out/report.json' ],
    strategy: 'lane',
    mergeNodeId: 'lane.merge.0'
  }
]
```

The graph now has a fourth node, `lane.merge.0 (LaneMerge)`, and three
`lane-merge` edges: one from each writer to the merge, and one from the merge
to the join it feeds.

Change them to `onConflict: "fail"` and the planner records a fatal
`write_conflict` diagnostic naming both nodes, so `Graph.keyMaterial` refuses
the graph. Choose `fail` when two writers of one path is a bug in the
declaration rather than a scheduling problem.

The stricter declaration decides: `fail` beats `lane`, and `lane` beats
`serialize`, so one careful step can refuse to share a path with a careless
one.

## Seal a flow

`Flow.sealed()` returns a copy whose declaration is `hermetic` and `sealed`. A
flow that had no declaration gets an empty one with those two values, which is
the strictest possible claim: this flow touches nothing.

```ts
const Locked = Publish.pipe(Flow.sealed())
```

## Find the overlap between two declarations

`Effects.overlaps` returns the concrete or narrower write paths two
declarations share, sorted and duplicate-free. It is the primitive the conflict
pass uses, and it is useful on its own when you are deciding whether two flows
can run together:

```ts
const left = Effects.make({ reads: [], writes: ["out/**"], mode: "expected", onConflict: "serialize" })
const right = Effects.make({ reads: [], writes: ["out/report.json"], mode: "expected", onConflict: "serialize" })

Effects.overlaps(left, right) // [ 'out/report.json' ]
```

It is stricter than `Effects.covers` about unnormalized paths: two writers
naming the same literal path always overlap, even a path with a `.` or `..`
segment that `covers` refuses to match. An unnormalized path escapes no
envelope, and two writers of it are still writing the same resource.

## Where to go next

- [Effect envelopes](../concepts/effects.md): the model, including the full
  coverage grammar.
- [Build limits](../concepts/limits.md): what bounds the paths and patterns one
  declaration may carry.
