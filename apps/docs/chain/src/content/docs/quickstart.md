---
title: "Quickstart"
description: "Run a chain to a terminal outcome with a scripted author, then read the journal it wrote."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/chain/docs/quickstart.md"
---

This quickstart runs a two-link chain to `done` without a model account: a
scripted author stands in for the model, an in-memory journal holds the
events, and the production QuickJS runner executes the scripts. By the end
you have a terminal outcome and the journal that produced it.

## 1. Get the package

A chain runs on Node.js 22.19.0 or later and pulls in
[Effect](https://effect.website), which every sample below imports.
[Installation](/installation/) covers where to get the package, the import
paths it exposes, and the services a run needs.

## 2. Write the author scripts

A chain asks its author seat for a script whenever a link has nothing to run.
The author replies with raw model output, and gate 1 keeps exactly one fenced
`flow` block. A flow script's only exits are `ctx.call(name, payload)` and
the outcome it returns: `done(value)` ends the chain, `to(script)` hands off
to a successor, `park(code, message)` suspends.

The first script searches, then hands its hits to the author for a successor
script. The second script edits and finishes.

````ts
const l1 = [
  "```flow",
  `const hits = await ctx.call("grep", { pattern: "TODO" })`,
  `const s = await ctx.call("author", { context: [hits.files.join("\\n")] })`,
  "return to(s)",
  "```"
].join("\n")

const l2 = [
  "```flow",
  `await ctx.call("edit", { file: "a.ts" })`,
  "return done({ patched: true })",
  "```"
].join("\n")
````

`author` is an ordinary catalog call: the model seat sits behind the same one
door as every other effect. For the script model, see
[Flow scripts](/concepts/flow-scripts/).

## 3. Write two catalog entries

Every effect a script can perform is a catalog entry: a name, a description
the model reads, and a handler that returns an Effect.

```ts
import * as Catalog from "@smthrs/chain/Catalog"
import { Effect } from "effect"

const grep: Catalog.Entry = {
  name: "grep",
  description: "Search the workspace for a pattern",
  handler: () => Effect.succeed({ files: ["a.ts", "b.ts", "c.ts"] })
}

const edit: Catalog.Entry = {
  name: "edit",
  description: "Apply a patch to one file",
  handler: () => Effect.succeed({ ok: true })
}
```

For capabilities, declaration digests, and failure behavior, see
[Write catalog entries](/guides/catalog-entries/).

## 4. Compose the layers and run

```ts
import { Author, Catalog, Chain, Journal, QuickJsRunner } from "@smthrs/chain"
import { Effect, Layer } from "effect"

const layers = Layer.mergeAll(
  Journal.layerMemory(),
  Author.layerMock([l1, l2]),
  QuickJsRunner.layer(),
  Catalog.layer(Catalog.withSystem([grep, edit]))
)

const program = Effect.gen(function*() {
  const outcome = yield* Chain.run({ goal: "fix TODOs" })
  const journal = yield* Journal.Journal
  const events = yield* journal.read
  return { events, outcome }
})

const { events, outcome } = await Effect.runPromise(
  program.pipe(Effect.provide(layers))
)
```

`Author.layerMock` pops the canned outputs in order, one per author call:
`l1` for the bootstrap call, `l2` for the handoff. `Catalog.withSystem`
appends `sys/now` and `sys/random` last so nothing you pass can shadow them;
the sealed realm deletes `Date` and `Math.random` on that promise.

## 5. Read the result

`outcome` is the chain's terminal:

```ts
{ _tag: "Done", value: { patched: true } }
```

The journal holds ten events, in this order:

```text
ChainStarted, CallSettled, LinkAuthored, LinkEnded,
CallSettled, CallSettled, LinkAuthored, LinkEnded,
CallSettled, LinkEnded
```

Each `CallSettled` carries a `CallKey`: the link, the digest of the script
that issued the call, the ordinal within that link, and the digest of the
entry's declaration. That key is what makes the next section work.

## 6. Replay it

Run the same program again over the journal you just read, with an empty
author mock and a runner that cannot execute:

```ts
import { ScriptRunner } from "@smthrs/chain"

const replay = Layer.mergeAll(
  Journal.layerMemory(events),
  Author.layerMock([]),
  ScriptRunner.layerNoop(),
  Catalog.layer(Catalog.withSystem([grep, edit]))
)

const again = await Effect.runPromise(
  Chain.run({ goal: "fix TODOs" }).pipe(Effect.provide(replay))
)
```

`again` is the same `Done`. A finished chain returns its terminal without
executing anything, and a half-finished link replays its settled calls by
ordinal before running live. For the re-keying rules and the failures that
guard them, see [Resume and replay](/guides/resume-and-replay/).

## Next steps

- [Concepts](/concepts/journal/): the journal, keyed replay, the
  trampoline, and flow scripts, one mental model per page.
- [Authorize calls](/guides/authorization/): put a policy seam in front
  of gate 4.
- [Test a chain](/guides/testing/): the mock and noop layers this
  package tests itself with.
- [API reference](/reference/api/): every export of the 19 namespaces.
