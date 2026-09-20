---
title: "Append a generation"
description: "Grow a recorded plan: pre-key a subgraph against what is already there, advance the plan row with a compare-and-swap, and keep the approved base digest intact."
sidebar:
  order: 4
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/plan-store/docs/guides/append-a-generation.md"
---

A plan elaborates. A step that discovers the shape of its own follow-on work
cannot state that work up front, so the plan grows to hold it. It grows by
appending a generation, and nothing already in it moves.

Appending is two calls: `Plan.append` produces the next generation as a value,
and `PlanStore.append` writes the rows it added.

## Grow the value

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as PlanStore from "@smthrs/plan-store/PlanStore"
import * as KeyMaterial from "@smthrs/plan/KeyMaterial"
import * as Plan from "@smthrs/plan/Plan"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"

/** From "Compile drafts into a plan" and "Persist a plan". */
declare const compiled: Effect.Effect<Plan.Plan, never, Crypto.Crypto>
declare const planStore: Layer.Layer<PlanStore.PlanStore>

export const grow = Effect.gen(function*() {
  const base = yield* compiled
  const grown = yield* Plan.append(base, [{
    id: "post-comment",
    material: {
      version: KeyMaterial.version,
      kind: "sealed",
      body: { action: "post-comment" },
      inputs: [{ _tag: "Pending", from: "run-tests" }],
      layers: [],
      capabilities: ["net:post"]
    },
    effects: { reads: ["report.json"], writes: [], boundaryMode: "hard" }
  }])
  const store = yield* PlanStore.PlanStore
  yield* store.record(base, Date.now())
  yield* store.append(grown)
  return Plan.generationNodes(grown).map((node) => node.id)
}).pipe(Effect.provide(planStore), Effect.provide(NodeCrypto.layer))
```

`Plan.append` advances `generation` by one, keys the new drafts against the
nodes already in the plan, re-runs the conflict and reader-after-writer passes,
and derives a new `digest`. The nodes already in the plan keep their id, key,
edges, and generation byte for byte, so a cache hit on them shows instantly.

`baseDigest` does not move. It is what a human approved and what a running run
pins, so an approval taken at generation 0 still validates against a plan that
has grown three times since.

## Which nodes the append adds

`Plan.generationNodes(plan)` returns the nodes at the plan's current generation.
That is what `PlanStore.append` inserts, and what a scheduler such as
[`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/)'s reports in the
`subgraph-appended` record it writes to the run journal.

## Frozen nodes are annotated one-sidedly

Both plan passes skip nodes an earlier generation froze, because their rows can
never be rewritten. When a new node conflicts with a frozen one, the annotation
lands on the new node only, and so does the ordering edge. The pair is still
fully described; it is described from the side that is still writable.

## The compare-and-swap

`PlanStore.append` advances the plan row with an UPDATE that matches on the
previous generation, the flow, and the approved base digest. If that UPDATE
matches nothing, the append fails with `constraint`:

```text
plan review-4821 was never recorded, or generation 3 was skipped or moved under the append
```

The refusal matters because of the append-only triggers. Without it the node
rows would land while the plan row update matched nothing or skipped a
generation, leaving rows whose dependencies are missing and that nothing is
allowed to delete. The whole append is one transaction, so the refusal takes the
rows back with it.

An append with no new nodes is refused for the same reason, as `invalid_plan`.

## The persisted-prefix check

Before inserting, `append` reads the nodes already stored and compares them, as
encoded JSON, against the prefix of the plan you handed it. A mismatch fails
with `constraint`:

```text
plan review-4821 recorded plan's nodes diverge from the plan this append was grown from
```

That is what catches an append grown from a divergent branch: two callers
elaborated the same recorded plan independently, and one of them is about to
graft its nodes onto a history it never saw. Recompile from the stored plan and
append again.

Ordinals are derived from the rows already stored, not from the caller's array,
so the recorded order stays contiguous even under a retry.

## Migration ordering

This package owns `flows_plans`, `flows_plan_nodes`, and `flows_plan_edges` in
migration id block `4000`, the next free block after the journal (`0`), the run
store (`1000`), the step cache (`2000`), and the engine store (`3000`).

[`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/)'s `Migrations.sets` composes this set
last, because [`@smthrs/database`](https://database.smithers.sh/reference/api/)'s migrator decides what to run
from a single high-water mark: a set whose ids sit below an already applied one
would be assumed done and silently skipped.

## Next

- [Diff two plans](https://plan.smithers.sh/guides/diff-two-plans/): show what a re-plan changed.
- [The plan value](https://plan.smithers.sh/concepts/plan-value/): why growth is the only move
  available.
