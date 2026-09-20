---
title: "Inspect a built graph"
description: "Build a graph from a declaration and read back its nodes, edges, effects, placements, conflicts, diagnostics, and key material."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/core/docs/guides/inspect-a-graph.md"
---

`Graph.build` takes a flow or a node and returns a frozen graph. Seven getters
read it, and each answers one question.

```ts
import { Graph } from "@smthrs/core"

const graph = Graph.build(Review, { path: "src/api.ts" })
```

The second argument is the input for a flow. Pass a node instead and omit it.
The third argument is `BuildOptions`, whose only member is `resolveLayers`; see
[Identity and key material](/concepts/identity/).

## Check the diagnostics first

`Graph.build` records declaration problems rather than throwing them, so a
graph can be well formed and still describe something invalid. Read the
diagnostics before you trust anything else:

```ts
for (const diagnostic of Graph.diagnostics(graph)) {
  console.log(diagnostic.code, diagnostic.node, Graph.isFatalDiagnostic(diagnostic))
}
```

A `GraphBuildError` carries a `code`, the `node` it belongs to, a `path` array,
and a `message` stating the fix. It is [`@smthrs/plan`](https://plan.smithers.sh/reference/api/#graphbuilderror)'s
one build refusal. A write conflict names the first of the overlapping pair in
`node`; `Graph.conflicts` carries both. `Graph.isFatalDiagnostic` reports
whether the code blocks key material. Every code except
`capability_outside_grant` is fatal. For each code and its fix, see
[Troubleshooting](/troubleshooting/).

## Nodes

`Graph.nodes` returns the nodes in structural preorder:

```ts
for (const node of Graph.nodes(graph)) {
  console.log(node.id, node.kind, node.dependencies)
}
```

| Field                           | What it holds                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `id`                            | The node's structural position, such as `root.andThen.all.api`.                                                          |
| `kind`                          | The AST tag: `Succeed`, `Fail`, `All`, `Dynamic`, `Map`, `AndThen`, `Catch`, `FlowCall`, or the synthesized `LaneMerge`. |
| `dependencies`                  | The ids this node depends on.                                                                                            |
| `declaredEffects`               | The declaration this node itself carries.                                                                                |
| `effectiveEffects`              | The envelope in force here. Only work nodes have one.                                                                    |
| `placement`, `lane`, `priority` | The resolved annotations.                                                                                                |
| `capabilities`                  | The sorted capability names in force here.                                                                               |
| `annotations`                   | The same four annotations as one serializable projection.                                                                |
| `keyMaterial`                   | This node's digest-free key material.                                                                                    |

## Edges

`Graph.edges` returns dependency edges in structural preorder, each with the
reason it exists:

```ts
for (const edge of Graph.edges(graph)) {
  console.log(`${edge.from} -> ${edge.to} [${edge.reason}]`)
}
```

`value` is a structural dependency, `continuation` is a planned `andThen` or
`catch` arm, `conflict` is an ordering edge the write-conflict pass added, and
`lane-merge` joins two laned writers to their merge node.

## Effects and placements

`Graph.effects` returns one entry per node that declares or inherits an
envelope, with both:

```ts
for (const entry of Graph.effects(graph)) {
  console.log(entry.nodeId, entry.declared, entry.effective)
}
```

`Graph.placements` returns one entry per node that resolved a placement, in
structural preorder. Both getters skip the nodes that have nothing to report,
so an empty result means no node declared one.

## Conflicts

`Graph.conflicts` returns each pair of work nodes whose declared writes
overlap:

```ts
for (const conflict of Graph.conflicts(graph)) {
  console.log(conflict.nodes, conflict.paths, conflict.strategy, conflict.mergeNodeId)
}
```

`strategy` is the stricter of the two declarations' `onConflict` values, and
`mergeNodeId` is set only for a `lane` conflict, naming the synthesized
`LaneMerge` node. Remember that only `Dynamic` nodes are writers for this
purpose: a plan built entirely from `Node.succeed` reports no conflicts however
its declarations overlap.

## Key material

`Graph.keyMaterial` returns a `Result`, because it refuses a graph carrying a
fatal diagnostic:

```ts
import * as Result from "effect/Result"

const material = Graph.keyMaterial(graph)
if (Result.isFailure(material)) {
  console.error("cannot key this plan:", material.failure.code)
} else {
  for (const entry of material.success) console.log(entry.nodeId, entry.material.kind)
}
```

The entries arrive in topological dependency order, so a key compiler can
substitute each dependency's digest before hashing the node that depends on it.
The `nodeId` on each entry is traversal data and is not part of the material
handed to the compiler.

## The graph is frozen

`Graph.build` deep-freezes everything it constructs, and the getters hand back
the graph's own values rather than copies. An observer cannot edit the plan it
is reading, and a mutation attempt fails rather than silently succeeding. Only
`Graph.effects` and `Graph.placements` build a new array, because they filter.

Caller-supplied plan values are a separate matter: they are read by reference
and not frozen. See [Identity and key material](/concepts/identity/).

## Where to go next

- [Troubleshooting](/troubleshooting/): what each diagnostic means and what
  to change.
- [Effect envelopes](/concepts/effects/): the model behind the effects and
  conflicts getters.
