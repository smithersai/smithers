---
title: "Discover flows from a registry"
description: "Pass a registry layer to NodeRuntime so the registration phase reads a discovered catalog instead of a hand-written list of flows, and understand the build order that makes it work."
sidebar:
  order: 3
---

A host that names its flows in code has to be edited every time a flow is
added. The optional final argument is a registry layer whose catalog the
registration phase reads from: third for `layerHost`, fifth for `make` and
`layer`.

## Pass the project registry

[`@smthrs/registry`](/api/registry) discovers a project's flows from
`<root>/flows/**` and the installed packs. `Registry.layerProject` builds that
registry; `Executable.layer` is the registration that turns every discovered
descriptor into a registered durable flow.

```ts
import { Action } from "@smthrs/flows"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import * as Layer from "effect/Layer"

const registration = Executable.layer({ delegates: [Agent, Shell] }).pipe(
  Layer.provideMerge(Action.layerImplementations)
)

const host = NodeRuntime.layerHost(
  {
    filename: ".flows/engine.db",
    workspaceRoot: root,
    owner: { hostId: "local-worker" }
  },
  registration,
  Registry.layerProject({ root })
)
```

`delegates` is the list of flows a descriptor may delegate to. Building them,
and the rest of the discovery model, belongs to that package:
[run a discovered flow](/pkg/registry/guides/run-a-discovered-flow).

The lower-level constructors take the boundary and sandbox layers before
registration and the registry:

```ts
const engine = NodeRuntime.layer(
  options,
  stepBoundary,
  workspaceSandbox,
  registration,
  Registry.layerProject({ root })
)
```

`NodeRuntime.make` takes the same five arguments and returns an `Effect`.
Omit the registry argument and the registration phase runs with no catalog: your
flows are whatever `Interpreter.layer` calls you wrote by hand.

## The build order is the whole contract

The registry is built between the engine and the registration phase. That single
ordering claim is why the argument exists:

1. Storage, the kernel, and the engine build first.
2. The registry builds next, on the host the engine already stood up.
3. Registration runs last, with both the catalog and the live engine resolvable.

So a registration layer can read a catalog off the registry and register every
flow in it, and no persisted run can resume through the composition before that
finishes.

## The registry argument is an overload, not a default

`layer`, `make`, and `layerHost` each carry two signatures rather than one
signature with a defaulted registry parameter. A default cannot honor a
caller-chosen registry type: the call below would compile, and the layer it
returned would claim to provide `MyCatalog` while providing nothing.

```ts
// Does not compile: the registry-typed overload requires the registry layer.
NodeRuntime.layerHost<never, never, never, MyCatalog, never, never>(options, registerFlows)
```

With overloads the registry type parameters exist only on the signature that
also takes the argument, so the mismatch cannot be spelled. Without them it
would surface much later, as a service-not-found defect when the layer builds.

## Refusals are logged, not silent

`Executable.layer` logs a warning for every discovered flow it cannot run on
this host, naming the flow, the failure code, the delegate it wanted, and what
is registered instead. It also provides the whole catalog as a service, so your
host can print the refusals at startup rather than letting an operator discover
them when a launch fails inside the runtime.

A project with no `flows/` directory is not a failure. It has no flows yet,
which is the state [`smthrs init`](/cli/init) leaves behind.
