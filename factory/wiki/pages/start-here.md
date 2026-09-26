# Start here

Smithers is built from typed durable flows, a coding agent that calls flows, and a repository build graph. Find the layer that owns a behavior before changing it.

## Choose the owning layer

| Concern | Start here |
| --- | --- |
| Write a file flow | `Flow.make` from `@smthrs/flow` |
| Run flows on a durable Node host | `@smthrs/flows/NodeRuntime` |
| Run a model inside a flow | `@smthrs/agent` (`AgentAction` or `AgentSession`) |
| Declare build targets | `WORKSPACE.ts` and each `PACKAGE.ts`, using `@smthrs/targets` |

## Follow the durable path

A file flow lives at `flows/<name>/flow.ts` and default-exports `Flow.make` from `@smthrs/flow`; the tag matches its directory. `/flows` lists discovered flow descriptions without importing modules, and a flow invoked without required input opens a schema-driven form.

`NodeRuntime` is the Node host composition over the shared, injected durable runtime. Its `layerHost` provides the native host, guarded services, database and registered flows.

## Follow the agent path

The agent runs model-written JavaScript cells in a QuickJS sandbox. A cell's only authority is `ctx.call(flowName, input)`; every capability it reaches is an ordinary flow settling through a durable boundary. `AgentAction` runs the loop as one typed step inside a larger flow; `AgentSession` runs it as a whole control-plane launch.

## Follow the build path

`WORKSPACE.ts` declares the toolchain once and each `PACKAGE.ts` declares that package's targets. Target constructors are pure: they validate attributes and record inputs and dependencies without running anything, and `@smthrs/build-cli` runs the declarations. Declared input content digests are a target's key.

The coding pages continue from here: [configured host](coding-host.md), [request lifecycle](coding-request.md), [planning memory](coding-planning.md), [disposable prototype](coding-poc.md) and [owner correction](coding-correction.md). [Dependency-bound build targets](build-graph.md) explains how this wiki is built and checked.
