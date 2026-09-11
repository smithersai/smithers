---
title: "Layer files"
description: "AGENT.ts, SANDBOX.ts, and TOOLS.ts are the three layers a flow inherits from its directory: how the nearest ancestor of each kind is resolved, what each one declares, and how the two budgets project onto the harness."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/create-app/docs/concepts/layers.md"
---

A flow declares what it is asked and what it must answer. It never declares the
model it runs on, how much compute it may burn, or which tools it can reach.
Those three come from layer files, and a flow inherits them from where it sits.

| File         | Export    | Constructor     | What it declares                                               |
| ------------ | --------- | --------------- | -------------------------------------------------------------- |
| `AGENT.ts`   | `Agent`   | `defineAgent`   | The seat, the teaching, the call limit, the frame limit        |
| `SANDBOX.ts` | `Sandbox` | `defineSandbox` | The QuickJS budget every cell runs under                       |
| `TOOLS.ts`   | `Tools`   | `defineTools`   | The flow bindings a cell may call, and the capability envelope |

## Nearest ancestor wins, and nothing merges

Each layer kind resolves independently to the nearest file of that kind at the
flow's own directory or any ancestor, up to and including the app root.

```text
AGENT.ts            <- flows/chat runs on this seat
SANDBOX.ts
TOOLS.ts
flows/
  chat/flow.ts
  build/
    AGENT.ts        <- flows/build and everything under it runs on this one
    flow.ts
    plan/flow.ts
```

`flows/build/AGENT.ts` moves the build flows to another seat and leaves their
sandbox and tools resolving to the root. Nothing merges: the closer file
replaces the further one whole, so the teaching in `flows/build/AGENT.ts` is
the entire teaching those flows get, not an addition to the root's.

The app root must provide all three. That requirement is what makes resolution
terminate, and a flow with no ancestor of some kind is refused with
`missing_layer`:

```text
no TOOLS.ts found for flows/chat or any ancestor; add one at the app root
```

Both the app root and the directory being resolved are normalized before the
ancestor walk, and the directory must sit inside the root.

## The agent layer

```ts
import { defineAgent } from "@smthrs/create-app/app"

export const Agent = defineAgent({
  seat: "anthropic:claude-sonnet-4-5",
  system: ["You answer questions about the ledger."],
  limits: { calls: 32 },
  maxFrames: 8
})
```

`seat` is a `<provider>:<model>` string a host's `SeatResolver` turns into a
live model. It carries no credential and no endpoint, which is why a flow file
can be read out of a repository without handing anything the keys. The
resolution seam is described in [Seats](https://agent.smithers.sh/concepts/seats/).

`system` is the teaching every flow under this layer opens with. A flow's own
`system` lines are appended after it, so the layer says what the app is and the
flow says what this task is.

`limits.calls` bounds the host calls one cell may make, and defaults to 16.
`maxFrames` bounds the agent frames one run may take, and defaults to 8.

## The sandbox layer

```ts
import { defineSandbox } from "@smthrs/create-app/app"

export const Sandbox = defineSandbox({
  limits: { heapBytes: 128 * 1024 * 1024, interruptChecks: 1000, wallClockMs: 30_000 }
})
```

The harness's own budget has six fields. Four are reachable from an app, and
three of them are named here:

| App field                                     | Harness field | What it bounds                            |
| --------------------------------------------- | ------------- | ----------------------------------------- |
| `heapBytes`                                   | `memoryBytes` | The QuickJS heap                          |
| `interruptChecks`                             | `steps`       | Interrupt checks, so a runaway loop ends  |
| `wallClockMs`                                 | `totalMs`     | The whole evaluation, host calls included |
| declared on the agent layer as `limits.calls` | `calls`       | Host calls per cell                       |

The split is deliberate. How many tools a step may reach for is a property of
the agent, and how much compute one cell may burn is a property of the sandbox.

The other two harness fields stay host-owned and have no author-facing name:
`timeMs` bounds one QuickJS evaluation and `callMs` bounds one host call, and a
host that embeds this runtime sets both from its own request deadline.

Every sandbox limit is optional, and an omitted one is not zero: the harness
fills it from its own defaults, which at rc.0 are 64 calls, 128 MiB, 1000
steps, 30 s `timeMs`, 900 s `totalMs`, and 120 s `callMs`. So
`defineSandbox({ limits: {} })` accepts every default rather than declaring no
budget.

## The tools layer

```ts
import { defineTools } from "@smthrs/create-app/app"
import { ledger } from "./tools/ledger.ts"

export const Tools = defineTools({ sources: [ledger] })
```

`sources` are flow-binding sources. A cell reaches one as
`ctx.call("<source>/<flow>", input)`, so a source named `ui` holding a flow
named `ui/pane` is called as `ui/pane`.

`grant` is the capability envelope every cell under this layer runs under.
`defineTools` defaults it to the empty envelope, `[]`, so a bound tool's
declared capability is refused until the layer grants it. Grant the patterns
the bound tools declare:

```ts
export const Tools = defineTools({
  sources: [ledger],
  grant: [{ action: "net:*", resource: "https://api.example.com/*" }]
})
```

`action` is [`@smthrs/capability`](https://capability.smithers.sh/reference/api/)'s closed `PatternAction`
union, so an action the kernel does not know is a compile error in the
`TOOLS.ts` that declares it rather than a runtime refusal. `resource` is a
string bounded at 4096 characters. A grant that breaks either rule is refused
with `LayerError` and the code `invalid_grant`, naming the index and the field.

`[{ action: "*", resource: "*" }]` grants every capability. Use it only for
trusted local use, where the app runs tools it owns on its own machine.

Without a grant, the harness refuses every call that declares a capability.
A hand-built `ToolsSpec` must state its envelope: the field is
required on the type and defaulted only by `defineTools`, so a spec assembled
by a host states its envelope rather than inheriting one silently.

## Where the layers are applied

`layerFor` in `@smthrs/create-app/runtime` composes the three into the services
one flow runs under, and `materializeFlow` pairs the flow with its agent layer.
Both are covered in
[Run a routed flow from your own host](/guides/host-a-turn/).
