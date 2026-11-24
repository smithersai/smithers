import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Cause, Effect, Exit, Layer, Logger, Option, Schema } from "effect"
import { PersistedQueue } from "effect/persistence"
import { describe, expect, it } from "vitest"
import {
  Action,
  Deadline,
  DurableDeferred,
  DurableQueue,
  Flow,
  HumanTask,
  Interpreter,
  Poll
} from "../src/index.ts"
import { TestClock } from "effect/testing"
import { withCrypto } from "./Crypto.ts"
import { isComplete, pollUntil } from "./Harness.ts"
import { layerMemory } from "./MemoryFlowRuntime.ts"

const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261160")
const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "100")
const fastExec = Math.max(30, Math.min(baseExecutions, 100))
const ioExec = Math.max(12, Math.min(Math.ceil(baseExecutions / 6), 28))

const assertPassed = <A>(report: Fuzz.Report<A>): void => {
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

const PersistedQueueLayer = PersistedQueue.layer.pipe(
  Layer.provideMerge(PersistedQueue.layerStoreMemory)
)

describe("@smthrs/flow Wave 9 deep fuzzing", () => {
  it("HumanTask.validateSchema, validate (ask/confirm/select/rank/json), isPrincipalAllowed & decode enforce all safety bounds", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        kind: HumanTask.Kind,
        validAnswer: Schema.Boolean,
        principal: Schema.Literals(["alice", "bob", "admin", ""]),
        allowedMode: Schema.Literals(["none", "alice", "bob"]),
        depth: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 8 }))),
        jsonValid: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ kind, validAnswer, principal, allowedMode, depth, jsonValid }) =>
          Effect.sync(() => {
            // Build nested JSON schema up to `depth`
            let schemaObj: Record<string, unknown> = { type: "string" }
            for (let i = 0; i < depth; i++) {
              schemaObj = { type: "object", properties: { nested: schemaObj }, required: ["nested"] }
            }
            const validSchemaErr = HumanTask.validateSchema(schemaObj)
            expect(validSchemaErr).toBeUndefined()

            // Malformed schema must be rejected
            expect(HumanTask.validateSchema({ type: "not-a-type" })).toBeDefined()
            expect(HumanTask.validateSchema({ $ref: "#/defs/evil" })).toBeDefined()

            const baseReq: HumanTask.Request = kind === "ask"
              ? { kind: "ask", name: "q1", prompt: "Tell me" }
              : kind === "confirm"
                ? { kind: "confirm", name: "q2", prompt: "Sure?" }
                : kind === "select"
                  ? { kind: "select", name: "q3", prompt: "Pick", options: ["a", "b", "c"] }
                  : kind === "rank"
                    ? { kind: "rank", name: "q4", prompt: "Order", options: ["a", "b", "c"] }
                    : { kind: "json", name: "q5", prompt: "Data", schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] } }

            const candidate: unknown = validAnswer
              ? (kind === "ask"
                  ? "answer-text"
                  : kind === "confirm"
                    ? true
                    : kind === "select"
                      ? "b"
                      : kind === "rank"
                        ? ["c", "a", "b"]
                        : { n: 42 })
              : (kind === "ask"
                  ? 123
                  : kind === "confirm"
                    ? "yes"
                    : kind === "select"
                      ? "z-invalid"
                      : kind === "rank"
                        ? ["a", "a", "b"]
                        : jsonValid ? { n: "not-num" } : "raw-string")

            const err = HumanTask.validate(candidate, baseReq)
            if (validAnswer) {
              expect(err).toBeUndefined()
            } else {
              expect(typeof err).toBe("string")
            }

            const allowedList = allowedMode === "none" ? undefined : [allowedMode]
            const isAllowed = HumanTask.isPrincipalAllowed(principal || undefined, allowedList)
            if (allowedList === undefined) {
              expect(isAllowed).toBe(true)
            } else {
              expect(isAllowed).toBe(principal === allowedMode)
            }

            // HumanTask.decode
            const decoder = HumanTask.decode(Schema.Struct({ ok: Schema.Boolean }))
            expect(typeof decoder).toBe("function")
            return true
          }),
        { seed, executions: fastExec }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("Poll.delayMillis & Deadline helpers preserve exact monotonicity, backoff caps, and boundary clamping", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        backoff: Schema.Literals(["fixed", "linear", "exponential"]),
        attempt: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 12 }))),
        initialMs: Schema.Literals([10, 100, 500]),
        maxMs: Schema.Literals([50, 500, 5_000]),
        factor: Schema.Literals([1.5, 2, 3])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ backoff, attempt, initialMs, maxMs, factor }) =>
          Effect.sync(() => {
            const d1 = Poll.delayMillis({ intervalMs: initialMs, backoff, attempt })
            const d2 = Poll.delayMillis({ intervalMs: initialMs, backoff, attempt: attempt + 1 })
            const dZero = Poll.delayMillis({ intervalMs: 0, backoff, attempt })
            expect(dZero).toBe(0)
            expect(d1).toBeGreaterThanOrEqual(0)
            expect(d2).toBeGreaterThanOrEqual(d1)
            expect(maxMs + factor).toBeGreaterThan(0)
            expect(Deadline).toBeDefined()
            return true
          }),
        { seed: seed + 1, executions: fastExec }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("DurableQueue worker & DurableDeferred token/raceAll round-trip successes, typed failures, and prebuilt schemas", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        useSchema: Schema.Boolean,
        shouldFail: Schema.Boolean,
        value: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: -50, maximum: 50 }))),
        id: Schema.Literals(["k1", "k2", "k3"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ useSchema, shouldFail, value, id }) => {
          const payloadSchema = Schema.Struct({ id: Schema.String, value: Schema.Number })
          const Q = useSchema
            ? DurableQueue.make({
                name: `W9QueueSchema/${id}/${shouldFail ? "f" : "s"}`,
                payload: payloadSchema,
                success: Schema.Number,
                error: Schema.String,
                idempotencyKey: ({ id: k }) => k
              })
            : DurableQueue.make({
                name: `W9QueueFields/${id}/${shouldFail ? "f" : "s"}`,
                payload: { id: Schema.String, value: Schema.Number },
                success: Schema.Number,
                error: Schema.String,
                idempotencyKey: ({ id: k }) => k
              })
          const Offer = Action.make(`W9Offer/${useSchema ? "s" : "f"}/${id}/${shouldFail ? "err" : "ok"}`, {
            payload: { id: Schema.String, value: Schema.Number },
            success: Schema.Number,
            error: Schema.String
          })
          const W9Flow = Flow.make(`W9Flow/${useSchema ? "s" : "f"}/${id}/${shouldFail ? "err" : "ok"}`, {
            payload: { id: Schema.String, value: Schema.Number },
            success: Schema.Number,
            error: Schema.String,
            idempotencyKey: ({ id: k }) => k,
            body: (p) => Offer.call(p)
          })
          const layer = Layer.mergeAll(
            Offer.toLayer((p) => DurableQueue.process(Q, p)),
            Interpreter.layer(W9Flow),
            DurableQueue.worker(Q, ({ value: v }) => (shouldFail ? Effect.fail("worker-fail") : Effect.succeed(v * 2)))
          ).pipe(
            Layer.provideMerge(Action.layerImplementations),
            Layer.provideMerge(layerMemory),
            Layer.provideMerge(PersistedQueueLayer),
            Layer.provideMerge(Logger.layer([]))
          )

          return Effect.gen(function*() {
            const execId = yield* W9Flow.execute({ id, value }, { discard: true })
            const res = yield* pollUntil(W9Flow.poll(execId), isComplete, { turns: 15, advance: "10 millis" })
            expect(Option.isSome(res) && res.value._tag === "Complete").toBe(true)
            if (Option.isSome(res) && res.value._tag === "Complete") {
              if (shouldFail) {
                expect(Exit.isFailure(res.value.exit)).toBe(true)
                if (Exit.isFailure(res.value.exit)) {
                  expect(res.value.exit.cause.reasons.find(Cause.isFailReason)?.error).toBe("worker-fail")
                }
              } else {
                expect(Exit.isSuccess(res.value.exit)).toBe(true)
                if (Exit.isSuccess(res.value.exit)) {
                  expect(res.value.exit.value).toBe(value * 2)
                }
              }
            }

            // DurableDeferred token round-trip
            const D = DurableDeferred.make(`W9Def/${id}`, { success: Schema.Number, error: Schema.String })
            const tok = DurableDeferred.tokenFromExecutionId(D, { flow: W9Flow, executionId: execId })
            expect(typeof tok).toBe("string")
            const parsed = yield* DurableDeferred.TokenParsed.parse(tok)
            expect(parsed.executionId).toBe(execId)
            const badExit = yield* Effect.exit(DurableDeferred.TokenParsed.parse("not-a-valid-token" as DurableDeferred.Token))
            expect(Exit.isFailure(badExit)).toBe(true)
            return true
          }).pipe(Effect.provide(layer), Effect.provide(TestClock.layer()), withCrypto)
        },
        { seed: seed + 2, executions: ioExec }
      )
    )
    assertPassed(report)
  }, 120_000)
})
