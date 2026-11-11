---
title: "Quickstart"
description: "Run a chain to a terminal outcome with a scripted author, then read the journal it wrote."
sidebar:
  order: 2
---

This quickstart runs a two-link chain to `done` without a model account: a
scripted author stands in for the model, an in-memory journal holds the
events, and the production QuickJS runner executes the scripts. By the end
you have a terminal outcome and the journal that produced it. Each step below
is TypeScript; the [VibeLang tab](#the-same-walkthrough-in-vibelang) runs steps
2 to 6 as Effect code.

## 1. Get the package

A chain runs on Node.js 26.4.0 or later and pulls in
[Effect](https://effect.website), which every sample below imports.
[Installation](./installation.md) covers where to get the package, the import
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
[Flow scripts](./concepts/flow-scripts.md).

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
[Write catalog entries](./guides/catalog-entries.md).

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
guard them, see [Resume and replay](./guides/resume-and-replay.md).

## The same walkthrough in VibeLang

In [VibeLang](https://github.com/smithersai/vibelang) the run and the replay
are `effect` functions: a `provide` block supplies the journal, author, runner
and catalog layers, and `try` runs `Chain.run` and reads the journal where the
TypeScript writes `yield*`. The replay provides the same catalog with an empty
author and `ScriptRunner.layerNoop()`, so it can only answer from the journal.

This is `examples/quickstart.vibe`. `test/quickstart.test.vibe` runs it, and
the package's docs check fails if this block and the file differ.

````vibe
import { Author, Catalog, Chain, type Event, Journal, QuickJsRunner, ScriptRunner } from "@smthrs/chain"

/** The bootstrap script: search, then ask the author for a successor. */
const l1 = [
  "```flow",
  `const hits = await ctx.call("grep", { pattern: "TODO" })`,
  `const s = await ctx.call("author", { context: [hits.files.join("\\n")] })`,
  "return to(s)",
  "```"
].join("\n")

/** The successor script: edit, then finish. */
const l2 = [
  "```flow",
  `await ctx.call("edit", { file: "a.ts" })`,
  "return done({ patched: true })",
  "```"
].join("\n")

const grep: Catalog.Entry = {
  name: "grep",
  description: "Search the workspace for a pattern",
  handler: () => succeed({ files: ["a.ts", "b.ts", "c.ts"] })
}

const edit: Catalog.Entry = {
  name: "edit",
  description: "Apply a patch to one file",
  handler: () => succeed({ ok: true })
}

const entries = Catalog.withSystem([grep, edit])

/** Runs the chain live with a scripted author and returns its outcome and journal. */
export effect function runChain() {
  provide Layer.mergeAll(
    Journal.layerMemory(),
    Author.layerMock([l1, l2]),
    QuickJsRunner.layer(),
    Catalog.layer(entries)
  ) {
    const outcome = try Chain.run({ goal: "fix TODOs" })
    const events = try (try Journal.Journal).read
    return { events, outcome }
  }
}

/** Replays a finished journal: no author output and a runner that cannot execute. */
export effect function replayChain(events: ReadonlyArray<Event.Event>) {
  provide Layer.mergeAll(
    Journal.layerMemory(events),
    Author.layerMock([]),
    ScriptRunner.layerNoop(),
    Catalog.layer(entries)
  ) {
    return try Chain.run({ goal: "fix TODOs" })
  }
}
````

## 7. Drive it with a model

Swap the scripted author for `ModelAuthor.layer(config)` over a `Model.Model`
layer from the [@smthrs/model package](/api/model). The model layer goes
UNDER the author layer with `Layer.provide`: siblings in one `Layer.mergeAll`
cannot satisfy each other.

Neither `Chain` nor `ModelAuthor` writes a prompt. `Chain.run` defaults
`prefix` to the empty string and `ModelAuthor` sends no system part for an
empty prefix, so a run that passes only a `goal` gives the model no flow
contract and no catalog. Read the mounted catalog and assemble the prefix
with `Prompt.forCatalog` so the entries the model reads are the entries the
chain dispatches:

```ts
import { Catalog, Chain, Journal, ModelAuthor, Prompt, QuickJsRunner } from "@smthrs/chain"
import { Effect, Layer } from "effect"

const author = ModelAuthor.layer({ modelId: "claude-opus-5" }).pipe(
  Layer.provide(modelLayer)
)

const layers = Layer.mergeAll(
  Journal.layerMemory(),
  author,
  QuickJsRunner.layer(),
  Catalog.layer(Catalog.withSystem([grep, edit]))
)

const program = Effect.gen(function*() {
  const catalog = yield* Catalog.Catalog
  return yield* Chain.run({
    goal: "fix TODOs",
    prefix: Prompt.forCatalog(catalog, "concierge")
  })
})

const outcome = await Effect.runPromise(program.pipe(Effect.provide(layers)))
```

The prefix is byte-stable for the same catalog, so the provider's prompt
cache hits across links. A host that mounts more than the chain dispatches
passes the prose that teaches it as the third `forCatalog` argument.

## Next steps

- [Concepts](./concepts/journal.md): the journal, keyed replay, the
  trampoline, and flow scripts, one mental model per page.
- [Authorize calls](./guides/authorization.md): put a policy seam in front
  of gate 4.
- [Test a chain](./guides/testing.md): the mock and noop layers this
  package tests itself with.
- [API reference](./api.md): every export of the 20 namespaces.
