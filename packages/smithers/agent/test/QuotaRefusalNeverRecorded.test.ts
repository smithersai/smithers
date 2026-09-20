/**
 * A quota refusal is never a recorded step value.
 *
 * `recordModelStep` folds a `ModelError` into the sealed step's recorded VALUE
 * on purpose: a provider's refusal is evidence about the request, and replaying
 * it is cheaper and truer than asking for an answer the provider already gave.
 * A quota refusal is the one class where that reasoning inverts. It says
 * nothing about the request — the same bytes succeed a minute later — so a
 * recorded refusal makes every later dispatch of that key replay a "no" the
 * provider is no longer giving: the park's wake is pointless, a retry can never
 * recover, and on any composition where the step is cross-run cacheable the
 * refusal is served to other runs of the same flow and input.
 *
 * The guard used to be `unlessParked(quota)` alone, which is the identity
 * unless a classifier both exists and parks on the refusal in hand. These cases
 * pin the recorder's own floor instead, and pin it from the outside: the
 * refusal is never recorded, whichever classifier the composition names and
 * whatever that classifier decides. Three compositions cover the ways the
 * policy can decline — `layerUnclassified`, which a host chooses when a refusal
 * should page someone rather than be slept off; the production classifier
 * declining a window past its ceiling; and the production classifier parking,
 * which is the case a policy-shaped guard would have caught anyway.
 *
 * They drive the real composition — `Agent.layer`, the harness port, the
 * durable engine over one set of stores — and read the durable attempt row the
 * engine wrote, because "was it recorded" is a question about storage and not
 * about what the caller was handed.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import * as Jj from "@smthrs/kernel/Jj"
import * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as Route from "@smthrs/model/Route"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, Exit, Layer, Option, Schedule, Schema, Stream } from "effect"
import type * as Crypto from "effect/Crypto"
import type * as Scope from "effect/Scope"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as Agent from "../src/Agent.ts"
import * as AgentAction from "../src/AgentAction.ts"
import * as Budget from "../src/Budget.ts"
import type * as FlowEngineLike from "../src/FlowEngineLike.ts"
import * as QuotaPolicy from "../src/QuotaPolicy.ts"
import { layer as scriptedCompletionJudge } from "../src/ScriptedJudge.ts"
import * as Seat from "../src/Seat.ts"
import * as SeatResolver from "../src/SeatResolver.ts"

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

/**
 * The stub transport: the system's input, scripted.
 *
 * `refusals` is how many asks are answered with the provider's own refusal
 * before the window reopens, so one model serves both the run that is refused
 * and the run that comes back.
 */
const provider = (
  refusals: number,
  error: ModelError,
  calls: Array<string>
): Model.Model =>
  Model.make({
    stream: () =>
      Stream.suspend(() => {
        calls.push("call")
        if (calls.length <= refusals) return Stream.fail(error)
        return Stream.fromIterable([
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
          ModelEvent.ModelEvent.TextDelta({
            type: "text-delta",
            id: "cell",
            text: "```cell\n" + `ctx.done({"approved":true})` + "\n```"
          }),
          ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
          ModelEvent.ModelEvent.Usage({ totalTokens: 120 }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
      })
  })

const emptyRegistry: Registry.Registry = Registry.makeNoop({
  list: () => Effect.succeed([]),
  visible: () => Effect.succeed([]),
  getOption: () => Effect.succeed(Option.none())
})

const host: AgentAction.Host = {
  registry: emptyRegistry,
  limits: { calls: 8 },
  capabilityEnvelope: [],
  maxFrames: 4,
  modelRetryPolicy: Schedule.recurs(0)
}

const seats = (model: Model.Model): Layer.Layer<SeatResolver.SeatResolver> =>
  SeatResolver.layer({
    resolve: (id) =>
      Effect.succeed(Seat.make({ id, modelId: Seat.modelIdOf(id), model, route, contextWindowTokens: 200_000 }))
  })

const Review = Schema.Struct({ approved: Schema.Boolean })

const Step = AgentAction.make("agent/test/quota/Step", {
  payload: { diff: Schema.String },
  output: Review,
  seat: "anthropic:test-model",
  prompt: ({ diff }) => `Review this diff:\n${diff}`
})

const OneStep = Flow.make("agent/test/quota/OneStep", {
  payload: { diff: Schema.String },
  success: Review,
  error: AgentAction.AgentFailure,
  body: ({ diff }) => Step.call({ diff })
})

const jj = Jj.make({
  snapshot: () => Effect.succeed({ changeId: "quota-snapshot" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

/**
 * One set of durable stores with the connection exposed, shared by every
 * execution in a case.
 *
 * The connection is the point: whether a refusal became a recorded value is a
 * fact about the attempt row, and no caller-facing value distinguishes "the
 * step failed" from "the step succeeded carrying a failure".
 */
const stores = Layer.mergeAll(
  StepBoundary.layerTest(),
  Layer.succeed(Jj.Jj)(jj),
  TestStores.layerAt(":memory:")
)

const durable = <A, E>(body: Effect.Effect<A, E, Crypto.Crypto | Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(Effect.provide(body, NodeCrypto.layer)).pipe(Effect.orDie))

/** The payload every execution carries, so all of them seal the same key. */
const input = { diff: "-  old\n+  new" }

const rateLimited = new ModelError({
  code: "rate_limited",
  message: "Too many requests",
  retryAfterMillis: 1_000,
  httpStatus: 429
})

/**
 * A refusal no classifier will park on: the provider named a window four hours
 * out, and `QuotaPolicy.makeDefault` answers `None` above its one-hour ceiling.
 *
 * It is the case that proves the floor is the RECORDER's and not the policy's.
 * With the production classifier composed and this refusal in hand,
 * `unlessParked` decides "no park" — and a guard that only ran on a park would
 * fold the refusal straight into the recorded value.
 */
const unparkable = new ModelError({
  code: "rate_limited",
  message: "Too many requests",
  retryAfterMillis: 4 * 60 * 60 * 1000,
  httpStatus: 429
})

/**
 * The other half of the floor's vocabulary, and the half a status check cannot
 * reach: a provider that spends an account's allowance answers
 * `quota_exceeded` with no HTTP status at all.
 */
const quotaExceeded = new ModelError({
  code: "quota_exceeded",
  message: "This account has spent its monthly allowance"
})

/**
 * A refusal only the composition can recognize: this provider spells a capacity
 * failure as an unclassified error with the reason in prose.
 *
 * The recorder's floor does not cover it — the code is `unknown` and there is
 * no status — which is exactly what the policy hook is for. A host that knows
 * its provider's dialect classifies it, and the run then parks and comes back
 * rather than failing.
 */
const dialectRefusal = new ModelError({
  code: "unknown",
  message: "Model overloaded, ask again shortly"
})

/** One composition's provider-specific reading of {@link dialectRefusal}. */
const dialectClassifier = (): Layer.Layer<QuotaPolicy.QuotaClassifier> =>
  Layer.succeed(QuotaPolicy.QuotaClassifier)(
    QuotaPolicy.make({
      classify: (error, nowMillis) => {
        const model = QuotaPolicy.modelErrorOf(error)
        if (Option.isNone(model) || !model.value.message.includes("overloaded")) return Option.none()
        // One millisecond: the park is real and durable, and the wake is
        // immediate, so the case measures the recovery rather than the wait.
        return Option.some({ wakeAt: nowMillis + 1, source: "text" })
      }
    })
  )

/** One row of `flows_attempts`, in the three columns these cases read. */
interface AttemptRow {
  readonly run_id: string
  readonly state: string
  readonly outcome_json: string | null
}

/** Every attempt row the engine has written so far. */
const attemptRows = Effect.gen(function*() {
  const sql = yield* SqlClient
  return yield* sql<AttemptRow>`SELECT run_id, state, outcome_json FROM flows_attempts`
})

/** The rows whose RECORDED VALUE mentions the refusal's code. */
const recordedRefusals = (
  rows: ReadonlyArray<AttemptRow>,
  code: string
): ReadonlyArray<string> =>
  rows.flatMap((row) => row.outcome_json !== null && row.outcome_json.includes(code) ? [row.outcome_json] : [])

/**
 * One refused run, then one run of the same flow and input after the window
 * reopened, against one set of stores.
 */
const refusedThenReopened = (
  refusal: ModelError,
  quota: Layer.Layer<QuotaPolicy.QuotaClassifier>
) =>
  Effect.gen(function*() {
    const calls: Array<string> = []
    const engine = yield* EngineStore.make({
      owner: { hostId: "quota-floor" },
      journalSource: "quota-floor",
      isAlive: () => Effect.succeed(false)
    })
    const model = provider(1, refusal, calls)
    const wiring = Layer.mergeAll(Step.layer, Interpreter.layer(OneStep)).pipe(
      Layer.provideMerge(AgentAction.layerHost(host)),
      Layer.provideMerge(seats(model)),
      Layer.provideMerge(Layer.mergeAll(Agent.layer, Agent.layerDefaults, scriptedCompletionJudge)),
      Layer.provideMerge(quota),
      Layer.provideMerge(Budget.layerUnbounded()),
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime)(engine))
    )
    const refused = yield* Effect.exit(
      OneStep.execute(input, { executionId: "quota-shut" }).pipe(Effect.provide(wiring))
    )
    const rows = yield* attemptRows
    const reopened = yield* Effect.exit(
      OneStep.execute(input, { executionId: "quota-open" }).pipe(Effect.provide(wiring))
    )
    return { refused, reopened, calls: calls.length, recorded: recordedRefusals(rows, refusal.code) }
  })

describe("a quota refusal under a sealed model step", () => {
  it("is not recorded as the step's durable value when no classifier is composed", async () => {
    const observed = await durable(
      refusedThenReopened(rateLimited, QuotaPolicy.layerUnclassified()).pipe(Effect.provide(stores))
    )

    // The refused execution failed, which is the honest outcome under a
    // composition that declared no wait.
    expect(Exit.isFailure(observed.refused)).toBe(true)
    // And it left NOTHING behind claiming the provider's answer was "no". This
    // is the P0: `unlessParked` was the identity under the no-op classifier, so
    // the refusal became the sealed step's recorded value.
    expect(observed.recorded).toEqual([])
    // The run that came back after the window reopened reached the provider and
    // finished, rather than being served the refusal a second time.
    expect(observed.calls).toBe(2)
    expect(Exit.isSuccess(observed.reopened) ? observed.reopened.value : undefined).toEqual({ approved: true })
  }, 60_000)

  it("is not recorded when the production classifier declines to park on it either", async () => {
    const observed = await durable(
      refusedThenReopened(unparkable, QuotaPolicy.layerDefault()).pipe(Effect.provide(stores))
    )

    expect(Exit.isFailure(observed.refused)).toBe(true)
    expect(observed.recorded).toEqual([])
    expect(observed.calls).toBe(2)
    expect(Exit.isSuccess(observed.reopened) ? observed.reopened.value : undefined).toEqual({ approved: true })
  }, 60_000)

  it("is not recorded when the provider spent an allowance rather than a window", async () => {
    // `quota_exceeded` carries no HTTP status, so a floor written as a status
    // check alone would miss it. It is the code a provider uses when the money
    // ran out rather than the rate: still nothing about the request, and still
    // never a recorded answer.
    const observed = await durable(
      refusedThenReopened(quotaExceeded, QuotaPolicy.layerUnclassified()).pipe(Effect.provide(stores))
    )

    expect(Exit.isFailure(observed.refused)).toBe(true)
    expect(observed.recorded).toEqual([])
    expect(observed.calls).toBe(2)
    expect(Exit.isSuccess(observed.reopened) ? observed.reopened.value : undefined).toEqual({ approved: true })
  }, 60_000)

  it("parks and recovers within one run when a classifier does own the wait", async () => {
    const calls: Array<string> = []
    const observed = await durable(
      Effect.gen(function*() {
        const engine = yield* EngineStore.make({
          owner: { hostId: "quota-park" },
          journalSource: "quota-park",
          isAlive: () => Effect.succeed(false)
        })
        const wiring = Layer.mergeAll(Step.layer, Interpreter.layer(OneStep)).pipe(
          Layer.provideMerge(AgentAction.layerHost(host)),
          Layer.provideMerge(seats(provider(1, rateLimited, calls))),
          Layer.provideMerge(Layer.mergeAll(Agent.layer, Agent.layerDefaults, scriptedCompletionJudge)),
          // A one-millisecond window: the park is real and durable, and the
          // wake is immediate, so the case measures the recovery rather than
          // the wait.
          Layer.provideMerge(QuotaPolicy.layerDefault({ defaultWaitMillis: 1 })),
          Layer.provideMerge(Budget.layerUnbounded()),
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime)(engine))
        )
        const value = yield* OneStep.execute(input, { executionId: "quota-parked" }).pipe(
          Effect.provide(wiring)
        )
        const rows = yield* attemptRows
        return { value, calls: calls.length, recorded: recordedRefusals(rows, rateLimited.code) }
      }).pipe(Effect.provide(stores))
    )

    // The park's whole point: the same run asked again and got an answer.
    expect(observed.value).toEqual({ approved: true })
    expect(observed.calls).toBe(2)
    expect(observed.recorded).toEqual([])
  }, 60_000)

  it("lets a composition park a refusal its own provider spells differently", async () => {
    // The hook adds to the floor rather than replacing it: this failure is
    // `unknown` with no status, so the recorder would have folded it into the
    // step's value, and the classifier is the only thing that knows better.
    const calls: Array<string> = []
    const observed = await durable(
      Effect.gen(function*() {
        const engine = yield* EngineStore.make({
          owner: { hostId: "quota-dialect" },
          journalSource: "quota-dialect",
          isAlive: () => Effect.succeed(false)
        })
        const wiring = Layer.mergeAll(Step.layer, Interpreter.layer(OneStep)).pipe(
          Layer.provideMerge(AgentAction.layerHost(host)),
          Layer.provideMerge(seats(provider(1, dialectRefusal, calls))),
          Layer.provideMerge(Layer.mergeAll(Agent.layer, Agent.layerDefaults, scriptedCompletionJudge)),
          Layer.provideMerge(dialectClassifier()),
          Layer.provideMerge(Budget.layerUnbounded()),
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime)(engine))
        )
        const value = yield* OneStep.execute(input, { executionId: "quota-dialect-run" }).pipe(
          Effect.provide(wiring)
        )
        const rows = yield* attemptRows
        return { value, calls: calls.length, recorded: recordedRefusals(rows, dialectRefusal.message) }
      }).pipe(Effect.provide(stores))
    )

    expect(observed.value).toEqual({ approved: true })
    expect(observed.calls).toBe(2)
    expect(observed.recorded).toEqual([])
  }, 60_000)
})

describe("the durable engine state the quota park annotates", () => {
  it("is the same state a composition reads its waiting runs from", async () => {
    // Guards the layer this suite's stores depend on: `layerAt` provides
    // `DurableEngineState` itself, so a case that also merged the in-memory one
    // would be reading a different map than the engine writes.
    const rows = await durable(
      Effect.gen(function*() {
        const state = yield* DurableEngineState.DurableEngineState
        return yield* state.waitingRuns({ reason: "quota" })
      }).pipe(Effect.provide(stores))
    )
    expect(rows).toEqual([])
  })
})
