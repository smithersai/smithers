---
title: "Declare a flow"
description: "Build a schema-described signature with Flow.make: the options it accepts, what a body-less declaration lowers to, and the combinators that copy one."
sidebar:
  order: 1
---

A signature is one options object. `Flow.make` returns a value that carries the
declaration, the `@smthrs/flow` flow it lowered to, and, when it declared no
body, the action a host implements. `signature.call(input)` does not run
anything: it records a call node.

```ts
import { Flow, Node } from "@smthrs/core"
import * as Schema from "effect/Schema"

const Review = Flow.make({
  name: "review",
  description: "Reviews one file and reports whether it passes.",
  input: Schema.Struct({ path: Schema.String }),
  output: Schema.Struct({ approved: Schema.Boolean, notes: Schema.String }),
  body: ({ path }) => Node.succeed({ approved: true, notes: `reviewed ${path}` })
})

const call = Review.call({ path: "src/api.ts" })
```

## The options

| Option         | Default          | What it does                                                            |
| -------------- | ---------------- | ----------------------------------------------------------------------- |
| `name`         | required         | The tag the flow, the action, and every plan that records a call carry. |
| `description`  | none             | Prose a catalog shows.                                                  |
| `input`        | `Schema.Void`    | The input schema. Invariant, because it both decodes and encodes.       |
| `output`       | `Schema.Unknown` | The output schema.                                                      |
| `error`        | `Schema.Never`   | The failure schema.                                                     |
| `capabilities` | `[]`             | Capability names this declaration runs under. Deduplicated and sorted.  |
| `effects`      | none             | The read and write envelope, and the tier, for everything beneath it.   |
| `model`        | none             | An advisory seat name.                                                  |
| `flows`        | none             | Advisory collaborators: signatures or unresolved registry names.        |
| `prompt`       | none             | An advisory prompt.                                                     |
| `body`         | none             | The function returning the node this signature is.                      |

`name` is required. It is what a host binds an implementation to and what a plan
records, so `Flow.make` throws `TypeError` without one rather than minting an
empty tag. A declaration loaded from a file takes the name its loader derives
from the path.

`Seat` is a name, never a provider model id, and never a credential. Resolving
it into something that can answer is a host's job.

## Two kinds of declaration

**A signature with a body** is code this package planned. Its `flow` has that
body, `Graph.build` splices the nodes it returns into the caller's plan, and
`action` is `undefined`.

**A signature without a body** is work someone else implements. Its `action` is
the declaration a host attaches the implementation to, and its `flow`'s whole
body is one call to that action, which is the shape a declared capability
ceiling is read off:

```ts
import { Effect } from "effect"

const Summarize = Flow.make({
  name: "summarize",
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.String,
  model: "smart",
  prompt: "Summarize the input."
})

const layer = Summarize.action!.toLayer(({ text }) => Effect.succeed(text.slice(0, 80)))
```

`model`, `flows`, and `prompt` are recorded either way, for a catalog to list
and for a host filling in that implementation to read.

A signature that declares no effect envelope dispatches as `irreversible`: a
declaration that never stated its tier must not content-share another run's
result. `Flow.sealed` states the opposite.

## A non-struct input travels as one field

`@smthrs/flow` requires a struct payload. A signature may declare any schema, so
a non-struct input is wrapped as the one field `input`:

```ts
const Length = Flow.make({
  name: "length",
  input: Schema.String,
  output: Schema.Number
})

Length.call("four") // the declared shape
Length.action!.toLayer(({ input }) => Effect.succeed(input.length))
```

`signature.input` is the schema as declared, and `Flow.Payload<I>` names the
wrapped one. `call` wraps for you; an implementation sees the payload.

## Combinators return a fresh signature

Every combinator rebuilds. The original is never modified, and everything it
carried comes across unchanged, which is what lets a decorator rewrite a flow
tree without dropping the metadata a host reads back.

```ts
import { Annotations, Placement } from "@smthrs/core"

const Hardened = Review.pipe(
  Flow.withCapabilities(["fs:read"]),
  Flow.within(Placement.sandbox({ image: "node:22" })),
  Flow.annotate(Annotations.Priority, 5),
  Flow.sealed()
)
```

| Combinator              | What it changes                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `Flow.withCapabilities` | Adds capabilities. The result is sorted and duplicate-free.                           |
| `Flow.within`           | Sets the placement annotation.                                                        |
| `Flow.annotate`         | Sets any typed annotation. `within` is its placement-shaped special case.             |
| `Flow.annotateMerge`    | Merges a bag of annotations, supplied values winning.                                 |
| `Flow.withFlows`        | Replaces the declared collaborators. The array is copied.                             |
| `Flow.sealed`           | Makes the declaration `hermetic` and `sealed`, adding an empty one if there was none. |

The declared `capabilities` and `effects` are lowered into the annotation bag
the flow and the action carry, and `signature.annotations` is that bag. A custom
annotation is advisory, so a signature annotated with one plans the same graph;
`Annotations.Placement` and `Annotations.Effects` are not, because `Graph.build`
projects both into node key material.

## Guarding a signature

`Flow.isFlow` narrows an unknown value to `Flow.Any`, the existential that names
every property a consumer outside this package reads:

```ts
const declared = (values: ReadonlyArray<unknown>): ReadonlyArray<Flow.Any> => values.filter(Flow.isFlow)
```

Use `Flow.Any` for a collection of signatures with different schemas, and
`Flow.Input`, `Flow.Output`, and `Flow.Error` to extract one signature's types.

## Where to go next

- [Declare what a step reads and writes](./declare-reads-and-writes.md):
  envelopes and the diagnostics they produce.
- [Load an Agent Skill](./load-an-agent-skill.md): the same declaration, lowered
  from a Markdown document.
