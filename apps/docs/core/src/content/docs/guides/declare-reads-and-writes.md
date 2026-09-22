---
title: "Declare what a step reads and writes"
description: "Attach an effect declaration to a flow or a node, keep each step inside the envelope it inherits, and choose what the planner does when two steps write the same path."
sidebar:
  order: 5
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/core/docs/guides/declare-reads-and-writes.md"
---

An effect declaration says which resources a step touches. The planner checks
that every step stays inside the envelope it inherited, and compares every pair
of writers to find the ones that would race. Both checks are plan-time data
work: nothing opens a file.

## Declare an envelope on the signature

A signature's declaration is the envelope for everything beneath it: its body,
and every call that body makes.

```ts
import { Effects, Flow } from "@smthrs/core"
import * as Schema from "effect/Schema"

const Write = Flow.make({
  name: "write",
  input: Schema.Struct({ path: Schema.String }),
  output: Schema.Void,
  effects: Effects.make({
    reads: ["src/index.ts"],
    writes: ["out/report.json"],
    mode: "hermetic",
    onConflict: "serialize"
  })
})

const Publish = Flow.make({
  name: "publish",
  effects: Effects.make({
    reads: ["src/**"],
    writes: ["out/**"],
    mode: "expected",
    onConflict: "serialize"
  }),
  body: () => Write.call({ path: "out/report.json" })
})
```

The callee claims less than the caller granted, which is allowed. Claiming more
is not. For the coverage grammar behind "less", see
[Effect envelopes](/concepts/effects/).

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

All three are fatal when `Graph.build` records them, so the graph compiles no
drafts until you fix the declaration.

## Read the diagnostics from a build

```ts
import { Graph } from "@smthrs/core"

const Escaping = Flow.make({
  name: "escaping",
  effects: Effects.make({ reads: [], writes: ["out/**"], mode: "expected", onConflict: "serialize" }),
  body: () => Write.call({ path: "secret.txt" })
})

const graph = Graph.build(Escaping.flow, { input: undefined })

console.dir(Graph.diagnostics(graph).map(({ code, node, path }) => ({ code, node, path })))
```

```text
[
  { code: 'effect_outside_envelope', node: 'root.flow', path: [ 'secret.txt' ] },
  { code: 'effect_outside_envelope', node: 'root.flow.flow', path: [ 'secret.txt' ] }
]
```

Here `Write` declares `secret.txt` and `Escaping` granted only `out/**`, so the
call and the action dispatch beneath it are both refused. `node` names the node
whose declaration was refused, so you can find it in your source by its
structural position.

The payload is `{ input: undefined }` rather than `undefined`: `Escaping`
declared no `input`, so its input schema is `Schema.Void`, and a non-struct
input travels as the one field `input`.

## Two writers of one path

[`@smthrs/flow`](https://flow.smithers.sh/reference/api/) owns the comparison: its graph builder records a
conflict when two writers' effective write declarations overlap, orders them
under `serialize`, lanes them under `lane`, and refuses the plan under `fail`.
The stricter declaration decides: `fail` beats `lane`, and `lane` beats
`serialize`, so one careful step can refuse to share a path with a careless
one. Its reference documents each strategy and the diagnostics it records.

## Seal a signature

`Flow.sealed()` returns a copy whose declaration is `hermetic` and `sealed`. A
signature that had no declaration gets an empty one with those two values, which
is the strictest possible claim: this step touches nothing. A signature that
declares no envelope at all dispatches as `irreversible` instead, so an
undeclared tier never content-shares another run's result.

```ts
const Locked = Publish.pipe(Flow.sealed())
```

## Find the overlap between two declarations

`Effects.overlaps` returns the concrete or narrower write paths two
declarations share, sorted and duplicate-free. It is the primitive the conflict
pass uses, and it is useful on its own when you are deciding whether two
signatures can run together:

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

- [Effect envelopes](/concepts/effects/): the model, including the full
  coverage grammar.
- [Declare a flow](/guides/declare-a-flow/): where a signature states its envelope,
  its capabilities, and its tier.
