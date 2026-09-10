---
title: "Run a discovered flow"
description: "Turn descriptors into registered durable flows: register the delegates a project's flows name, build the catalog, and hand the whole registry to a Node host."
sidebar:
  order: 3
---

`Executable` is the bridge from a descriptor to something the engine can drive.
It loads the body, resolves the delegate, and returns a durable flow plus the
layer that registers it. [Delegation](../concepts/delegation.md) explains the
model; this guide is the wiring.

## Register the flows a descriptor may delegate to

A delegate is any `@smthrs/flow` flow whose payload is `Executable.Invocation`.
The contract is structural, so a `Flow.make` value satisfies it and so does a
test double:

```ts
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Executable from "@smthrs/registry/Executable"
import * as Schema from "effect/Schema"

/** The driver every model-backed descriptor falls back to. */
const Agent = Flow.make("agent", {
  payload: Executable.Invocation,
  success: Schema.Unknown,
  body: (invocation) => Node.succeed(invocation.prompt)
})

/** A named delegate a descriptor reaches with `flows: [shell]`. */
const Shell = Flow.make("shell", {
  payload: Executable.Invocation,
  success: Schema.Unknown,
  body: (invocation) => Node.succeed(invocation.input)
})
```

The tag is what a descriptor's `flows` entry names. `Executable.defaultAgent`
is the name a descriptor falls back to when it names none, and
`Options.agent` renames it for a host that calls its driver something else.

## Build the catalog

`Executable.catalog(options)` builds every descriptor the host can run and
reports the rest:

```ts
import * as Effect from "effect/Effect"

const built = Effect.gen(function*() {
  const catalog = yield* Executable.catalog({ delegates: [Agent, Shell] })
  console.log(`runnable: ${catalog.executables.map((one) => one.descriptor.name).join(", ")}`)
  for (const refusal of catalog.refused) {
    console.log(`${refusal.flow}: ${refusal.code}: ${refusal.message}`)
  }
})
```

Nothing here raises. A delegate only another host registers
(`missing_delegate`, `ambiguous_delegate`) and a defect in the entry itself
(`body_unavailable`, `invalid_module`) are both reported rather than thrown,
because one broken file must not take every unrelated flow down with it. The codes are what separate the two kinds: the first pair is a
statement about this host, the second is a defect in the flow.

## Register everything runnable

`Executable.layer(options)` is the layer a host passes as its registration
phase. It registers every runnable flow, logs a warning naming each refusal,
and provides the whole `Catalog` as a service, so a command that lists or
diagnoses flows reads the same refusals the registration acted on:

```ts
import { Action } from "@smthrs/flow"
import * as Layer from "effect/Layer"

const registration = Executable.layer({ delegates: [Agent, Shell] }).pipe(
  Layer.provideMerge(Action.layerImplementations)
)
```

The layer requires the flow runtime it registers with, the action
implementation table a bridged dispatch resolves through, and the `Crypto` the
bridge derives a child execution id with. `Executable.Registration` is that
requirement as one type.

## Hand the registry to a Node host

`Registry.layerProject({ root, packs })` is the registry a Node host
discovers a project in: `<root>/flows/**` first, then every installed pack,
under one refreshable first-found registry.

```ts
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as Registry from "@smthrs/registry/Registry"

const host = NodeRuntime.layerHost(
  {
    filename: ".flows/engine.db",
    workspaceRoot: process.cwd(),
    owner: { hostId: "local" }
  },
  registration,
  Registry.layerProject({ root: process.cwd() })
)
```

The host builds the registry between the engine and the registration phase, so
`Executable.layer` has both the catalog and a live engine in hand. After that,
running a discovered flow by name reaches a registered durable flow instead of
an empty catalog.

A project with no `flows/` directory is not a failure: it has no flows yet,
which is the state [`smthrs init`](/cli/init) leaves behind.
`layerProject` checks for that optional directory on every scan. Creating the
first flow or removing and recreating the directory is reflected by `refresh()`.
A pack that declares a flows directory it does not ship is a broken installation and fails the layer as
`RegistryError { code: "invalid_pack" }` naming the pack, instead of quietly
emptying the registry the project's own flows were in.

## Build one executable at a time

Two constructors build a single flow, for a host that already knows which one
it wants:

```ts
import * as Registry from "@smthrs/registry/Registry"

const one = Executable.fromRegistry("review", { delegates: [Agent, Shell] })
const same = Effect.gen(function*() {
  const catalog = yield* Registry.Registry
  return yield* Executable.fromDescriptor(yield* catalog.get("review"), { delegates: [Agent, Shell] })
})
```

Both fail rather than report, which is what a single named launch wants: an
operator asking for one flow should be told why it will not run. The two halves
fail differently. Looking the name up fails with
`RegistryError { code: "not_found" }`, naming the method that asked, so
`fromRegistry` on an unknown name never reaches the bridge. Lowering and
loading a descriptor the registry did hold fails with `ExecutableError`. See
[Troubleshooting](../troubleshooting.md).

## Supply your own module loader

`Options.load` replaces the default dynamic `import` of the file a module
descriptor points at. A bundled host, or a test that needs a module no file can
contain, supplies its own:

```ts
const options: Executable.Options = {
  delegates: [Agent, Shell],
  load: (path) => Effect.succeed({ default: modulesByPath[path] })
}
```

The loader receives a filesystem path, not a specifier.
`Executable.fileSpecifier(path)` is the conversion the default loader makes,
exported so a custom loader can make the same one without depending on
`node:url`. It escapes what `pathToFileURL` escapes, which matters because a
`#` or `?` in a directory name is both a legal filename character and URL
syntax: concatenating one unescaped truncates the specifier and imports the
wrong module, or none.

A module must default-export a `Flow.make` value. Anything else is
`ExecutableError { code: "invalid_module" }`.
