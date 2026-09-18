/**
 * A cell that waits on the durable clock has to be woken by it.
 *
 * The `wait` flow is the one standard flow whose whole job is to park the run:
 * `DurableClock.sleep` arms a timer, `DurableDeferred.await` finds nothing, and
 * the execution suspends holding everything the frame had already done. Every
 * other test of that flow settles the deferred *before* the await reads it —
 * `seconds: 0`, or a scripted `scheduleClock` that completes the deferred
 * inline — so none of them ever took the suspension, and the resume that has to
 * follow it was never exercised at all.
 *
 * Two runs of the `r96repl` SWE-bench wave took it. Both journals end the same
 * way: `cell-call-started(wait)`, `deferred-completed`, one `run-decision`
 * carrying `{"decision":"wake-scheduled","reason":"clock"}` — and then nothing,
 * with the run row still `running`, still heartbeating, and holding no waiting
 * reason, until the rig's process budget cancelled it 900 seconds later. The
 * round that should have parked never ended, so the wake the coordinator
 * queued behind it never ran.
 *
 * The cases here run that shape on the durable engine, because the in-memory
 * engine hides it: its `deferredDone` re-executes the run whether or not the
 * previous round ever settled, so a wedged round is replaced instead of being
 * waited on. The durable coordinator queues the wake behind the round that owns
 * the key, which is what turns a wedged round into a wedged run.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Capability from "@smthrs/capability/Capability"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import { Flow as EngineFlow, FlowRuntime } from "@smthrs/flow"
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Jj from "@smthrs/kernel/Jj"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as Route from "@smthrs/model/Route"
import { Node } from "@smthrs/plan"
import * as Registry from "@smthrs/registry/Registry"
import { Deferred, Effect, Layer, Option, Schema, Scope, Stream } from "effect"
import type * as Crypto from "effect/Crypto"
import { describe, expect, it } from "vitest"
import * as Agent from "../src/Agent.ts"
import type * as FlowEngineLike from "../src/FlowEngineLike.ts"
import * as Seat from "../src/Seat.ts"
import * as StandardFlows from "../src/StandardFlows.ts"
import { confident as confidentEvaluator } from "./fixtures/evaluator.ts"
import * as Safety from "./Safety.ts"

const prepared: Route.PreparedRequest = {
  routeId: "route-a",
  protocolId: "test-protocol",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}

const route: FlowEngineLike.RouteResolver = { prepare: () => Effect.succeed(prepared) }

/** A model that answers with one scripted cell per frame. */
const recorded = (cells: ReadonlyArray<string>): Model.Model => {
  let index = 0
  return Model.make({
    stream: () =>
      Stream.suspend(() => {
        const source = cells[index++] ?? cells.at(-1) ?? `ctx.done("done")`
        return Stream.fromIterable([
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id: `cell-${index}` }),
          ModelEvent.ModelEvent.TextDelta({
            type: "text-delta",
            id: `cell-${index}`,
            text: "```cell\n" + source + "\n```"
          }),
          ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: `cell-${index}` }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
      })
  })
}

const jj = Jj.make({
  snapshot: () => Effect.succeed({ changeId: "durable-wait-snapshot" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

/**
 * How far ahead of its declared deadline a clock is armed here.
 *
 * `DurableClock.sleep` runs any wait of a minute or less as an in-memory
 * `Effect.sleep` inside a sealed action, so a wait that actually parks the run
 * has to declare more than a minute — which is why the two r96repl runs that
 * hung declared 90 and 120 seconds. Nothing else about the wait changes when
 * the row is written a minute early: the same durable clock row is persisted,
 * the same timer fires it, the same `deferred-completed` and `wake-scheduled`
 * records are written, and the same coordinator wake resumes the run.
 */
const clockAdvance = 60_000

/** A durable state whose clocks come due a minute before they were asked to. */
const promptClocks = (): DurableEngineState.Service => {
  const state = DurableEngineState.makeMemory()
  return {
    ...state,
    scheduleClock: (row, owner) => state.scheduleClock({ ...row, dueAtMs: row.dueAtMs - clockAdvance }, owner)
  }
}

/** The production durable engine over one in-memory SQLite database. */
const durableEngine = EngineStore.layer({
  owner: { hostId: "durable-wait-host" },
  journalSource: "durable-wait-test",
  isAlive: () => Effect.succeed(false)
}).pipe(
  Layer.provide(Layer.succeed(Jj.Jj)(jj)),
  Layer.provide(Layer.sync(DurableEngineState.DurableEngineState)(promptClocks)),
  Layer.provide(StepBoundary.layerTest()),
  Layer.provide(TestStores.layer()),
  Layer.provide(NodeCrypto.layer)
)

/**
 * The flow the harness is the body of.
 *
 * Its success is `Void` because a round's result is encoded into the durable
 * row: the events the body collects travel out through the deferred below
 * instead, which is also what keeps them the *final* round's events rather
 * than a merge of every round's.
 */
const runFlow = EngineFlow.make("agent/test/durable-wait", {
  payload: {},
  success: Schema.Void,
  error: Schema.Never,
  body: () => Node.succeed(undefined)
})

/** What the run settled with, or the fact that it never settled at all. */
type Outcome =
  | { readonly _tag: "settled"; readonly events: ReadonlyArray<AgentEvent.AgentEvent> }
  | { readonly _tag: "never settled" }

/**
 * Drives one harness run to completion on the durable engine.
 *
 * The body is registered as the flow's execution, so every park and every wake
 * is the engine's own: `execute` returns as soon as the first round settles,
 * and the run continues under the coordinator until a round produces a result.
 */
const driveDurable = (
  body: Effect.Effect<
    ReadonlyArray<AgentEvent.AgentEvent>,
    unknown,
    Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance
  >
): Promise<Outcome> =>
  Effect.gen(function*() {
    const engine = yield* FlowRuntime.FlowRuntime
    const scope = yield* Effect.scope
    const settled = Deferred.makeUnsafe<ReadonlyArray<AgentEvent.AgentEvent>>()
    yield* engine.register(runFlow, () =>
      Effect.flatMap(body, (events) => Effect.asVoid(Deferred.succeed(settled, events))).pipe(Effect.orDie)).pipe(
        Scope.provide(scope)
      )
    yield* engine.execute(runFlow, { executionId: "durable-wait-1", payload: {}, discard: true })
    return yield* Deferred.await(settled).pipe(
      Effect.map((events): Outcome => ({ _tag: "settled", events })),
      Effect.timeoutOrElse({
        duration: "20 seconds",
        orElse: () =>
          Effect.succeed<Outcome>({ _tag: "never settled" })
      })
    )
  }).pipe(
    Effect.provide(durableEngine),
    Effect.provide(NodeCrypto.layer),
    Effect.scoped,
    Effect.runPromise
  )

const collect = (options: {
  readonly cells: ReadonlyArray<string>
  readonly flows: ReadonlyArray<ReturnType<typeof StandardFlows.clock>>
}) =>
  Effect.gen(function*() {
    const collected: Array<AgentEvent.AgentEvent> = []
    const agent = yield* Agent.Agent
    yield* agent.run({
      session: "session-wait",
      seat: Seat.make({
        id: "anthropic:test-model",
        modelId: "test-model",
        model: recorded(options.cells),
        route,
        contextWindowTokens: 0
      }),
      prompt: "do the task",
      registry: Registry.makeNoop({
        list: () => Effect.succeed([]),
        visible: () => Effect.succeed([]),
        getOption: () => Effect.succeed(Option.none())
      }),
      capabilityEnvelope: [new Capability.CapabilityPattern({ action: "*", resource: "*" })],
      flows: options.flows,
      maxFrames: 4
    }).pipe(
      Stream.runForEach((event) => Effect.sync(() => collected.push(event))),
      Effect.provide(Layer.merge(Agent.layerDefaults, confidentEvaluator))
    )
    return collected as ReadonlyArray<AgentEvent.AgentEvent>
  }).pipe(Effect.provide(Agent.layer), Effect.provide(Safety.layer))

const settledCalls = (collected: ReadonlyArray<AgentEvent.AgentEvent>) =>
  collected.flatMap((event) => (event._tag === "cell-call-settled" ? [event] : []))

describe("a cell that waits on the durable clock", () => {
  it("parks the run and resumes it when the clock fires", async () => {
    const outcome = await driveDurable(
      Effect.gen(function*() {
        const services = yield* Effect.context<
          Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance
        >()
        return yield* collect({
          flows: [StandardFlows.clock(services)],
          cells: [
            `const waited = await ctx.call("wait", { seconds: 61 })
ctx.done("waited " + waited.waitedSeconds)`
          ]
        })
      })
    )

    expect(outcome._tag).toBe("settled")
    if (outcome._tag !== "settled") return
    expect(settledCalls(outcome.events).map((event) => event.flowName)).toEqual(["wait"])
    const resolved = outcome.events.find((event) => event._tag === "resolved")
    expect(resolved?._tag === "resolved" ? resolved.message.content : []).toEqual([
      { type: "text", text: "waited 61" }
    ])
  }, 60_000)

  it("waits again on the same clock rather than re-running the calls before it", async () => {
    // The wait sits behind a call the run has already paid for, which is where
    // the r96repl runs took it. The resumed round replays that call from its
    // recorded boundary and re-enters the wait, so the run reaches its answer
    // having issued each call exactly once.
    const outcome = await driveDurable(
      Effect.gen(function*() {
        const services = yield* Effect.context<
          Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance
        >()
        return yield* collect({
          flows: [StandardFlows.clock(services)],
          cells: [
            `const first = await ctx.call("wait", { seconds: 61 })
const second = await ctx.call("wait", { seconds: 61 })
ctx.done("waited " + (first.waitedSeconds + second.waitedSeconds))`
          ]
        })
      })
    )

    expect(outcome._tag).toBe("settled")
    if (outcome._tag !== "settled") return
    const settled = settledCalls(outcome.events)
    expect(settled.map((event) => event.flowName)).toEqual(["wait", "wait"])
    expect(settled.map((event) => event.identity.ordinal)).toEqual([0, 1])
    const resolved = outcome.events.find((event) => event._tag === "resolved")
    expect(resolved?._tag === "resolved" ? resolved.message.content : []).toEqual([
      { type: "text", text: "waited 122" }
    ])
  }, 60_000)
})
