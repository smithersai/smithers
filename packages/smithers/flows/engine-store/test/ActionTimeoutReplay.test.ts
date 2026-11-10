import type * as SecureRandom from "effect/crypto/SecureRandom"
/**
 * Pins issue #1804 on the durable engine: an attempt that outlives its
 * `attemptTimeoutMs` settles as a FAILED attempt row, and an engine rebuilt
 * over the same stores still reads that replayed timeout as a retryable
 * attempt failure rather than a terminal defect.
 */
import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Action, Flow, FlowRuntime, RetryPolicy, StepIdentity } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { AttemptStore, RunStore } from "@smthrs/run-store"
import * as Cause from "effect/Cause"
import type * as EffectDigest from "effect/crypto/Digest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import type * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as DurableEngineState from "../src/DurableEngineState.vibe"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.vibe"
import * as TestStores from "../src/test/TestStores.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { invocationKey, runSync, sha256, withCrypto } from "./Sha256.ts"

const jj = Jj.make({
  snapshot: () =>
    Effect.succeed({ commitId: "action-timeout-snapshot" as never, changeId: "action-timeout-snapshot" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

type Services =
  | Layer.Success<ReturnType<typeof TestStores.layer>>
  | StepBoundary.Service
  | DurableEngineState.DurableEngineState
  | Jj.Jj
  | TestClock.TestClock
  | (EffectDigest.Digest | SecureRandom.SecureRandom)
  | Scope.Scope

const withRestart = <A, E>(
  body: (
    makeEngine: Effect.Effect<FlowRuntime.FlowRuntime["Service"], never, Services>,
    store: RunStore.Service,
    attempts: AttemptStore.Service
  ) => Effect.Effect<A, E, Services>
) =>
  withCrypto(
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const attempts = yield* AttemptStore.AttemptStore
        const makeEngine = EngineStore.make({
          owner: { hostId: "action-timeout-host" },
          journalSource: "action-timeout-test",
          isAlive: () => Effect.succeed(false)
        })
        return yield* body(makeEngine, store, attempts)
      }).pipe(
        Effect.provideService(DurableEngineState.DurableEngineState, DurableEngineState.makeMemory()),
        Effect.provideService(Jj.Jj, jj)
      )
    ).pipe(
      Effect.provide(StepBoundary.layerTest()),
      Effect.provide(TestStores.layer()),
      Effect.provide(TestClock.layer())
    )
  )

describe("attemptTimeoutMs on the durable engine (issue #1804)", () => {
  it.effect("settles a hung attempt as failed and retries it after a restart", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      let bodyRuns = 0
      const flow = Flow.make("ActionTimeout/Restart", {
        payload: {},
        success: Schema.Number,
        body: opaqueHandlerBody
      })
      const hung = Action.make({
        name: "action-timeout-hung",
        success: Schema.Number,
        attemptTimeoutMs: 100,
        retryPolicy: RetryPolicy.make({ initialMs: 1000, factor: 1, maxMs: 1000, maxAttempts: 2 }),
        execute: Effect.suspend(() => {
          bodyRuns++
          return bodyRuns === 1
            ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.succeed(42)
        })
      })
      const handler = () =>
        Effect.gen(function*() {
          return yield* hung
        })
      const attemptId = {
        runId: "action-timeout-run",
        stepKeyDigest: sha256(invocationKey({
          runId: "action-timeout-run",
          parentScope: runSync(StepIdentity.allocationScope({ kind: "action", name: "action-timeout-hung" })),
          ordinal: 1,
          tier: "unsealed"
        })),
        attempt: 1
      }

      const result = yield* withRestart((makeEngine, store, attempts) =>
        Effect.gen(function*() {
          const firstScope = yield* Scope.make()
          const first = yield* makeEngine.pipe(Scope.provide(firstScope))
          yield* first.register(flow, handler)
          const driveFiber = yield* first.execute(flow, {
            executionId: "action-timeout-run",
            payload: {},
            discard: true
          }).pipe(Effect.forkChild({ startImmediately: true }))
          yield* TestDatabase.until(
            attempts.get(attemptId).pipe(Effect.map((row) => Option.isSome(row) && row.value.state === "running"))
          )
          // A running row precedes timeout installation; observe the actual body before advancing.
          yield* Deferred.await(started)
          yield* TestClock.adjust(100)
          // The expired attempt is settled inside persistence, not stranded
          // as a running row.
          yield* TestDatabase.until(
            attempts.get(attemptId).pipe(Effect.map((row) => Option.isSome(row) && row.value.state === "failed"))
          )
          expect(bodyRuns).toBe(1)
          const failed = Option.getOrThrow(yield* attempts.get(attemptId))

          // Process death during the retry backoff.
          yield* Scope.close(firstScope, Exit.void)
          yield* Fiber.interrupt(driveFiber)

          const restarted = yield* makeEngine
          yield* restarted.register(flow, handler)
          yield* restarted.execute(flow, {
            executionId: "action-timeout-run",
            payload: {},
            discard: true
          }).pipe(Effect.forkChild({ startImmediately: true }))
          let row = yield* store.get("action-timeout-run")
          for (let i = 0; i < 2000 && row.status !== "completed"; i++) {
            yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 2)))
            yield* TestClock.adjust(1000)
            row = yield* store.get("action-timeout-run")
          }
          return { failed, row }
        })
      )

      expect(JSON.stringify(result.failed.error)).toContain("@smthrs/flow/AttemptTimedOut")
      expect(result.row.status).toBe("completed")
      expect(JSON.parse(result.row.stateJson).result.exit).toMatchObject({ _tag: "Success", value: 42 })
      expect(bodyRuns).toBe(2)
    }))
})

for (const kind of ["failure", "defect"] as const) {
  it.effect(`journals stopped cleanup ${kind} and replays it without re-execution`, () =>
    withRestart((makeEngine, _runs, attempts) =>
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const started = yield* Deferred.make<void>()
        let executions = 0
        const cleanup = "stopped-journal-cleanup-failed"
        const action = Action.make({
          name: `StoppedJournal/${kind}`,
          error: Schema.String,
          execute: Effect.sync(() => {
            executions++
          }).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Effect.never),
            Effect.onExit(() => kind === "failure" ? Effect.fail(cleanup) : Effect.die(new Error(cleanup)))
          )
        })
        const flow = Flow.make(`StoppedJournalFlow/${kind}`, {
          payload: {},
          success: Schema.String,
          body: opaqueHandlerBody
        })
        const handler = () =>
          Effect.gen(function*() {
            const fiber = yield* Effect.forkChild(action)
            yield* Deferred.await(started)
            yield* Fiber.interrupt(fiber)
            const exit = yield* Fiber.await(fiber)
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isSuccess(exit)) return "unexpected success"
            expect(Cause.hasInterrupts(exit.cause)).toBe(true)
            expect(String(exit.cause)).toContain(cleanup)
            return String(exit.cause)
          })
        const engine = yield* makeEngine
        yield* engine.register(flow, handler)
        const options = { executionId: `stopped-journal-${kind}`, payload: {} }
        const result = yield* engine.execute(flow, options)
        expect(result).toContain(cleanup)
        yield* journal.flush
        const entries = yield* journal.entries({ runId: options.executionId as never, limit: 100 })
        const finished = entries.entries.filter((entry) => entry.eventType === "flows.engine.attempt-finished")
        expect(finished).toHaveLength(1)
        const attempt = finished[0]!.payload as { runId: string; stepKeyDigest: string; attempt: number; state: string }
        expect(attempt.state).toBe("failed")
        const recorded = Option.getOrThrow(yield* attempts.get(attempt))
        expect(JSON.stringify(recorded.error)).toContain(cleanup)
        expect(JSON.stringify(recorded.error)).toContain("Interrupt")
        const restarted = yield* makeEngine
        yield* restarted.register(flow, handler)
        expect(yield* restarted.execute(flow, options)).toEqual(result)
        expect(executions).toBe(1)
      })
    ))
}
