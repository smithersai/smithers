---
title: "Run cells in a persistent realm"
description: "How to evaluate agent-authored JavaScript cells behind the Sandbox port: the QuickJS binding, realm evaluation, handlers, limits, prints, and checkpoints."
sidebar:
  order: 1
---

A cell is arbitrary agent-authored JavaScript, so it never runs in the host
realm. It runs behind the `Sandbox` port, which grants exactly one effectful
primitive, flow invocation, and returns a serializable `Cell.Outcome`. This
guide runs cells against the shipped QuickJS-WASM binding.

## Provide the QuickJS binding

`QuickJSSandbox` is imported from its own subpath, not from the root barrel,
because it carries an embedded WebAssembly build:

```ts
import * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"
```

Two ways to get a `Sandbox`:

- `QuickJSSandbox.make` is an `Effect<Sandbox.Sandbox, Sandbox.SandboxError>`.
- `QuickJSSandbox.layer` is a `Layer<Sandbox.Sandbox, Sandbox.SandboxError>`
  for providing the `Sandbox.Sandbox` service to a larger program.

Both compile the single-file build from bytes, which is what Node and a
browser want. A runtime that forbids that, such as workerd, names its build
instead; see [Run on Cloudflare workerd](./workerd.md).

## Open the realm

A run holds one realm for its whole life. Open it with the flow catalog the
cells may see and the ceilings the realm enforces:

```ts
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const sandbox = yield* QuickJSSandbox.make
  const realm = yield* sandbox.openRealm!({ flows, limits: undefined })
  // ... evaluate every cell of the run against this realm
})
```

`openRealm` is optional on the `Sandbox` interface because it is the whole
surface: there is no per-cell evaluation beside it. The QuickJS binding is the
one shipped binding that offers it. A composition that offers none is refused
with `Sandbox.realmUnsupported`, an error the controller reports at the run's
open rather than mid-frame. The realm is scoped: teardown is scope
finalization, so wrap the program in `Effect.scoped`.

`flows` is a `Record<string, Cell.FlowProjection>`. The realm freezes it into
`ctx.flows`, which is all the cell can read about what it may call.
`Cell.project` derives a projection from a registry descriptor.

## Evaluate a cell

Cells are global async scripts in a persistent realm. Top-level `await` is
supported; top-level `return` is invalid. `Cell.extract` joins distinct fenced
cell blocks in reply order into one script. The first `ctx.done` or `ctx.park`
that records an intent seals the frame; later calls to either do nothing.
Ordinary JavaScript continues, including code in later blocks. Later
`ctx.call` and `ctx.checkpoint` calls resolve with a `run_completed` failure
envelope without dispatching host work.

```ts
const frame = yield * realm.evaluate({
  cell: Cell.source(text),
  frame: 0,
  call: handler
})
```

`frame` names the evaluation for the realm's own stack traces, so a throw in
frame 7 says which cell threw. The returned `Sandbox.RealmFrame` carries:

- `outcome`: the `Cell.Outcome` the evaluation settled with.
- `prints`: what the cell printed, already bounded; empty when it printed
  nothing.
- `bindings`: every name the realm holds after the cell ran, as cheap
  `VariablesPanel.Binding` facts (name, type, one cheap size). Nothing is
  serialized whole.

The evaluation options are `Sandbox.RealmEvaluation`:

| Field     | Purpose                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `cell`    | The `Cell.Source` to run; construct it with `Cell.source(text)`.                                                                |
| `frame`   | The controller frame number.                                                                                                    |
| `call`    | The `Sandbox.Handler` that resolves the cell's flow calls.                                                                      |
| `program` | Optional program the controller's own parse compiled from `cell`. A binding runs it verbatim instead of parsing the cell again. |
| `flows`   | Optional replacement for the frozen `ctx.flows` catalog before this cell runs. Omit to retain the current catalog.              |
| `mint`    | Optional `Sandbox.Minter` that settles `ctx.checkpoint()`. Absent means the run pins no trees.                                  |
| `bounded` | Set when the caller journals and bounds each settlement itself, so the loop adds no `callMs` clock of its own.                  |
| `limits`  | Per-frame `Sandbox.EvaluationLimits` overrides; `memoryBytes` is set only when opening the realm.                               |

References retained by earlier cells keep their old frozen catalog snapshots.

## Write the handler

`Sandbox.Handler` receives one `Sandbox.Invocation` and returns one
`Cell.CallResult`:

```ts
import * as Cell from "@smthrs/harness/Cell"
import * as Sandbox from "@smthrs/harness/Sandbox"
import { Effect } from "effect"

const handler: Sandbox.Handler = (invocation) =>
  Effect.succeed(new Cell.CallResult({ outcome: "success", value: { seen: invocation.input } }))
```

An invocation carries `ordinal` (the zero-based execution order of the call
within the cell, which is the replay anchor), `flow`, `input`, and an optional
undecoded `at` for whatever the cell passed as the call's checkpoint option.

The failure split is the contract `EngineLike.call` declares:

- A refusal the cell could plausibly correct is a `failure` `CallResult`. The
  cell observes it as a resolved value, `{ ok: false, error: { code, message,
  hint } }`, and its recovery branch still runs.
- Anything the cell must never swallow, a permission park, an abort, an
  engine failure, travels in the effect's error channel and tears the cell
  down.

Ordinary failures do not throw. Check `.ok === false`, then `.error.code` to
choose a recovery. Success resolves with the flow's own value, unwrapped.
For a flow whose successful result has a `stdout` field:

```ts
let result = await ctx.call("bash", { command: "find . -name '*.ts'" })
if (result.ok === false && result.error.code === "timeout") {
  result = await ctx.call("bash", { command: "find src -name '*.ts'" })
}
console.log(result.ok === false ? result.error.code : result.stdout)
```

QuickJS closes host-call admission before running teardown jobs. Calls and
checkpoints attempted by cleanup code are rejected without queuing another
host operation. Teardown runs at most 1,024 promise jobs before releasing the
frame handles, so asynchronous cleanup is not guaranteed to finish.

## Read the outcome

One evaluation settles with one of three `Cell.Outcome` members:

| Tag        | Meaning                                                                                                                                                                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settled`  | The cell ran and produced a well-formed transition: `continue` when it called neither `ctx.done` nor `ctx.park`, `complete` for `ctx.done(output)`, `park` for `ctx.park(reason, message)`.                                              |
| `raised`   | The cell ran and threw. The thrown value is projected into stable `name` and `message` text.                                                                                                                                             |
| `rejected` | The cell never ran, or produced no transition. The `code` is a `Cell.RejectionCode`: `no_cell`, `output_truncated`, `imports_forbidden`, `compile_failed`, `invalid_transition`, `unsupported_language`, `limit_exceeded`, or `stalled`. |

A provider `length` stop or an unterminated cell fence rejects the entire reply
as `output_truncated`. No earlier block executes; the next request asks for a
shorter, complete program.

`ctx.done` and `ctx.park` take effect where they are called: the run is over
at that line, and a later `ctx.call` in the same cell resolves
`{ ok: false, error: { code: "run_completed" } }` without running. The latch
is per frame: the host clears it as the next frame opens.

## Bound the evaluation

`Sandbox.defaultLimits` fills omitted ceilings when the realm opens.
`RealmEvaluation.limits` overrides `calls`, `steps`, `timeMs`, `totalMs`, and
`callMs` for one frame. Omitted or `undefined` fields inherit the opening
limits; overrides may tighten or raise them and do not change later frames.
The merged limits are validated before the cell runs. Invalid values fail
with `SandboxError` code `unsupported` without invoking a handler.
`memoryBytes` belongs to `RealmOptions.limits` and stays fixed for the run.

```ts
const frame = yield * realm.evaluate({
  cell: Cell.source(text),
  frame: 0,
  call: handler,
  limits: { calls: 0 } // This frame cannot dispatch a flow call or checkpoint.
})
```

The defaults are:

| Limit         | Default | Scope                                                                                                      |
| ------------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| `calls`       | 64      | Per frame. A `ctx.checkpoint()` mint counts.                                                               |
| `memoryBytes` | 128 MiB | Per run, weighed by the panel probe at each frame's close.                                                 |
| `steps`       | 1,000   | Per frame; interrupt checks, not bytecode operations.                                                      |
| `timeMs`      | 30,000  | Per frame; the cell's own JavaScript time, excluding time suspended in a `ctx.call` or `ctx.checkpoint()`. |
| `totalMs`     | 900,000 | Per frame; whole-evaluation time, host calls included.                                                     |
| `callMs`      | 120,000 | Per call; settles an overrunning call as a resolved `timeout`.                                             |

`steps` and `timeMs` have typed floors (`Sandbox.minimumSteps`,
`Sandbox.minimumTimeMs`), and `memoryBytes` has `Sandbox.minimumMemoryBytes`:
a budget of zero interrupts the binding's own scaffolding rather than the
cell, so the boundary refuses it as `unsupported`. `memoryBytes` is a run
budget because the realm outlives its frames; a frame that opens over the
ceiling is refused before it runs and told which names to free. For the full
semantics, see the [limits reference](../api.md#limits). A flow result larger
than the heap still available is not copied into the realm: the frame records a
`limit_exceeded` rejection with `reason: "heap"` instead.

Flow-result heap checks conservatively include value and property storage plus
bridge scratch space, not just serialized JSON bytes. A reply can be refused
when its estimated allocation exceeds the remaining heap.

Bridge replies are also limited to 128 levels of JSON nesting so a refusal can
release partial handles safely. Exceeding this limit produces a typed
`limit_exceeded` frame.

## Print to the next turn

`console.log`, `info`, `warn`, and `error` all write to the frame's print
buffer. A string prints as itself; anything else prints as canonical JSON, so
a structured value reaches the next model turn as the value it is rather than
as `[object Object]`. A value JSON cannot walk, a cycle above all, is named
with its kind and the reason instead.

Three constants bound the channel:

- `Sandbox.printFrameBytes` (16 KiB): what one frame's whole buffer delivers.
  Statements share it, and every elision is from the middle with the dropped
  byte count stated.
- `Sandbox.printStatementFloor` (512 bytes): the smallest share one statement
  is given before whole statements drop from the middle instead.
- `Sandbox.printRetainedBytes` (256 KiB): what the host keeps while the cell
  still runs. Past it, payloads are not read, and the count of what went
  unread is stated in the buffer.

## Pin a checkpoint

A cell calls `ctx.checkpoint()` to pin the workspace as it stands at that
line, and passes the handle as `{ at }` on a later `ctx.call` to run the call
against the pinned tree. `ctx.base` is the always-present handle naming the
tree the run opened on. The host settles a mint through the `Sandbox.Minter`
it wired into the evaluation; `Sandbox.mintUnavailable` is the refusal a
binding answers with when no minter is wired, a resolved
`checkpoint_unavailable` failure.

A mint travels the same queue as a flow call and settles in issue order, so
the pin lands exactly where the cell wrote it. `Cell.checkpointOf` reads the
id out of an `at` value strictly: anything that is not a handle is an ordinary
`invalid_input` failure, never a guess.

## What the realm removes

The prelude deletes `Date`, `Math.random`, and `Proxy` from the realm,
because a replayed cell must reach the same calls in the same order and a
proxy cannot be weighed against the memory ceiling. There is no filesystem,
no network, no process, and no module loader to reach. `Sandbox.compile`
erases type-only TypeScript syntax without evaluating anything and refuses
module syntax, so `import` and `require` are not a back door.

## Next steps

- To bind real flows behind the handler, see
  [Expose flows to cells](./bind-flows.md).
- To let the controller drive frames for you, see
  [Drive the cell loop](./drive-the-loop.md).
- For the failure modes this surface raises, see
  [Troubleshooting](../troubleshooting.md).
