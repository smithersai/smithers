---
title: "Assert what a flow planned"
description: "Build a plan from a flow declaration without running it, then assert on its nodes, edges, keys, placement, effects, and canonical rendering, under layers that reject any capability the planner touches."
sidebar:
  order: 2
---

Planning is pure: it never touches the host, the model, the clock, or
randomness. That makes a plan the cheapest thing in a flow to assert on, and
the assertions here are ordinary `Effect`s that fail with a typed
`PlanAssertionError`.

## Build the plan

`Plan.planOf` decodes the flow's input through its declared schema, then builds
and projects the plan. Un-defaulted input cannot reach a plan: the schema's
defaults are applied by construction before planning sees the value.

```ts
import { Plan, PlanAssertions, TestLayers } from "@smthrs/testing"
import { describe, expect, it } from "@smthrs/testing/Vitest"
import * as Effect from "effect/Effect"

describe("review plan", () => {
  it.effect("plans one sealed dynamic node", () =>
    Effect.gen(function*() {
      const plan = yield* PlanAssertions.expectPure(Plan.planOf(review, { pr: 4821 }))
      yield* PlanAssertions.expectPlan(plan).contains("root")
      yield* PlanAssertions.expectPlan(plan).node("root").tier("sealed")
      expect(Plan.node(plan, "root")?.key).toMatch(/^key1_[0-9a-f]{64}$/)
    }).pipe(Effect.provide(TestLayers.poisoned)))
})
```

`expectPure` runs the computation and converts any failure or defect into a
`purity_violation`. `TestLayers.poisoned` is what makes that meaningful: under
it, a planner that reached `FileSystem`, `Path`, the shell, `Jj`, the HTTP
transport, the model, the clock, or `Random` raises instead of answering. The
original typed error travels in the assertion error's `actual` field, so a test
can separate "the plan called `FileSystem.readFile`" from "the plan called
`Jj.status`" from "the input schema failed to decode".

Building on its own is available too: `Plan.fromGraph` projects a
[`@smthrs/flow`](/api/flow) graph, and `Plan.keys` derives just the step keys.

## Assert on the graph

`PlanAssertions.expectPlan(plan)` returns a fluent set of Effect-valued
assertions:

```ts
const planned = PlanAssertions.expectPlan(plan)

yield * planned.nodeCount(4)
yield * planned.contains("lint")
yield * planned.edges([["read-pr", "lint"], ["read-pr", "test"]])
yield * planned.keys({ "read-pr": "key1_0f3c..." })
yield * planned.placement("lint", { tag: "sandbox", options: { profile: "lane-3" } })
yield * planned.declaresEffects("test", ["read:workspace/input", "write:workspace/output"])
yield * planned.envelope({ deny: ["proc:spawn"], may: ["fs:read ./"] })
```

The effect assertion assumes the `test` node declares these paths:

```ts
import * as Flow from "@smthrs/flow/Flow"

const Test = Action.make("review/test", { payload, success }).annotate(Flow.EffectsDeclaration, {
  reads: ["workspace/input"],
  writes: ["workspace/output"],
  boundaryMode: "expected"
})
```

`Plan.planOf` and `Plan.fromGraph` project declared paths as `read:<path>`,
`write:<path>`, and `remove:<path>`, not kernel capability names such as
`fs:read` or `proc:spawn`. A node that declares no effects has an empty effect
list.

Three of those have behavior worth knowing:

- `edges` asserts the pairs are **present**. Pass `{ exact: true }` to also
  refuse any edge outside the expected set. It accepts either tuple form
  (`["from", "to"]`) or object form (`{ from, to }`).
- `placement` compares only the tag when you pass a bare string or omit
  `options`, and compares the whole payload when you supply one.
- `declaresEffects` sorts both sides, so declaration order in the flow never
  breaks a test.

`planned.node(id)` narrows the same vocabulary to one node, adding `mode` and
`tier`. `mode` is the boundary mode of the node's own effect declaration and is
absent when it declared none. `tier` is the tier the node is keyed under, and
every node has one.

There is no per-node conflict strategy or envelope to assert. Write overlap is
`Plan.compile`'s verdict, and an effect envelope is a ceiling `Graph.build`
checks a declaration against: a declaration outside it fails the build with
`effect_outside_envelope`, which is what a test asserts instead.

## Snapshot the whole plan

`Plan.render` produces a stable, line-oriented canonical string: nodes and
edges in deterministic order, object payloads with sorted keys, byte-identical
output for semantically identical plans.

```ts
yield * PlanAssertions.expectPlan(plan).matchesSnapshot(expectedRendering)
```

A mismatch reports a line diff rather than two blobs.

## Pin the key digests

Step keys are cache identity. A key that changes silently is a cache-identity
break, so goldens get their own assertion and their own code:

```ts
import { Plan, PlanAssertions } from "@smthrs/testing"

const golden = { "read-pr": "key1_0f3c...", lint: "key1_9ab2..." }

const pinned = PlanAssertions.expectKeyGoldens(Plan.keys(graph), golden)
```

A miss fails with `key_golden_mismatch` and a message that names the drift for
what it is.

## Assert coverage across a suite of plans

`expectPlans` answers one question across many built plans: did the suite's
inputs reach every node you expect to be reachable?

```ts
yield * PlanAssertions.expectPlans([plan, escalationPlan]).covers(
  ["read-pr", "lint", "test", "review", "escalate"],
  { allowUnreached: ["debug/*"] }
)
```

`allowUnreached` takes node ids or `*` patterns for the nodes a static suite is
not expected to reach.

## Related

- [Test tiers](../concepts/test-tiers.md) explains why the poisoned services
  throw rather than fail.
- [`@smthrs/plan`](/api/plan) owns the key compiler these assertions read, and
  [its own testing page](/pkg/plan/testing) lists what that package already
  pins.
