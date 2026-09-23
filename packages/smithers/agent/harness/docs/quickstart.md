---
title: "Quickstart"
description: "Run your first cells with @smthrs/harness: open a persistent QuickJS realm, evaluate two cells that share state, and read the frames they produce."
sidebar:
  order: 2
---

This quickstart runs two cells against one persistent realm: the first cell
calls a flow and prints, the second reads what the first bound and completes
the run. It uses the QuickJS-WASM binding directly, which is what one frame of
the agent loop does; driving the whole loop comes after.

## Before you start

Install the package as described in [Installation](./installation.md). You
need Node.js 26.4.0 or later.

## Write the program

A `Cell.FlowProjection` is the cell-visible half of a flow: the part
`ctx.flows` shows the model. Two of its fields come from the flow's registry
descriptor and are worth naming before you copy them. `tier` is how reversible
the call is, one of `sealed`, `compensable`, or `irreversible`. `placement` is
where the flow runs, one of `client`, `local`, `sandbox`, or `remote`, and
`Option.none()` means the flow pins none. Both are defined by
[`@smthrs/registry`](/api/registry). A real host builds projections with
`Cell.project(descriptor)`; this quickstart writes one by hand so the program
runs with nothing else composed.

Save this as `quickstart.ts`:

```ts
import * as Cell from "@smthrs/harness/Cell"
import * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"
import * as Sandbox from "@smthrs/harness/Sandbox"
import { Effect, Option } from "effect"

// The catalog the realm discloses to cells, as ctx.flows.
const flows = {
  echo: new Cell.FlowProjection({
    name: "echo",
    description: "The echo flow.",
    capabilities: [],
    tier: "sealed",
    placement: Option.none(),
    input: Option.none()
  })
}

// The host side of ctx.call: one invocation in, one settled result out.
const call: Sandbox.Handler = (invocation) =>
  Effect.succeed(new Cell.CallResult({ outcome: "success", value: { seen: invocation.input } }))

const firstCell = `
const found = await ctx.call("echo", { text: "hello" })
const greeting = found.seen.text + "!"
console.log(greeting)
`

const secondCell = `
ctx.done(greeting)
`

const program = Effect.gen(function*() {
  const sandbox = yield* QuickJSSandbox.make
  const realm = yield* sandbox.openRealm!({ flows })
  const first = yield* realm.evaluate({ cell: Cell.source(firstCell), frame: 0, call })
  const second = yield* realm.evaluate({ cell: Cell.source(secondCell), frame: 1, call })
  return { first, second }
})

const { first, second } = await Effect.runPromise(Effect.scoped(program))
console.log("first prints:", JSON.stringify(first.prints))
console.log("first outcome:", first.outcome._tag)
console.log("second outcome:", JSON.stringify(second.outcome))
```

## Run it

```bash
node quickstart.ts
```

Node 26.4 runs the TypeScript file directly. The output is:

```text
first prints: "hello!"
first outcome: settled
second outcome: {"_tag":"settled","transition":{"_tag":"complete","output":"hello!"}}
```

## What happened

- **The realm persisted.** `firstCell` bound `greeting` at the top level, and
  `secondCell` read it. One run holds one realm for its whole life, so names
  bound by one cell are still bound in the next.
- **`ctx.call` crossed to the host.** The cell's `ctx.call("echo", ...)` became
  a `Sandbox.Invocation` handed to your `Sandbox.Handler`, and its
  `Cell.CallResult` became the value the `await` resolved with. A result of
  `failure` resolves as `{ ok: false, error: { code, message, hint } }` instead
  of throwing, so a cell can branch on it.
- **Printing is the channel to the next turn.** `console.log(greeting)` landed
  in `first.prints`, already bounded. What a cell prints is what the next model
  turn reads.
- **The cell stated its intent by calling.** `secondCell` called `ctx.done`,
  and the frame's outcome is `settled` with a `complete` transition. A cell
  that calls neither `ctx.done` nor `ctx.park` continues: the first frame's
  outcome carries a `continue` transition.
- **Teardown is scope closure.** `Effect.scoped` closed the realm when the
  program ended. Cancellation is fiber interruption; nothing installs an abort
  signal.

## Next steps

- To run cells with limits, checkpoints, and a full tour of the `Sandbox`
  port, see [Run cells in a persistent realm](./guides/run-cells.md).
- To put real flows behind `ctx.call`, see
  [Expose flows to cells](./guides/bind-flows.md).
- To run the whole agent loop against a durable engine, see
  [Drive the cell loop](./guides/drive-the-loop.md).
- For the mental models, see [Concepts](./concepts.md).
