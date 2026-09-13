---
title: "The aggregate surface"
description: "Why @smthrs/flows re-exports the authoring model flat and every infrastructure package as a namespace, why the platform bundles are deliberately absent, and what the browser-safe root does and does not promise."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/docs/concepts/aggregate-surface.md"
---

The barrel is a packaging decision, not a new layer of API. Understanding the
three choices behind it tells you where to look when a name is not where you
expected it.

## Namespaces keep each package's constructors apart

Every engine package is re-exported as a namespace, the way `effect`'s own index
does it. That preserves each package's `make`, `makeNoop`, and `layerNoop` trio
instead of collapsing them all into one shared namespace, so
`Kernel.ChildProcessSpawner.layerNoop` and `RunStore.RunStore.layer` still read
as themselves.

The cost is one extra hop: a package's module sits one level below its
namespace, so `Journal.SqlJournal.layer` here is
`SqlJournal.layer` from `@smthrs/journal/SqlJournal` there. Destructuring at the
top of a file is the usual answer:

```ts
import { EngineStore as EngineStorePackage, Journal as JournalPackage } from "@smthrs/flows"

const { EngineStore, Migrations, StepBoundary } = EngineStorePackage
const { SqlJournal } = JournalPackage
```

## The authoring model is flat, on purpose

[`@smthrs/flow`](https://flow.smithers.sh/reference/api/) is the one package re-exported flat. All fourteen of
`Action`, `DurableClock`, `DurableDeferred`, `DurableQueue`, `Flow`,
`FlowRuntime`, `Graph`, `HumanTask`, `Interpreter`, `Poll`, `RetryPolicy`,
`Sleep`, `StepIdentity`, and `WaitFor` sit at the top level beside the
infrastructure namespaces.

Writing a flow is the point of the library, and `Flows.Flow.Flow.make` would be
noise. `Interpreter` belongs to that set because a host composition needs it:
the registration layer `NodeRuntime.layerHost` takes is built from
`Interpreter.layer(flow)`.

[`@smthrs/time-travel`](https://time-travel.smithers.sh/reference/api/) contributes the second flat name for a
different reason. `TimeTravel` is a service key rather than a namespace, so
`const timeTravel = yield* TimeTravel` is the entire onboarding and
`TimeTravel.layer` provides it. The rest of that package, including `Frame`,
`TimeTravelStore`, and `EffectBoundary`, is reached through the package itself.

The two re-export styles never collide. If `@smthrs/flow` ever exported a name
an engine package already claims, the explicit namespace export would shadow the
flat one and a public export would vanish without a compile error, so the
package treats the two name sets as disjoint and holds them that way across
releases.

## `namespaces` is the barrel's only runtime value

```ts
import { namespaces } from "@smthrs/flows"
```

It is the sorted list of every name the barrel exports, covering both styles.
Use it to enumerate the surface at runtime, in a documentation generator or a
conformance check of your own.

The list is the whole engine and nothing else. Three kinds of package stay out
of it by design: the barrel itself, the `platform-*` bundles, and every
`@smthrs` package that is not part of the engine, such as the agent surface and
the build tooling.

## The platform bundles are deliberately absent

`@smthrs/platform-node`, `@smthrs/platform-bun`, and
`@smthrs/platform-browser` are not re-exported, for the same reason `effect`'s
index does not re-export `@effect/platform-node`: a platform bundle is chosen by
the program that runs, not by the library it depends on. Pulling all three in
would make one import resolve `node:child_process`, ZenFS, and Bun at once.

The same rule holds one level down. Platform implementations never appear
through the namespaces either: reach `@smthrs/testing/TestHost`,
`@smthrs/database/node/NodeDatabase`, and `@smthrs/journal/test/TestJournal`
through their own packages.

## Bundling for a browser is not durable execution

The root entry point bundles for a browser, and so does every package root it
re-exports. What that buys is authoring and inspection: declaring flows, reading
a plan, decoding a journal event.

Durable execution uses local SQLite through NodeRuntime or BunRuntime. The
shared Runtime consumes injected Effect services; selecting another SQL client
does not by itself establish browser or edge support. Native compositions live
at separate subpaths, so importing `@smthrs/flows` never opens a native driver.
See [runtime portability](/concepts/runtime-portability/) for the composition and
cross-runtime restart contract.

## Extension is dependency injection, not a plugin catalog

There is no plugin namespace here and no hook registry. You extend the engine by
providing a `Layer`, and you replace a behavior by providing a different
implementation of the service, or a different constructor option, at the seam
that owns it. `NodeRuntime` is itself an instance of that: it is a composition
of the packages above, with the decisions a host actually has to make left as
options.
