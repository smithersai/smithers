---
title: "Compile drafts into a plan"
description: "Turn NodeDraft values into a keyed graph: what compile does in order, the one service it needs, and every refusal it can answer with."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/plan/docs/guides/compile-a-plan.md"
---

`Plan.compile` is the whole plan phase in one function. Hand it drafts, get back
a keyed graph with a digest.

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as KeyMaterial from "@smthrs/plan/KeyMaterial"
import * as Plan from "@smthrs/plan/Plan"
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
  effects: { reads: ["pr.json"], writes: ["report.json"], boundaryMode: "hard" },
  priority: 10,
  conflictStrategy: "serialize",
  runtimeStrategy: "delay-rebase"
}

const compiled = Plan.compile({
  planId: "review-4821",
  flow: "example/Review",
  nodes: [readPr, runTests]
}).pipe(Effect.provide(NodeCrypto.layer))
```

## What a draft carries

| Field              | Required | What it decides                                                                                                            |
| ------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `id`               | yes      | The durable lookup address. Not part of the declaration fingerprint; non-cacheable execution uses it as a run-local scope. |
| `material`         | yes      | Everything the key is derived from.                                                                                        |
| `effects`          | yes      | Declared reads, writes, optional removals, and the boundary mode.                                                          |
| `kind`             | no       | `step`, `agent`, or `merge`. Defaults to `step`.                                                                           |
| `priority`         | no       | Scheduling tie-break. Defaults to 0.                                                                                       |
| `conflictStrategy` | no       | This node's preferred plan-time verdict for an overlap. Defaults to `serialize`.                                           |
| `runtimeStrategy`  | no       | This node's preferred response when an overlap bites. Defaults to `delay-rebase`.                                          |

## What compile does, in order

1. Validates `planId`, `flow`, and every draft, decoding `material` and
   `effects` through their schemas.
2. Puts the drafts in topological order from the dependencies their material
   names.
3. Keys each node, substituting every `Ref` and `Pending` for the already
   computed key of the node it names.
4. Annotates overlapping write sets and adds the ordering edges the verdicts
   imply.
5. Adds reader-after-writer edges where explicit `Ref`/`Pending` paths have not
   already selected read-before-write sequencing. A read before a writer
   consumes an earlier version, not that later writer's output. Contradictory
   inferred orderings still fail with `cycle`.
6. Derives the plan digest over the whole result.

The nodes come back in topological order of material dependencies, deep-frozen,
at generation 0, with `baseDigest` equal to `digest`. Inferred edges extend
`dependsOn` without reordering the array. For example, a reader declared before
an independent writer stays first in `plan.nodes`, even when its `dependsOn`
contains that writer. Schedule nodes from the complete `dependsOn` graph;
iterating the array alone can run a reader before its producer.

## The one service it needs

Compiling asks for Effect's `Crypto` service and nothing else. Provide it from a
platform package:

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"

const plan = compiled.pipe(Effect.provide(NodeCrypto.layer))
```

In a browser, provide the browser platform's `Crypto` layer instead. No part of
compilation reaches a file, a clock, or a network.

## Your drafts are copied, not held

`compile` snapshots its options before it does anything else, and the plan it
returns is deep-frozen. Mutating a draft afterwards cannot change the plan, its
keys, or its digest. Material is stored as the inert JSON mirror its key already
covers, so a `Date` or `URL` in a body is stored as the value it serializes to.

## When compile refuses

`PlanError` is a closed set of seven codes, so a caller can switch on `code`.

| `code`               | Cause                                                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `cycle`              | Material dependencies close a cycle, or a reader-after-writer edge would close one.                                                |
| `unknown_dependency` | A `Ref` or `Pending` names a node that is neither in the drafts nor already in the plan.                                           |
| `duplicate_node`     | A draft reuses an id the plan already holds.                                                                                       |
| `overlap_forbidden`  | A `fail` pair genuinely overlaps and no dependency path orders it.                                                                 |
| `invalid_effects`    | One path is declared as both a write and a removal.                                                                                |
| `invalid_node`       | An empty id or flow, a priority that is not a safe integer, a value outside a literal set, or material this release cannot decode. |
| `graph_too_large`    | The plan would hold more than `Plan.maximumPlanNodes` nodes.                                                                       |

All three effect tiers compile. `StepKey.planIdentity` produces approval-bound
declaration fingerprints; compilation does not grant cache eligibility.
`compile` can also fail with `StepKey.KeyMaterialError` when a dependency
digest is missing, and with a `Schema.SchemaError` from decoding.
[Troubleshooting](/troubleshooting/) states the fix for each one.

## Size

`Plan.maximumPlanNodes` is 10,000. The conflict and reader-after-writer passes
compare node pairs, so the cost is at least quadratic in node count, and each
pair whose write sets actually overlap adds one on-demand reachability walk.
A plan above the ceiling is refused before any pair is compared.

If you are approaching the ceiling, split the work across flow boundaries rather
than raising it: a plan that large is also a plan no operator can review.

## Next

- [Persist a plan](/guides/persist-a-plan/): record the compiled value and read it
  back.
- [Declare the files a node touches](/guides/declare-file-effects/): the vocabulary
  behind step 4 and step 5.
- [Step keys](/concepts/step-keys/): what step 3 folds in, and what it
  deliberately leaves out.
