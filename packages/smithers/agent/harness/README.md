# @smthrs/harness

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact `4.0.5` peer dependency. Install one
`effect` release at that version so all Smithers packages share one Effect
runtime.

**Documentation:** https://github.com/smithersai/smithers/tree/main/packages/smithers/agent/harness/docs

An agent loop where the model writes JavaScript instead of calling tools. Each
turn the model emits a **cell**: a small program that runs in a sandbox the run
keeps open, and that reaches the outside world through exactly one function,
`ctx.call(flowName, input)`.

Scheduling, persistence, transport, and model execution stay behind explicit
service ports, so this package holds no scheduler, no database, and no provider
client.

## Install

```bash
npm install @smthrs/harness@next effect
```

[Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/harness/docs/installation.md) covers the runtimes
it supports and its `effect` peer range.

## A working example

This program opens a QuickJS realm, evaluates one cell that completes the run,
and prints the outcome. It runs on Node with no other setup.

```ts
import * as Cell from "@smthrs/harness/Cell"
import * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"
import * as Sandbox from "@smthrs/harness/Sandbox"
import { Effect } from "effect"

const call: Sandbox.Handler = () => Effect.succeed(new Cell.CallResult({ outcome: "success", value: null }))

const program = Effect.gen(function*() {
  const sandbox = yield* QuickJSSandbox.make
  const realm = yield* sandbox.openRealm!({ flows: {} })
  const frame = yield* realm.evaluate({
    cell: Cell.source(`ctx.done("hello from the realm")`),
    frame: 0,
    call
  })
  return frame.outcome
})

const outcome = await Effect.runPromise(Effect.scoped(program))
console.log(outcome)
// { _tag: "settled", transition: { _tag: "complete", output: "hello from the realm" } }
```

## The cell loop

The primary loop is cell-first. A frame is `model -> generated cell -> realm evaluation -> individually durable flow calls -> next transition`: the model emits fenced `cell` blocks of JavaScript, they run as one program in a realm that outlives the frame and whose only effectful primitive is `ctx.call`, and the cell states its intent by calling: `ctx.done(output)` completes, `ctx.park(reason, message)` waits, and a cell that calls neither continues. `Sandbox.replTransition` turns that call into the `continue` / `complete` / `park` transition the journal records; nothing is returned and nothing is filed, because the realm is the memory and what a cell prints is what the next model turn reads. `CellTurn` is that controller; it decides continuation from the transition and the run's budgets, never from provider tool calls.

The production QuickJS binding never runs an unbounded cell. `Sandbox.defaultLimits` fills every ceiling a caller omits: 64 flow calls, 1,000 interpreter interrupt checks and a 30-second compute deadline per frame, a 900-second whole-evaluation backstop, a 120-second ceiling on any one flow call, and a 128 MiB memory budget. The memory budget is a **run** budget rather than a frame one, because the realm outlives its frames: `runtime.setMemoryLimit` does not count string data on the shipped build, so the panel probe weighs what the realm's own names hold and refuses a frame that opens over the ceiling before it runs. A caller may raise any individual ceiling explicitly; omitted ceilings retain their defaults, so a partial override cannot accidentally disable the others. `steps` and `timeMs` have typed floors (`Sandbox.minimumSteps`, `Sandbox.minimumTimeMs`), because a budget of zero interrupts the binding's own scaffolding rather than the cell.

The controller also keeps the script itself, for the one host that needs it. A frame throws its cell away once the realm has evaluated it, so a model that wants to turn the script it just ran into a saved flow has nothing to read back. `CellHistory` is where the source goes: the controller appends each cell as it executes it, before evaluation, so a cell that raised is still part of what the run ran. The service is optional (a host that offers no way to save a flow binds nothing and the controller records nothing), and `@smthrs/agent/PromoteFlows` is what reads it.

Every `ctx.call` inside a cell is its own keyed, journaled, permission-gated boundary at the tier the flow declares, so a cell is never one opaque activity. That is what makes a crash or a permission park mid-cell recoverable: the cell source re-executes from the top, boundaries that already settled replay their recorded values, and execution reaches the parked call deterministically.

One case is bounded rather than free: a call the `callMs` ceiling interrupted settled nowhere, so a re-executed frame issues it to the host again and is then handed the recorded timeout. The cell's branch is stable either way; what the run pays for twice is the interrupted call. [Durability](https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/harness/docs/api.md#durability) says why the call cannot move inside the record that would suppress it.

## Flows are the only capability primitive

A cell is handed exactly one authority: `ctx.call(flowName, input)`. There is no `ctx.fs`, no `ctx.shell`, no `ctx.mcp`, no `ctx.spawn` / `ctx.send` / `ctx.await`. Standard host capabilities, incoming MCP tools, and subagents are all _ordinary flow declarations plus a binding_, so a cell reaches every one of them with the same two lines and every one of them settles through the same durable `EngineLike.call` boundary with the same `CellCallStarted` / `CellCallSettled` trail.

`FlowBinding` is that contract: `Binding` pairs a flow declaration with its handler, decoding cell input through the flow's input schema and validating the handler's output back into serializable JSON; `Source` produces bindings, possibly lazily; `Catalog` composes ordered sources and refuses two implementations under one name; and `FlowBinding.registry` discloses a catalog through an ordinary `Registry.Registry`, with file-discovered entries keeping precedence. A correctable failure (bad input, a flow that failed, unserializable output) becomes a `failure` `Cell.CallResult` the cell may catch; a permission requirement, an abort, or a suspension stays in the typed error channel where the cell can neither see nor swallow it.

`@smthrs/agent/Agent` is the assembled production entry point that composes all of this over the durable engine.

## Running an agent needs a configured judge

The sixth brake on a completion asks Jev, TypeSafe's decision model, whether the claim the run wrote matches the evidence the run produced, through the `Evaluator` service of [`@smthrs/model`](https://github.com/smithersai/smithers/tree/main/packages/smithers/agent/model/docs). It never falls back. A completion nothing could judge fails the turn as `HarnessError` `completion_unjudged` carrying the reason, the way `read_only_cap` fails it, rather than standing unjudged: a brake that goes quiet when its model is down is a brake that is only there when it is not needed.

It runs only where the workflow arms it. `claimCap` defaults to 0, so no model reads a completion unless the flow running the agent passes a positive cap through `AgentAction`'s `claimCap`, `AgentAction.Host.claimCap` or `Agent.Options.claimCap` (Will, 2026-10-14, #3993): a model checking the work spends tokens and time on every completion and is a verification policy, which belongs to the workflow. On the 2026-10-14 SWE-bench Pro run the default judge refused 10 runs as `claim_unproven`, 9 of them correct. The deterministic completion demands run on every completion either way. Armed, it never goes quiet: every completion with a claim is read, the cap (3 is the measured number) is the number of frames the run is given to prove one, and a claim with no bounce left fails the turn as `claim_unproven` carrying both probabilities. The cap used to end the brake instead of the run, so the second claim stood unread: on a real seat a run bounced once re-claimed the identical sentence and finished `stop` on it while the served repository's own test exited 1.

`Evaluator.Evaluator` is required by `CellTurn.run` and `Agent.run`.
`Evaluator.layerFromSeat(seat)` uses a seat the host already resolved, including
Codex and Claude subscriptions. Native hosts use their existing subscription
resolver with no gateway key. Missing seats, provider errors and malformed
verdicts fail closed as `completion_unjudged`. The deterministic brakes run
first; claims they reject never reach the judge.

An offline host binds `Evaluator.layerScripted` deliberately, dispatches by question id, and computes answers from the evidence. Constant approval disarms the brake. One evaluator serves all the host's classifiers; see the [whole-host scripted judge](https://github.com/smithersai/smithers/blob/main/flows/test/fixtures/scripted-judge.ts). `Evaluator.layerUnavailable()` remains an outage fixture for classifier tests, not a host default.

## Public API

The root entry point exports one namespace per module; each is also importable from `@smthrs/harness/<Module>`, except `DoneText` and `QuickJSVariant`, which are on the root only. `QuickJSSandbox` is deliberately _not_ re-exported from the root: it carries an embedded WebAssembly build, so it is imported from its own subpath by hosts that want it.

Every module and every export it publishes is listed in the
[module and export inventory](https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/harness/docs/reference.md).

`@smthrs/harness/QuickJSSandbox` exports `make` and `layer`: the QuickJS-WASM `Sandbox` binding, which runs the same single-file build on Node and in a browser and enforces the default ceilings above. It is also the one binding that offers `Sandbox.openRealm`, the persistent realm every run holds for its whole life ([Repl realm](https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/harness/docs/concepts.md#repl-realm)). It also exports `VariantService`, `Variant`, `layerVariantLive`, `layerVariant`, `makeWithVariant` and `layerWithVariant`, which are how a host names the build instead of taking the default; see below.

`@smthrs/harness/package.json` is also exported. `internal/*` and nested `*/index` subpaths are not public.

## Naming the QuickJS build

`make` and `layer` compile the single-file build from bytes, which is what Node and a browser want. Some runtimes forbid that. Cloudflare's workerd runs no WebAssembly it did not compile itself: `WebAssembly.compile` over bytes fails at runtime, and the only module a worker can instantiate is one its toolchain bundled and handed over as an import.

`QuickJSSandbox.Variant` is that seam. `layerVariantLive` provides the single-file default and `layerVariant(variant)` provides a build the host names; `layerWithVariant` and `makeWithVariant` are the sandbox over whichever one is in context. `@smthrs/agent/Agent` carries the same pair: `layerDefaults` is unchanged and `layerDefaultsWithVariant` takes the build from context.

A worker names its build with the `.wasm` module its bundler compiled:

```ts
import wasmfile from "@jitl/quickjs-wasmfile-release-sync"
import wasmModule from "@jitl/quickjs-wasmfile-release-sync/wasm"
import * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"
import { Layer } from "effect"
import { newVariant } from "quickjs-emscripten-core"

const layer = QuickJSSandbox.layerWithVariant.pipe(
  Layer.provide(QuickJSSandbox.layerVariant(newVariant(wasmfile, { wasmModule })))
)
```

The full workerd setup, including the `wrangler` configuration a worker needs,
is in [Run on Cloudflare workerd](https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/harness/docs/guides/workerd.md).

## Documentation

The published site is https://github.com/smithersai/smithers/tree/main/packages/smithers/agent/harness/docs.

- [Quickstart](https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/harness/docs/quickstart.md): run two cells against
  one realm and read the frames they produce.
- [Concepts](https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/harness/docs/concepts.md): the cell loop, the
  persistent realm, and durable flow calls as the only I/O.
- [API reference](https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/harness/docs/api.md): behavior and
  signatures for every public export.
- [Module and export inventory](https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/harness/docs/reference.md): every
  module and its exports, one table per module.
- [Troubleshooting](https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/harness/docs/troubleshooting.md): the failure
  modes the package raises, and what to do about each.

Pinned `Flow.make` modules, a repository's or a person's own, run through the
isolated [`RealmFlow` host](docs/realm-flows.md), which returns durable action
requests, agent steps included, and resumes from validated receipts.
