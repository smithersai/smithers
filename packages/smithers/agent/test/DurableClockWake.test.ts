/**
 * A durable clock completion delivered while the waiting cell is arming it.
 *
 * The wait runs inside the cell call's action region. That nested suspension
 * used to wait for its enclosing action to settle before it could park, while
 * the enclosing action could not settle until the wait returned. The clock
 * wake was queued behind a round that therefore never ended. The durable-engine
 * cases in `DurableWait.test.ts` pin that coordinator deadlock. This fast case
 * pins the integration between the standard wait flow, its durable clock, and
 * a completion delivered at the clock-arming boundary.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Capability from "@smthrs/capability/Capability"
import { FlowEngine } from "@smthrs/engine"
import { Flow as EngineFlow, FlowRuntime } from "@smthrs/flow"
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as Route from "@smthrs/model/Route"
import { Node } from "@smthrs/plan"
import * as Registry from "@smthrs/registry/Registry"
import { Cause, Context, Deferred, Effect, Exit, Layer, Option, Schema, Scope, Stream } from "effect"
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

type Outcome<A> =
  | { readonly _tag: "completed"; readonly value: A }
  | { readonly _tag: "failed"; readonly error: unknown }
  | { readonly _tag: "suspended" }

const classify = <A>(exit: Exit.Exit<A, unknown>): Outcome<A> =>
  Exit.isSuccess(exit)
    ? { _tag: "completed", value: exit.value }
    : Cause.hasInterruptsOnly(exit.cause)
    ? { _tag: "suspended" }
    : { _tag: "failed", error: Cause.squash(exit.cause) }

const driveFlow = EngineFlow.make("agent/test/durable-clock-wake", {
  payload: {},
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Node.succeed(undefined)
})

const drive = <A, E>(
  body: Effect.Effect<A, E, Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance>
): Promise<Outcome<A>> =>
  Effect.gen(function*() {
    const engine = yield* FlowRuntime.FlowRuntime
    const scope = yield* Effect.scope
    const settled = Deferred.makeUnsafe<Outcome<A>>()
    yield* engine.register(driveFlow, () =>
      Effect.onExit(body, (exit) => Effect.asVoid(Deferred.succeed(settled, classify(exit))))).pipe(
        Scope.provide(scope)
      )
    yield* engine.execute(driveFlow, { executionId: "exec-1", payload: {}, discard: true })
    return yield* Deferred.await(settled)
  }).pipe(Effect.provide(Layer.merge(FlowEngine.layerMemory, NodeCrypto.layer)), Effect.scoped, Effect.runPromise)

describe("a durable wait nested inside a cell action", () => {
  it("returns the wait result when the clock completes during arming", async () => {
    const outcome = await drive(
      Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        const services = yield* Effect.context<Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance>()
        const scripted = FlowRuntime.FlowRuntime.of({
          ...engine,
          scheduleClock: (flow, opts) =>
            engine.deferredDone(opts.clock.deferred, {
              flowName: flow._tag,
              executionId: opts.executionId,
              deferredName: opts.clock.deferred.name,
              exit: Exit.void
            })
        })
        const clockServices = Context.add(services, FlowRuntime.FlowRuntime, scripted)
        const collected: Array<AgentEvent.AgentEvent> = []
        const agent = yield* Agent.Agent
        yield* agent.run({
          session: "session-1",
          seat: Seat.make({
            id: "anthropic:test-model",
            modelId: "test-model",
            model: recorded([
              `const waited = await ctx.call("wait", { seconds: 61 })
  ctx.done(String(waited.waitedSeconds))`
            ]),
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
          flows: [StandardFlows.clock(clockServices)],
          maxFrames: 3
        }).pipe(
          Stream.runForEach((event) => Effect.sync(() => collected.push(event))),
          Effect.provide(Layer.merge(Agent.layerDefaults, confidentEvaluator))
        )
        return collected
      }).pipe(Effect.provide(Agent.layer), Effect.provide(Safety.layer))
    )
    expect(outcome._tag, outcome._tag === "failed" ? String(outcome.error) : undefined).toBe("completed")
    if (outcome._tag !== "completed") return
    const settled = outcome.value.find((event) => event._tag === "cell-call-settled")
    expect(settled?._tag === "cell-call-settled" ? settled.result.value : undefined).toEqual({ waitedSeconds: 61 })
    const resolved = outcome.value.find((event) => event._tag === "resolved")
    expect(resolved?._tag === "resolved" ? resolved.message.content : []).toEqual([
      { type: "text", text: "61" }
    ])
  }, 30_000)
})
