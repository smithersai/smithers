# @smthrs/flows

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact `4.1.1` peer dependency. Install one
`effect` release at that version so all Smithers packages share one Effect
runtime.

**Documentation:** https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/docs

The whole [Smithers](https://github.com/smithersai/smithers) durable flow engine in one dependency.
It re-exports every engine package under a single import, and it adds `Runtime`,
the engine composed over an injected SQL client and host. It imports no
platform code, so it runs in a browser and a Cloudflare Worker as well as on
Node and Bun. A Node program runs flows for real with `@smthrs/platform-node`:
`NodeRuntime` stands a durable engine up over SQLite or PostgreSQL, and
`SandboxedFlow` runs a child flow's own code on a machine you provision.

A flow records each step in a journal as it completes, so a process that dies
mid-flight replays what already finished and resumes at the first step that did
not.

## Install

```bash
npm init -y && npm pkg set type=module
npm install @smthrs/platform-node@next @smthrs/flows@next effect
```

With pnpm 11, run `pnpm add @smthrs/platform-node@1.0.0-rc.18 @smthrs/flows@1.0.0-rc.18 effect` instead, then
`pnpm approve-builds esbuild`. pnpm 11 installs only versions at least 24 hours
old, so `@next` can resolve to a candidate more than one release behind.

A Node program needs Node.js 22.19.0 or later.

A compensable step, a time-travel fork, a rewind that crosses a compensable
step or sets `wholeRepo`, and a step that calls `Jj` also need
[jj](https://jj-vcs.github.io/jj/latest/install-and-setup/) 0.39.0 or later on
`PATH`, or `SMITHERS_JJ_PATH` naming the binary. A compensable step's workspace
must also be a jj repository: run `jj git init` in it, or the step fails with
`jj snapshot: Error: There is no jj repo in "."`. A host without jj starts and
runs every other step, including a rewind over sealed steps; a step that needs
jj fails with `No jj on PATH`. On macOS, `brew install jj`; the linked page
covers Linux and Windows.

`npm pkg set type=module` makes the project an ES module, so `node` runs the
example below, which ends in a top-level `await`, without a warning.
[Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/docs/installation.md)
covers the `effect` range, the import forms, and the packages Bun and the
browser add. The
[Quickstart](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/docs/quickstart.md)
runs a flow end to end from an empty directory.

## A flow that survives a restart

This program declares one recorded step, runs it on a durable host, and prints
the result.

```ts
import { Action, Flow, Interpreter } from "@smthrs/flows"
import { NodeRuntime } from "@smthrs/platform-node"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

/** A step declaration is data: a name and the schemas either side of it. */
const FetchReadme = Action.make("demo/FetchReadme", {
  payload: { repo: Schema.String },
  success: Schema.Number
})

/** A flow is a plan over declarations, compiled before any of it runs. */
const CountBytes = Flow.make("demo/CountBytes", {
  payload: { repo: Schema.String },
  success: Schema.Number,
  body: (payload) => FetchReadme.call(payload)
})

/** The code arrives as a layer, separately from the declaration. */
const registerFlows = Interpreter.layer(CountBytes).pipe(
  Layer.provideMerge(
    FetchReadme.toLayer(({ repo }) =>
      Effect.promise(async () => {
        const response = await fetch(`https://raw.githubusercontent.com/${repo}/HEAD/README.md`)
        if (!response.ok) throw new Error(`GET README: HTTP ${response.status}`)
        return (await response.arrayBuffer()).byteLength
      })
    )
  ),
  Layer.provideMerge(Action.layerImplementations)
)

/** One call builds the database, the journal, the guarded host, and the engine. */
const host = NodeRuntime.layerHost(
  { filename: ".flows/engine.db", workspaceRoot: ".", owner: { hostId: "demo" } },
  registerFlows
)

const main = CountBytes.execute({ repo: "smithersai/smithers" }, { executionId: "demo-1" })
  .pipe(Effect.provide(host), Effect.scoped)

console.log(await Effect.runPromise(main))
```

Run it once and it downloads the repository's README from GitHub and prints its
size in bytes. Run it a second time, unchanged, and it prints the same number
without calling GitHub: `executionId` names one execution, and the engine
answers a completed one from the journal on disk.

## What the barrel exports

[`@smthrs/flow`](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/flow/docs/README.md) is re-exported flat, so `Action`,
`DurableClock`, `DurableDeferred`, `DurableQueue`, `Flow`, `FlowRuntime`,
`Graph`, `HumanTask`, `Interpreter`, `Poll`, `RetryPolicy`, `Sleep`,
`StepIdentity`, and `WaitFor` sit at the top level. Writing a flow is the point
of the library, and `Flows.Flow.Flow.make` would be noise.

Every other engine package is a namespace, the way `effect`'s own index does
it, so `Kernel.ChildProcessSpawner.layerNoop` and `RunStore.RunStore.layer`
still read as themselves rather than collapsing into one shared namespace.
`namespaces` is the sorted runtime list of every name the barrel exports, and
the [API reference](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/docs/api.md) has the full
table. Depend on an individual engine package instead when a narrower
dependency surface is worth the extra imports. Install it at `@next`, the tag
that carries the 1.0 release candidates (`npm install @smthrs/engine@next`);
`latest` on several engine packages still names a 0.x release.

The `@smthrs/platform-*` bundles are deliberately absent, for the same reason
`effect`'s index does not re-export `@effect/platform-node`: a platform bundle
is chosen by the program that runs, not by the library it depends on. Platform
implementations and test doubles are imported from their own packages, among
them `@smthrs/platform-node` (with `NodeRuntime`), `@smthrs/platform-bun` (with
`BunRuntime`), `@smthrs/testing/TestHost`,
`@smthrs/database/node/NodeDatabase`, and `@smthrs/journal/test/TestJournal`.
Install those at `@next` too, for example
`npm install --save-dev @smthrs/testing@next`.

## Bundling is not durable execution

The root entry point bundles for a browser and a Cloudflare Worker, and so does
every package root it re-exports. What bundles is the engine with no host:
declaring flows, reading a plan, decoding a journal event, and `Runtime` for a
host to compose.
[Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/docs/installation.md#bundling-for-a-browser-is-not-durable-execution)
names which entry points carry that guarantee, and
[`@smthrs/platform-browser`](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-browser/docs/README.md) is the host a
tab runs them on.

[RC support matrix](https://github.com/smithersai/smithers/blob/main/apps/site/docs/reference/support-matrix.md) lists runtime evidence limits.

Durable execution is provided by the host packages: the Node and Bun
compositions in `@smthrs/platform-node` and `@smthrs/platform-bun` over SQLite
or PostgreSQL, `@smthrs/platform-browser` over SQLite on OPFS in a tab's
dedicated worker, and `@smthrs/platform-cloudflare` with one Durable Object per
execution. See [database configuration](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/database/docs/concepts/sqlite-only.md)
for selection, schema identity, and transaction guarantees.
The shared engine consumes injected Effect services. Importing the root into a
browser or a Worker gives authoring and inspection only; durable execution there
comes from composing the matching host package. Native drivers
live in the platform packages so the root does not import `node:sqlite` or `bun:sqlite`.
See [runtime portability](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/docs/concepts/runtime-portability.md) for the contract.
[`NativeRuntimeParity.test.ts`](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/platform-bun/test/NativeRuntimeParity.test.ts)
is the native cross-runtime restart regression.

## The Node runtime

`NodeRuntime`, from `@smthrs/platform-node`, is the module a host program calls
to stand a durable engine up. `layerHost` decides the whole composition;
`layer`, `make`, and `storage` hand progressively more of it back to the caller.

The driver-neutral root imports no platform adapter. `@smthrs/platform-node`
installs `@smthrs/flows` and the SQLite driver `@effect/sql-sqlite-node`, so the
import needs nothing more.

```ts
import { NodeRuntime } from "@smthrs/platform-node"

const runtime = NodeRuntime.layerHost(
  {
    filename: ".flows/engine.db",
    workspaceRoot: ".",
    owner: { hostId: "local-worker" }
  },
  registerFlows
)
```

That call adds the contained Node host, the kernel's guarded host surface over
an unattended grant store, the default step boundary and workspace sandbox, a
process-table liveness probe, and signal handling that releases every run the
host owns before it shuts down.
[Stand up a durable Node runtime](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/docs/guides/stand-up-a-node-runtime.md)
compares the four entry points and says which one a given program should call.

## Documentation

The docs are the [`docs/`](https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/docs) folder of this package.

- [Quickstart](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/docs/quickstart.md): one flow end to end on a
  real durable engine, including the capability its body needs.
- [The aggregate surface](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/docs/concepts/aggregate-surface.md):
  why the authoring names are flat, the infrastructure packages are namespaces,
  and the platform bundles are absent.
- [Run a child flow in a sandbox](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/docs/guides/run-a-child-flow-in-a-sandbox.md):
  the tier where the child's own code executes on another machine.
- [API reference](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/docs/api.md): every public
  export, with the options each entry point takes.
- [Troubleshooting](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/docs/troubleshooting.md): every typed
  refusal these modules raise, and what to change.

## Runtime portability is a required contract

The engine and product flows are platform-independent Effect programs. Node and Bun
provide different SQL and host layers to the same runtime, migrations, journal,
stores, cache, and recovery logic. A Node subprocess is not a Bun compatibility
mechanism. Keep filesystem, process, crypto, HTTP and SQL access behind their
existing Effect services, selected at the executable's composition root.

`Runtime` consumes an injected Effect `SqlClient` and host services.
`NodeRuntime` from `@smthrs/platform-node` and `BunRuntime` from
`@smthrs/platform-bun` select matching native services. Database adapters are `@smthrs/database/node/NodeDatabase` and
`@smthrs/database/bun/BunDatabase`; both share the schema guard, startup retry
policy and `DurableWriter`. Domain code must not open an extra database or create
its own command, job, event, or locking ledger around the durable engine.

Runtime parity must be demonstrated by the same execute, persist, restart, resume
and cancellation scenarios, including opening a Node-created database in Bun and
vice versa. A browser-safe import alone does not make execution durable; the host package does.

For a Bun executable, also install `@smthrs/platform-bun`;
[Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/docs/installation.md#bun-durable-execution)
has the line.

Then use `BunRuntime.layerHost` from `@smthrs/platform-bun` with the same options
and registered flows.
