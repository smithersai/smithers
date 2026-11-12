import type * as SecureRandom from "effect/crypto/SecureRandom"
/**
 * The agent loop's model step retries a transient provider failure as the
 * durable engine's next attempt.
 *
 * The step used to retry inside itself, on a schedule whose attempt count and
 * failed attempts' spend lived in the process: the engine saw one attempt, a
 * restart started the schedule over, and the sealed record folded every
 * failed call's usage into the one answer. These cases drive the harness port
 * on the durable engine over one SQLite database, and read what the engine
 * and the budget wrote: the attempt numbers the provider was called under,
 * the attempt rows, and the budget's durable usage records.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import { Action, Flow, FlowRuntime, RetryPolicy } from "@smthrs/flow"
import * as ContextWindow from "@smthrs/harness/ContextWindow"
import type * as EngineLike from "@smthrs/harness/EngineLike"
import { Journal } from "@smthrs/journal"
import * as Jj from "@smthrs/kernel/Jj"
import * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import type * as Route from "@smthrs/model/Route"
import { Node } from "@smthrs/plan"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema, Scope, Stream } from "effect"
import type * as EffectDigest from "effect/crypto/Digest"
import { SqlClient } from "effect/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as Budget from "../src/Budget.ts"
import * as FlowEngineLike from "../src/FlowEngineLike.ts"
import * as QuotaPolicy from "../src/QuotaPolicy.ts"

const prepared: Route.PreparedRequest = {
  routeId: "route-a",
  protocolId: "test-protocol",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}

const request = ModelRequest.ModelRequest.make({
  modelId: "test-model",
  system: [],
  messages: [ModelRequest.Message.user("review the diff")],
  tools: [],
  params: ModelRequest.GenerationParams.make()
})

const step: EngineLike.SealedModelStep = {
  request,
  keyMaterial: {
    version: "flows/key-material/v2",
    kind: "sealed",
    body: { _tag: "ModelCall", request },
    inputs: [{ _tag: "Literal", value: { contextDigest: ContextWindow.make({ modelId: "m", segments: [] }).digest } }],
    layers: [],
    capabilities: [],
    effects: undefined,
    placement: undefined
  }
}

const answer = [
  ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "0" }),
  ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "0", text: "approved" }),
  ModelEvent.ModelEvent.Usage({ totalTokens: 120 }),
  ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
]

/** A dropped connection after the provider reported what the attempt cost. */
const dropped = Stream.concat(
  Stream.make(ModelEvent.ModelEvent.Usage({ totalTokens: 300 })),
  Stream.fail(new ModelError({ code: "transport", message: "socket closed after usage" }))
)

/**
 * The provider: each call answers from `script` in turn, and the engine
 * attempt it was called under is noted, which is the attempt count a restart
 * must not lose.
 */
const provider = (
  script: ReadonlyArray<Stream.Stream<ModelEvent.ModelEvent, ModelError>>,
  attempts: Array<number>
): Model.Model =>
  Model.make({
    stream: () =>
      Stream.unwrap(Effect.gen(function*() {
        attempts.push(yield* Action.CurrentAttempt)
        return script[Math.min(attempts.length, script.length) - 1]!
      }))
  })

/** The production classification on a millisecond backoff. */
const retries = (maxAttempts: number) =>
  RetryPolicy.make({ ...FlowEngineLike.defaultModelRetryPolicy, initialMs: 1, maxMs: 1, maxAttempts })

const probe = Flow.make("agent/test/model-retries-on-engine", {
  payload: {},
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Node.succeed(null)
})

const jj = Jj.make({
  snapshot: () => Effect.succeed({ commitId: "retry-snapshot" as never, changeId: "retry-snapshot" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

/** One database every process in a case shares, with the connection exposed. */
const stores = Layer.mergeAll(StepBoundary.layerTest(), Layer.succeed(Jj.Jj)(jj), TestStores.layerAt(":memory:"))

type Port = Effect.Effect<
  unknown,
  unknown,
  | (EffectDigest.Digest | SecureRandom.SecureRandom)
  | FlowRuntime.FlowRuntime
  | FlowRuntime.FlowInstance
  | Budget.Budget
  | QuotaPolicy.QuotaClassifier
>

/**
 * One process: a durable engine of its own and a fresh budget, running `body`
 * as the probe's execution, which resumes whatever an earlier process left.
 */
const incarnation = (hostId: string, executionId: string, body: Port) =>
  Effect.gen(function*() {
    const engine = yield* EngineStore.make({
      owner: { hostId },
      journalSource: hostId,
      isAlive: () => Effect.succeed(false)
    })
    const budget = yield* Budget.make({})
    const journal = yield* Journal.Journal
    const scope = yield* Effect.scope
    const settled = yield* Deferred.make<Exit.Exit<unknown, unknown>>()
    yield* engine.register(probe, () =>
      body.pipe(
        Effect.provideService(FlowRuntime.FlowRuntime, engine),
        Effect.provideService(Budget.Budget, budget),
        Effect.provideService(QuotaPolicy.QuotaClassifier, QuotaPolicy.makeUnclassified()),
        Effect.provideService(Journal.Journal, journal),
        Effect.onExit((exit) => Deferred.succeed(settled, exit))
      )).pipe(Scope.provide(scope))
    yield* engine.execute(probe, { executionId, payload: {}, discard: true })
    const exit = yield* Deferred.await(settled)
    return { exit, usage: yield* budget.usageOf(executionId) }
  })

/** Seals the one step through a port that retries on `policy`, and collects what the caller sees. */
const sealing = (model: Model.Model, policy: RetryPolicy.RetryPolicy): Port =>
  Effect.gen(function*() {
    const port = yield* FlowEngineLike.make({
      model,
      route: { prepare: () => Effect.succeed(prepared) },
      modelRetryPolicy: policy
    })
    return Array.from(yield* Stream.runCollect(port.sealStepWithEvents!(step, () => Effect.void)))
  })

/** One row of `flows_attempts`. */
interface AttemptRow {
  readonly attempt: number
  readonly state: string
  readonly outcome_json: string | null
  readonly error_json: string | null
}

/** The attempt rows of the model step: every row that names the provider's words. */
const modelRows = (executionId: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient
    const rows = yield* sql<AttemptRow>`
      SELECT attempt, state, outcome_json, error_json FROM flows_attempts
      WHERE run_id = ${executionId} ORDER BY attempt`
    return rows.filter((row) => `${row.outcome_json ?? ""}${row.error_json ?? ""}`.match(/approved|socket|overloaded/))
  })

const durable = <A, E>(
  body: Effect.Effect<
    A,
    E,
    (EffectDigest.Digest | SecureRandom.SecureRandom) | Scope.Scope | Layer.Success<typeof stores>
  >
) =>
  Effect.runPromise(
    Effect.scoped(body).pipe(Effect.provide(stores), Effect.provide(NodeCrypto.layer), Effect.orDie)
  )

const failed = (exit: Exit.Exit<unknown, unknown>): unknown => {
  expect(Exit.isFailure(exit)).toBe(true)
  return Cause.squash((exit as Exit.Failure<unknown, unknown>).cause)
}

describe("a model step's transient failure on the durable engine", () => {
  it("is retried as the engine's next attempt, each failed attempt charged once and sealed apart", async () => {
    const attempts: Array<number> = []
    const observed = await durable(Effect.gen(function*() {
      const run = yield* Effect.scoped(
        incarnation(
          "retry-once",
          "retry-once",
          sealing(provider([dropped, Stream.fromIterable(answer)], attempts), retries(6))
        )
      )
      return { ...run, rows: yield* modelRows("retry-once") }
    }))

    // The engine numbered the attempts: the provider saw the second one.
    expect(attempts).toEqual([1, 2])
    expect(Exit.isSuccess(observed.exit)).toBe(true)
    const seen = (observed.exit as Exit.Success<ReadonlyArray<ModelEvent.ModelEvent>, unknown>).value
    // The caller is told before the second attempt's output arrives.
    expect(seen.filter((event) => event.type === "retry")).toMatchObject([{ attempt: 2, code: "transport" }])
    expect(seen.findIndex((event) => event.type === "retry")).toBeLessThan(
      seen.findIndex((event) => event.type === "text-start")
    )
    expect(seen.at(-1)).toMatchObject({ type: "settle" })
    // The failed attempt's 300 tokens were charged once, as that attempt
    // ended, and the answer's 120 when it sealed: two calls, never one call
    // of 420.
    expect(observed.usage).toEqual({ tokens: 420, calls: 2, largestCall: 300 })
    // Both attempts are the engine's own rows, and the sealed value holds the
    // last attempt's usage alone.
    expect(observed.rows.map((row) => [row.attempt, row.state])).toEqual([[1, "failed"], [2, "succeeded"]])
    expect(observed.rows[0]!.outcome_json ?? "").not.toContain("approved")
    expect(observed.rows[1]!.outcome_json).toContain("approved")
    expect(observed.rows[1]!.outcome_json).toContain("\"totalTokens\":120")
    expect(observed.rows[1]!.outcome_json).not.toContain("420")
  }, 60_000)

  it("keeps its attempt count and its failed attempt's spend across a restart mid-retry", async () => {
    const attempts: Array<number> = []
    const observed = await durable(Effect.gen(function*() {
      const reached = yield* Deferred.make<void>()
      // The second attempt's call hangs until the process dies under it.
      const hung = Stream.fromEffect(Effect.andThen(Deferred.succeed(reached, undefined), Effect.never))
      const model = provider([dropped, hung, Stream.fromIterable(answer)], attempts)
      yield* Effect.scoped(Effect.gen(function*() {
        const running = yield* incarnation("before", "restart", sealing(model, retries(6))).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* Deferred.await(reached)
        yield* Fiber.interrupt(running)
      }))
      const callsBefore = attempts.length
      const after = yield* Effect.scoped(incarnation("after", "restart", sealing(model, retries(6))))
      return { ...after, callsBefore, rows: yield* modelRows("restart") }
    }))

    expect(observed.callsBefore).toBe(2)
    // The restarted process carried on from the engine's own attempt number,
    // re-running the attempt the restart cut off; an in-process schedule would
    // have started over at attempt 1.
    expect(attempts).toEqual([1, 2, 2])
    expect(Exit.isSuccess(observed.exit)).toBe(true)
    // The failed first attempt was charged before the restart, and is still.
    // The attempt the restart cut off was a physical call whose usage never
    // arrived: it counts, as unreported, so `tokens` is a lower bound.
    expect(observed.usage).toEqual({ tokens: 420, calls: 3, largestCall: 300, unreported: 1 })
    expect(observed.rows.map((row) => [row.attempt, row.state])).toEqual([[1, "failed"], [2, "succeeded"]])
    expect(observed.rows[1]!.outcome_json).toContain("\"totalTokens\":120")
  }, 60_000)

  it.each(
    [
      ["rate_limited", 429],
      ["quota_exceeded", undefined]
    ] as const
  )("hands a %s refusal to the controller unretried and unrecorded", async (code, httpStatus) => {
    const attempts: Array<number> = []
    const refusal = new ModelError({ code, message: "overloaded account", ...(httpStatus ? { httpStatus } : {}) })
    const observed = await durable(Effect.gen(function*() {
      const run = yield* Effect.scoped(
        incarnation(code, code, sealing(provider([Stream.fail(refusal)], attempts), retries(6)))
      )
      return { ...run, rows: yield* modelRows(code) }
    }))

    expect(attempts).toEqual([1])
    expect(failed(observed.exit)).toMatchObject({ code })
    expect(observed.rows.some((row) => (row.outcome_json ?? "").includes("overloaded"))).toBe(false)
  }, 60_000)

  it("retries a provider_internal refusal on the engine, then hands it to the controller unsealed", async () => {
    const attempts: Array<number> = []
    const overloaded = new ModelError({ code: "provider_internal", message: "overloaded", httpStatus: 529 })
    const observed = await durable(Effect.gen(function*() {
      const run = yield* Effect.scoped(
        incarnation("internal", "internal", sealing(provider([Stream.fail(overloaded)], attempts), retries(3)))
      )
      return { ...run, rows: yield* modelRows("internal") }
    }))

    expect(attempts).toEqual([1, 2, 3])
    expect(failed(observed.exit)).toMatchObject({ code: "provider_internal", httpStatus: 529 })
    expect(observed.rows.map((row) => [row.attempt, row.state])).toEqual([
      [1, "failed"],
      [2, "failed"],
      [3, "failed"]
    ])
    expect(observed.rows.some((row) => (row.outcome_json ?? "").includes("overloaded"))).toBe(false)
  }, 60_000)

  it("seals a transport failure on the last attempt, and a replay answers it without the provider", async () => {
    const attempts: Array<number> = []
    const model = provider([dropped], attempts)
    const observed = await durable(Effect.gen(function*() {
      const run = yield* Effect.scoped(incarnation(
        "exhausted",
        "exhausted",
        Effect.gen(function*() {
          const first = yield* Effect.exit(sealing(model, retries(3)))
          const replayed = yield* Effect.exit(sealing(model, retries(3)))
          return { first, replayed }
        })
      ))
      return { ...run, rows: yield* modelRows("exhausted") }
    }))

    expect(attempts).toEqual([1, 2, 3])
    const { first, replayed } = (observed.exit as Exit.Success<{
      readonly first: Exit.Exit<unknown, unknown>
      readonly replayed: Exit.Exit<unknown, unknown>
    }, unknown>).value
    expect(failed(first)).toMatchObject({ code: "transport", message: "socket closed after usage" })
    expect(failed(replayed)).toStrictEqual(failed(first))
    // The last attempt sealed the error as the step's value, with what that
    // attempt cost; the two before it were charged as they failed.
    expect(observed.rows.map((row) => [row.attempt, row.state])).toEqual([
      [1, "failed"],
      [2, "failed"],
      [3, "succeeded"]
    ])
    expect(observed.rows[2]!.outcome_json).toContain("socket closed after usage")
    expect(observed.usage).toEqual({ tokens: 900, calls: 3, largestCall: 300 })
  }, 60_000)
})
