---
title: "Show a catalog to a model"
description: "Project descriptors into the two compact forms a client renders: the sorted name-and-description list an autocomplete shows, and the Agent Skills XML block a model is given."
sidebar:
  order: 5
---

A descriptor holds a path, a base directory, a frontmatter record, and a
provenance root. None of that belongs in a model's context, and some of it
belongs in nobody's. `Disclosure` is the pair of projections that answer the
question "what is this catalog" without answering anything else.

## The autocomplete list

`Disclosure.toEntries` keeps the name and the description, and sorts by name:

```ts
import * as Disclosure from "@smthrs/registry/Disclosure"
import * as Registry from "@smthrs/registry/Registry"
import * as Effect from "effect/Effect"

const slashCommands = Effect.gen(function*() {
  const catalog = yield* Registry.Registry
  return Disclosure.toEntries(yield* catalog.list())
})
```

The result is `ReadonlyArray<{ name: string; description: string }>`. Sorting
inside the projection is what makes two renders of one catalog identical, so a
client does not have to sort and a snapshot test does not have to tolerate
order.

`toEntries` does not filter. It is the list a person browses, and a flow that
opted out of model invocation is still a flow the operator may run.

## The model's catalog

`Disclosure.toXml` filters to model-invocable descriptors and renders the
agentskills-style block:

```ts
const catalogXml = Effect.gen(function*() {
  const catalog = yield* Registry.Registry
  return Disclosure.toXml(yield* catalog.visible())
})
```

```text
<available_skills>
  <skill>
    <name>review</name>
    <description>Reviews a proposed change and reports concrete correctness and maintainability risks.</description>
  </skill>
</available_skills>
```

An empty catalog renders the empty block, not the empty string:

```text
<available_skills>
</available_skills>
```

`toXml` filters by `modelInvocable` itself, so passing `list()` and passing
`visible()` produce the same XML. Prefer `visible()` anyway: it is the same
filter applied once, in the registry, where every other consumer reads it.

## One malformed description cannot break the catalog

A description is author-supplied text, and a catalog is one string. `toXml`
therefore repairs before it escapes:

1. Every code point XML 1.0 forbids, every lone surrogate, and every Unicode
   noncharacter (U+FDD0 through U+FDEF, and U+FFFE and U+FFFF in every plane)
   is replaced with U+FFFD.
2. Then `&`, `<`, `>`, `"`, and `'` are escaped.

Tab, line feed, carriage return, combining marks, and astral characters survive
unchanged. The result is that one flow with a control character in its
description degrades that description rather than invalidating the whole block.

## Keeping a flow out of the model's catalog

A flow that declares `disable-model-invocation: true` is discovered and listed,
and `visible()` and `toXml` both leave it out. That is the mechanism for a
maintenance flow an operator runs deliberately and a model should not reach
for.

```md
---
description: Performs a maintenance task that is invoked explicitly.
disable-model-invocation: true
---

Perform the requested maintenance task without advertising it to the model.
```

The strings `"true"` and `"false"` are accepted as well as booleans. Any other
value, including `True`, `yes` or `on`, produces an `invalid_model_invocation` warning
and keeps the flow out of the model's catalog. Operators can still list and
invoke it. Omit the field or use `false` to allow model invocation.

## What is never disclosed

Neither projection reads `path`, `baseDirectory`, `provenance`, `frontmatter`,
or `capabilities`. Retaining unknown frontmatter verbatim on the descriptor is
useful to a host and a hazard to a model, so the projection is a whitelist of
two fields rather than a filter over the rest.

One host-side exception is worth knowing.
`MarkdownFlow.renderPrompt` appends the flow's own base directory, which is an
absolute host path, so a model reading the rendered prompt can resolve the
flow's resource files. A host that must not disclose its filesystem layout to a
model should render the body itself rather than through that helper.
