---
title: "API reference"
description: "Every public export of @smthrs/flows: the barrel's namespaces and flat authoring names, and the platform-neutral Runtime that the Node, Bun, browser and Cloudflare hosts compose."
---

`@smthrs/flows` has these public entry points.

| Entry point             | Contents                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| `@smthrs/flows`         | The barrel: twenty engine packages re-exported, plus `Runtime` and `namespaces`.                    |
| `@smthrs/flows/Runtime` | The same `Runtime` namespace: the engine and its stores over injected Effect SQL and host services. |

```ts
import { Action, Flow, Kernel, RunStore, Runtime } from "@smthrs/flows"
```

`@smthrs/flows/internal/*` and `@smthrs/flows/*/index` are blocked in the export
map and are not public.

The barrel imports no platform code, so it bundles for a browser and for a
Cloudflare Worker. A program picks its host from a platform package:

| Host              | Package                                                             | Runtime                   |
| ----------------- | ------------------------------------------------------------------- | ------------------------- |
| Node.js           | [`@smthrs/platform-node`](../platform-node/docs/api.md#noderuntime) | `NodeRuntime.layerHost`   |
| Bun               | [`@smthrs/platform-bun`](../platform-bun/docs/api.md#bunruntime)    | `BunRuntime.layerHost`    |
| Cloudflare Worker | [`@smthrs/platform-cloudflare`](../platform-cloudflare/docs/api.md) | `CloudflareRuntime.layer` |
| Browser tab       | [`@smthrs/platform-browser`](../platform-browser/docs/api.md)       | `BrowserRuntime.run`      |

Each of them composes [`Runtime`](#runtime) over its own SQL client and host
services. Durable execution on a native host is tested on Node.js 22.19+ and
Bun 1.4+; `engines` requires Node `>=22.19.0`.

## Example

```ts
import { Action, Flow, Interpreter } from "@smthrs/flows"
import { NodeRuntime } from "@smthrs/platform-node"
import { Effect, Layer, Schema } from "effect"
const Greet = Action.make("demo/Greet", { payload: { name: Schema.String }, success: Schema.String })
const Hello = Flow.make("demo/Hello", {
  payload: { name: Schema.String },
  success: Schema.String,
  body: (payload) => Greet.call(payload)
})
const code = Interpreter.layer(Hello).pipe(
  Layer.provideMerge(Greet.toLayer(({ name }) => Effect.succeed(`hi ${name}`))),
  Layer.provideMerge(Action.layerImplementations)
)
const host = NodeRuntime.layerHost(
  { filename: ".flows/engine.db", workspaceRoot: ".", owner: { hostId: "demo" } },
  code
)
console.log(
  await Effect.runPromise(
    Hello.execute({ name: "ada" }, { executionId: "demo-1" }).pipe(Effect.provide(host), Effect.scoped)
  )
)
```

## The barrel

### Namespace exports

Each engine package is re-exported as a namespace, so a package's own module is
one level below it (`Journal.SqlJournal.layer`).

| Namespace       | Package                                                 |
| --------------- | ------------------------------------------------------- |
| `Artifacts`     | [`@smthrs/artifacts`](../artifacts/docs/api.md)         |
| `Canonical`     | [`@smthrs/canonical`](../canonical/docs/api.md)         |
| `Capability`    | [`@smthrs/capability`](../capability/docs/api.md)       |
| `Crypto`        | [`@smthrs/crypto`](../crypto/docs/api.md)               |
| `Database`      | [`@smthrs/database`](../database/docs/api.md)           |
| `Engine`        | [`@smthrs/engine`](../engine/docs/api.md)               |
| `EngineStore`   | [`@smthrs/engine-store`](../engine-store/docs/api.md)   |
| `Jj`            | [`@smthrs/jj`](../jj/docs/api.md)                       |
| `Journal`       | [`@smthrs/journal`](../journal/docs/api.md)             |
| `Kernel`        | [`@smthrs/kernel`](../kernel/docs/api.md)               |
| `Keys`          | [`@smthrs/keys`](../keys/docs/api.md)                   |
| `Observability` | [`@smthrs/observability`](../observability/docs/api.md) |
| `Plan`          | [`@smthrs/plan`](../plan/docs/api.md)                   |
| `PlanStore`     | [`@smthrs/plan-store`](../plan-store/docs/api.md)       |
| `RunStore`      | [`@smthrs/run-store`](../run-store/docs/api.md)         |
| `Sandbox`       | [`@smthrs/sandbox`](../sandbox/docs/api.md)             |
| `StepCache`     | [`@smthrs/step-cache`](../step-cache/docs/api.md)       |
| `Sync`          | [`@smthrs/sync`](../sync/docs/api.md)                   |

Namespacing is what preserves constructors like
`Kernel.ChildProcessSpawner.layerNoop` and `RunStore.RunStore.layer`. The
`Capability` namespace owns exact-resource bounds, the pattern grammar, and
permission failures; `Plan` owns step identity, graph compilation, and static
effect declarations, with `PlanStore` holding the append-only rows they are
recorded in; `Journal` owns the append-only event record
every durable run replays from and the redaction rules that keep a credential
out of both a committed row and a log line.

### Flat exports

[`@smthrs/flow`](../flow/docs/api.md) is re-exported flat, so all of its namespaces sit at
the top level: `Action`, `Deadline`, `DurableClock`, `DurableDeferred`,
`DurableQueue`, `ExternalJob`, `Fault`, `Flow`, `FlowRuntime`, `Graph`,
`HumanTask`, `Interpreter`, `JournalDecode`, `Poll`, `RetryPolicy`, `RunMetrics`,
`Sleep`, `SpanFailure`, `Stall`, `StepIdentity`, and `WaitFor`.

`TimeTravel` from [`@smthrs/time-travel`](../time-travel/docs/api.md) is the second flat
export, and it is a service key rather than a namespace:

```ts
import { TimeTravel } from "@smthrs/flows"

const program = Effect.gen(function*() {
  const timeTravel = yield* TimeTravel
})
```

`TimeTravel.layer` provides it. The rest of that package, including `Frame`,
`TimeTravelStore`, and `EffectBoundary`, is reached through
`@smthrs/time-travel` directly.

`Runtime` is the barrel's own module. It is described [below](#runtime).

The `@smthrs/platform-*` bundles are deliberately absent, and with them every
native composition: `NodeRuntime`, `SandboxedFlow` and `TestNodeRuntime` live in
[`@smthrs/platform-node`](../platform-node/docs/api.md), and `BunRuntime` in
[`@smthrs/platform-bun`](../platform-bun/docs/api.md). A program chooses
those, [`@smthrs/platform-browser`](../platform-browser/docs/api.md), or
[`@smthrs/platform-cloudflare`](../platform-cloudflare/docs/api.md) directly.

### `namespaces`

```ts
const namespaces: ReadonlyArray<string>
```

The sorted list of every name this barrel exports, covering both the per-package
namespaces and the flat authoring names. It is the package's one runtime value,
and it names the whole engine: enumerate it to build a documentation index or a
conformance check over the surface you depend on.

## Runtime

```ts
import { Runtime } from "@smthrs/flows"
```

The durable engine and its stores over an injected SQL client and injected host
services. It opens no driver and names no file, so it runs wherever its host can
supply those services, a Worker included. `NodeRuntime` in
`@smthrs/platform-node` and `BunRuntime` in `@smthrs/platform-bun` are this
composition bound to their native hosts.

The host supplies, as layer requirements:

- `SqlClient`, the database the stores migrate and use;
- Effect's `Crypto` and the kernel `Jj`;
- `OwnerIdentity` from [`@smthrs/engine-store`](../engine-store/docs/api.md#owneridentity),
  the incarnation the engine fences its writes with;
- whatever the `stepBoundary` and `workspaceSandbox` layers it passes need. The
  filesystem layers need `FileSystem`, `Path`, an `ArtifactStore`, and the kernel
  `Workspace`; `StepBoundary.layerUnsupported` and
  `WorkspaceSandbox.layerUnsupported` need nothing.

A host without a filesystem therefore composes the runtime from its SQL client,
`Crypto`, a refusing `Jj`, `OwnerIdentity.layerWithoutPid`, and the two
unsupported layers, and a step that declares a file boundary fails its attempt
there instead of running.

### `Options`

`owner`, `isAlive`, `canExecute`, `canActivate`, `requestResume`,
`cacheEnvironment`, `sourceRevision`, `privilegedJj`, `sweep`,
`resumeConcurrency`, and `placement`. The
[`NodeRuntime` options table](../platform-node/docs/api.md#options) describes
each field. `sweep` is `"process"` by default; `{ host: executionId }` is for a
host that drives one execution per invocation and wakes it from outside. It runs
no sweep fiber and renews no lease. The host drives the execution with
`EngineStore.drive`, which the runtime's context provides, and arms its next
invocation from the result; see
[hosted executions](../engine-store/docs/api.md#hosted-executions).
`resumeConcurrency`, a positive integer, bounds how many runs the engine resumes
on its own at once, such as the runs a restarted host finds unfinished; a run a
caller starts or awaits never waits for them. Absent is no bound; see
[the resume lane](../engine-store/docs/api.md#resume-lane). Invalid
input throws [`RuntimeConfigurationError`](#runtimeconfigurationerror) naming the
field. The native hosts take `NativeRuntime.Options` from
`@smthrs/platform-node`, which adds `filename` and `workspaceRoot`.

### `storage`

```ts
const storage: Layer<Journal | RunStore | AttemptStore | CacheStore | DurableEngineState | DurableWriter, ..., SqlClient>
```

The migrated stores over the injected `SqlClient`, without an engine: the
journal (capacity 1,024, `overflow: "reject"`), `RunStore`, `AttemptStore`,
`CacheStore`, and `DurableEngineState`, with the `DurableWriter` they share.
Every use builds its own instances, so two runtimes over two databases in one
program never share a store.

### `layer` and `make`

```ts
const layer: (
  options: Options,
  stepBoundary: Layer<StepBoundary.Service, E1, R1>,
  workspaceSandbox: Layer<WorkspaceSandbox.Service, E2, R2>,
  registerFlows: Layer<A, E3, R3>,
  registry?: Layer<A4, E4, R4>
) => Layer<..., ..., SqlClient | Crypto | Jj | OwnerIdentity | R1 | R2 | ...>
const make: (/* the same */) => Effect<Context<...>, ..., ... | Scope>
```

Construction is ordered by layer dependency: migrations, then the stores, then
the engine, then `registerFlows`. A persisted run therefore cannot resume
through a composition before its flow has been registered. `make` builds the
context in the caller's scope.

```ts
import { OwnerIdentity, StepBoundary, WorkspaceSandbox } from "@smthrs/engine-store"
import { Runtime } from "@smthrs/flows"
import { Layer } from "effect"

const runtime = Runtime.layer(
  { owner: { hostId: "answer-host" }, isAlive, sweep: { host: executionId } },
  StepBoundary.layerUnsupported,
  WorkspaceSandbox.layerUnsupported,
  registerFlows
).pipe(Layer.provide(OwnerIdentity.layerWithoutPid), Layer.provide(host))
```

### `RuntimeConfigurationError`

```ts
class RuntimeConfigurationError extends Schema.TaggedError("@smthrs/flows/RuntimeConfigurationError")({
  code: "invalid_runtime_configuration"
  field: string
  message: string
})
```

Thrown synchronously by `layer`, `make`, and every host composition over them,
including `NodeRuntime` and `BunRuntime`, for invalid construction input.
`field` names the single option that was wrong, so an embedder can distinguish
an empty `filename` from an empty `owner.hostId` without parsing the message.
Nothing is created before it is thrown: no database is opened and no signal
listener is installed.

### `validate` and `decodeField`

```ts
const validate: (options: Options, label?: string) => Options
const decodeField: <A>(field: string, schema: Schema.Codec<A>, value: unknown, expectation: string, label?: string) => A
```

For a host package that composes the engine itself. `validate` captures
`options` as one frozen record, the same check `layer` runs, and throws
`RuntimeConfigurationError` naming the first option that is wrong. `decodeField`
decodes one option the host adds, such as a database filename, and throws the
same error for that field. `label`, `"Runtime"` by default, leads each message,
so `NativeRuntime` reports `NodeRuntime filename must be a non-empty string`.

### `RegistryArgs` and `registryLayer`

```ts
type RegistryArgs<A, E, R> = [registry: Layer<A, E, R>] | [registry?: undefined]
const registryLayer: <A, E, R>(args: RegistryArgs<A, E, R>) => Layer<A, E, R>
```

The optional trailing registry argument of `layer` and `make`, and the layer it
names. The empty branch type-checks only when all three registry types are
`never`, so a declared registry cannot be dropped by passing type arguments.
`registryLayer` answers an empty layer for an omitted registry. A host that
takes the same trailing argument, such as `NativeRuntime.layerHost`, uses both.

## See also

Each namespace in the table above has its own API reference, reached through the
links there. Depend on
individual `@smthrs` packages rather than this barrel when a smaller dependency
surface is worth the extra imports. The native compositions are in the
[`@smthrs/platform-node`](../platform-node/docs/api.md) and
[`@smthrs/platform-bun`](../platform-bun/docs/api.md) API references.
