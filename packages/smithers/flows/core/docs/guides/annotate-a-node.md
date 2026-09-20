---
title: "Annotate a node"
description: "Attach placement, scheduling priority, or an effect declaration to a node, and read the resolved values back from the built graph."
sidebar:
  order: 6
---

Annotations are metadata a host or a decorator reads. Three of them have named
combinators, they are inherited lexically, and a child's value overrides its
parent's. Every combinator returns a fresh node; the original is unchanged.

```ts
import { Node, Placement } from "@smthrs/core"

const step = Node.dynamic({ model: "smart", prompt: "Build the report." }).pipe(
  Node.within(Placement.remote({ target: "builder" })),
  Node.priority(10)
)
```

## Choose where a node runs

`Placement` is a serializable directive naming a host profile. It never carries
a host implementation, credentials, or a runtime handle:

| Constructor                  | Means                        |
| ---------------------------- | ---------------------------- |
| `Placement.local()`          | The local process host.      |
| `Placement.client()`         | The viewer's browser host.   |
| `Placement.sandbox(options)` | An isolated sandbox host.    |
| `Placement.remote(options)`  | A remote control-plane host. |

`sandbox` and `remote` accept `image`, `profile`, and `target`, all optional
and all identifying a profile rather than describing one.

Placement is inherited lexically and a node overrides what it inherited:

```ts
const flow = Flow.make({
  body: () => Node.succeed("ok").pipe(Node.within(Placement.client()))
}).pipe(Flow.within(Placement.sandbox({ image: "base" })))

console.log(Graph.placements(Graph.build(flow)))
```

```text
[
  {
    nodeId: 'root',
    placement: { _tag: 'flows/core/Placement/Client' }
  }
]
```

Placement enters key material, so moving a step to a different host is a
different step.

## Order ready work

`Node.priority` takes a signed safe integer. A scheduler runs a higher number
first. Children inherit the value lexically, so annotating a container
prioritizes everything under it that does not state its own.

Priority never enters key material: it orders work without changing what the
work produces, so raising it never invalidates a cached step. Read it back from
`GraphNode.priority` or `GraphNode.annotations.priority`.

A value that is not a safe integer raises `NodeBuildError` at declaration time:

```text
flows/core/NodeBuildError: Node.priority expects a safe integer, received 1.5
```

## Read a worktree lane

A node never declares a lane. Two writers whose effect declarations conflict
under `onConflict: "lane"` each get a lane derived from their node id, such as
`lane:root.all.a`, and the graph reports it on `GraphNode.lane`.

Lanes are plan-time vocabulary. No runtime in this release executes one. Treat
a lane as a declaration a future scheduler may honor.

## Declare effects on a node

`Node.withEffects` attaches an effect declaration. On a work node it is the
node's own envelope and the thing conflict analysis compares. On any other node
it narrows the envelope its children inherit and enters that container's
identity, without being counted a second time against those children.

See [Declare what a step reads and writes](./declare-reads-and-writes.md).

## Read the annotations back

Each planned node exposes the four resolved values directly and as one
serializable projection:

```ts
for (const node of Graph.nodes(graph)) {
  console.log(node.placement, node.priority, node.lane, node.effectiveEffects)
  console.log(node.annotations) // { placement, effects, lane, priority }
}
```

`Graph.placements` is the placement-only view, skipping nodes that resolved
none.

## Annotations beyond the four

The annotation bag is an Effect `Context`, so a decorator can define its own
key and attach it to a flow:

```ts
import { Annotations, Flow } from "@smthrs/core"
import * as Context from "effect/Context"

const Owner = Context.Service<string>("example/Owner")

const owned = Flow.annotate(Review, Owner, "platform-team")
const owner = Annotations.getOption(owned.annotations, Owner)
```

`Annotations.empty` is the empty bag, `Annotations.add` sets one key without
changing the original, `Annotations.merge` combines a parent and a child bag
with the child winning, and `Annotations.getOption` reads one key as an
`Option`. The planner projects only the four keys this package defines into
`GraphNode`; a custom key stays on the flow for whoever put it there.

## Where to go next

- [Declare a flow](./declare-a-flow.md): the same annotations at the flow
  level.
- [Inspect a built graph](./inspect-a-graph.md): every getter that reports an
  annotation.
