---
title: "@smthrs/flows"
description: "The whole Smithers durable flow engine in one dependency: declare flows and actions, run them on a native host over SQLite or PostgreSQL, and resume them after a crash."
---

`@smthrs/flows` is one package that carries the whole durable flow engine
behind [Smithers](https://github.com/smithersai/smithers). It re-exports every engine
package under a single import, and it adds `Runtime`, the engine composed over
an injected SQL client and host. It imports no platform code, so it runs in a
browser and a Cloudflare Worker as well as on Node and Bun. A Node program runs
flows for real with [`@smthrs/platform-node`](../platform-node/docs/api.md):
`NodeRuntime` stands a durable engine up over local SQLite, and `SandboxedFlow`
runs a child flow's own code on a machine you provision.

## What it solves

A job that calls a model, spawns a build, or waits on a person cannot afford to
start over when the process dies. A Smithers flow records each step in a journal
as it completes, so a restart replays what already finished and resumes at the
first step that did not. Steps are declared as schemas rather than written as
calls, which is what lets the engine cache them, retry them, replay them, and
put one of them on another machine without the flow's author arranging any of
it.

The engine behind that is twenty packages, each with its own seam. Wiring
twenty dependencies by hand is the boring part of composing a host, so this
package collapses it: one dependency, one import, and one call that builds the
whole composition.

## Install

```bash
npm init -y && npm pkg set type=module
npm install @smthrs/platform-node@next @smthrs/flows@next effect
```

With pnpm 11, run `pnpm add @smthrs/platform-node@1.0.0-rc.18 @smthrs/flows@1.0.0-rc.18 effect` instead, then
`pnpm approve-builds esbuild`. pnpm 11 installs only versions at least 24 hours
old, so `@next` can resolve to a candidate more than one release behind.

Compensable steps, time-travel forks, and rewinds that restore a compensable
step's files also need
[jj](https://jj-vcs.github.io/jj/latest/install-and-setup/) 0.39.0 or later on
`PATH`; a host without it runs every other step. On macOS, `brew install jj`.
[Installation](./installation.md) covers the requirements, the import forms,
the packages Bun and the browser add, and when to depend on individual engine
packages instead.

Durable execution is tested on Node.js 22.19+ and Bun 1.4+; `engines` requires Node `>=22.19.0`. The API is
[Effect](https://effect.website) throughout: a flow declares its payload and
result as Effect schemas, an action's implementation is an `Effect`, and a host
is a `Layer` you provide. The example below is a complete Effect program, and
Effect's own documentation is where to start if those three names are new.

## Run a flow that survives a restart

This program declares one recorded step, runs it on a durable host, and prints
the result:

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
answers a completed one from the journal on disk. That is durability
in one line of behavior, and everything else here is built on it.

The [Quickstart](./quickstart.md) takes the same program further: it reads a
file through the guarded host, which means granting the one capability the body
needs and seeing what happens when you leave the grant out.

## Depend on one engine package instead

Reach for a single engine package instead of the barrel when you want a
narrower dependency: [`@smthrs/flow`](../flow/docs/api.md) declares flows and actions,
[`@smthrs/engine`](../engine/docs/api.md) executes them, and
[`@smthrs/sandbox`](../sandbox/docs/api.md) provisions machines. The barrel is a
packaging convenience, not a new layer of API, which is why nothing in it is
reachable only through it.

## Next steps

- [Installation](./installation.md): how to depend on the package, the Node and
  `effect` requirements, the import forms, and the platform packages you choose
  yourself.
- [Quickstart](./quickstart.md): one flow end to end on a real durable engine.
- [How Smithers Flows works](./concepts/how-it-works.md): the plan, the step
  key, reuse across runs, the record, rewind, and permissions.
- [Change a flow and keep the work](./guides/change-a-flow-and-keep-the-work.md):
  add or edit a step and rerun only what changed, and print the plan before
  anything runs.
- [Stand up a durable Node runtime](./guides/stand-up-a-node-runtime.md): the
  four `NodeRuntime` entry points in `@smthrs/platform-node`, and which one a
  given program should call.
- [Inspect the plan a body builds](../flow/docs/guides/inspect-the-plan.md):
  every step and edge a flow will run, read before any of it runs.
- [Diff two plans](../plan/docs/guides/diff-two-plans.md): compare the plans of
  two versions of a flow, and why node ids are positional.
- [Rewind a run to a frame](../time-travel/docs/guides/rewind-a-run.md): rewind
  a paused run and resume it, or fork a finished one.
- [Time travel quickstart](../time-travel/docs/quickstart.md): replay a run's
  journal into an answer without re-running anything.
- [Run a child flow in a sandbox](./guides/run-a-child-flow-in-a-sandbox.md):
  the tier where the child's own code executes on another machine, including
  one reached over SSH.
- [The aggregate surface](./concepts/aggregate-surface.md): why the authoring
  names are flat, the infrastructure packages are namespaces, and the platform
  bundles are absent.
- [API reference](./api.md): every public export.
- [Troubleshooting](./troubleshooting.md): every typed refusal these modules
  raise, and what to change.
