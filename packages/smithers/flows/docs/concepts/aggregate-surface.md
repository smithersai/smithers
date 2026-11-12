---
title: "The aggregate surface"
description: "Why @smthrs/flows re-exports the authoring model flat and every infrastructure package as a namespace, why the platform bundles are deliberately absent, and what the browser-safe root does and does not promise."
sidebar:
  order: 1
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

[`@smthrs/flow`](../../flow/docs/api.md) is the one package re-exported flat. All of its namespaces,
`Action`, `Deadline`, `DurableClock`, `DurableDeferred`, `DurableQueue`,
`ExternalJob`, `Fault`, `Flow`, `FlowRuntime`, `Graph`, `HumanTask`,
`Interpreter`, `JournalDecode`, `Poll`, `RetryPolicy`, `RunMetrics`, `Sleep`,
`SpanFailure`, `Stall`, `StepIdentity`, and `WaitFor`, sit at the top level
beside the infrastructure namespaces.

Writing a flow is the point of the library, and `Flows.Flow.Flow.make` would be
noise. `Interpreter` belongs to that set because a host composition needs it:
the registration layer `Runtime.layer` and every host's `layerHost` take is
built from `Interpreter.layer(flow)`.

[`@smthrs/time-travel`](../../time-travel/docs/api.md) contributes the second flat name for a
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

`@smthrs/platform-node`, `@smthrs/platform-bun`, `@smthrs/platform-browser`,
and `@smthrs/platform-cloudflare` are not re-exported, for the same reason
`effect`'s index does not re-export `@effect/platform-node`: a platform bundle is
chosen by the program that runs, not by the library it depends on. Pulling them
in would make one import resolve `node:child_process`, ZenFS, and Bun at once.
The native compositions live there too: `NodeRuntime`, `SandboxedFlow` and
`TestNodeRuntime` in `@smthrs/platform-node`, and `BunRuntime` in
`@smthrs/platform-bun`.

The same rule holds one level down. Platform implementations never appear
through the namespaces either: reach `@smthrs/testing/TestHost`,
`@smthrs/database/node/NodeDatabase`, and `@smthrs/journal/test/TestJournal`
through their own packages.

## Bundling for a browser is not durable execution

The root entry point bundles for a browser and a Cloudflare Worker, and so does
every package root it re-exports. What that buys is the engine with no host:
declaring flows, reading a plan, decoding a journal event, and the `Runtime` a
host composes.

Durable execution on Node or Bun uses local SQLite or PostgreSQL through
`NodeRuntime` from `@smthrs/platform-node` or `BunRuntime` from
`@smthrs/platform-bun`. The shared `Runtime` consumes injected Effect services;
selecting another SQL client does not by itself establish browser or edge
support. Native compositions live in the platform packages, so importing
`@smthrs/flows` never opens a native driver.
See [runtime portability](./runtime-portability.md) for the composition and
cross-runtime restart contract.

## Extension is dependency injection, not a plugin catalog

There is no plugin namespace here and no hook registry. You extend the engine by
providing a `Layer`, and you replace a behavior by providing a different
implementation of the service, or a different constructor option, at the seam
that owns it. `Runtime` is itself an instance of that: it is a composition of
the packages above, with the decisions a host actually has to make left as
options, and `NodeRuntime` in `@smthrs/platform-node` is `Runtime` with Node's
answers to them.
