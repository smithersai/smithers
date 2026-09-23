import { describe, expect, it } from "@effect/vitest"
import * as Jj from "@smthrs/jj"
import * as Journal from "@smthrs/journal/Journal"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import { TestClock } from "effect/testing"
import * as CompensationHandlers from "../src/CompensationHandlers.ts"
import * as MemoryTimeTravelStore from "../src/MemoryTimeTravelStore.ts"
import { layerWith } from "../src/TimeTravel.ts"
import { TimeTravelStore } from "../src/TimeTravelStore.ts"

const dependencies = (store: TimeTravelStore["Service"]) =>
  Layer.mergeAll(
    Layer.succeed(TimeTravelStore, store),
    Layer.succeed(Jj.Jj, Jj.makeNoop({})),
    Layer.succeed(
      Journal.Journal,
      Journal.makeNoop({ entries: () => Effect.succeed({ entries: [], hasMore: false }) })
    ),
    Layer.succeed(RunStore.RunStore, RunStore.makeNoop({})),
    Layer.succeed(CacheStore.CacheStore, CacheStore.makeNoop())
  )

describe("TimeTravel compensation deadline", () => {
  for (const duration of [0, -1, Infinity, "invalid"] as Array<Duration.Input>) {
    it.effect(`refuses an invalid deadline ${duration} before scanning audits`, () =>
      Effect.gen(function*() {
        const store = { ...MemoryTimeTravelStore.make(), pendingAudits: () => Effect.die("must not scan") }
        const failure = yield* Effect.flip(Effect.scoped(
          Effect.void.pipe(
            Effect.provide(layerWith({ compensationTimeout: duration }).pipe(Layer.provide(dependencies(store))))
          )
        ))
        expect(failure).toMatchObject({
          code: "invalid",
          message: "compensationTimeout must be a finite positive duration"
        })
      }))
  }

  for (const duration of [0, -1, Infinity, "invalid"] as Array<Duration.Input>) {
    it.effect(`refuses an invalid recovery deadline ${duration} before scanning audits`, () =>
      Effect.gen(function*() {
        const store = { ...MemoryTimeTravelStore.make(), pendingAudits: () => Effect.die("must not scan") }
        const failure = yield* Effect.flip(Effect.scoped(
          Effect.void.pipe(
            Effect.provide(layerWith({ recoveryTimeout: duration }).pipe(Layer.provide(dependencies(store))))
          )
        ))
        expect(failure).toMatchObject({
          code: "invalid",
          message: "recoveryTimeout must be a finite positive duration"
        })
      }))
  }

  it.effect("recovers audits whose rollbacks together exceed one compensation deadline", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make()
      for (const id of ["first", "second"]) {
        yield* store.writeAudit({
          id,
          runId: id,
          frame: { lineageId: `${id}/root`, seq: 0 },
          status: "in_progress",
          detail: {
            version: 1,
            phase: "preflight_complete",
            originalStatus: "suspended",
            suffixCount: 1,
            warnings: [],
            cancelledChildren: [],
            compensation: {
              handlerReceipts: [{
                id: `${id}:receipt`,
                data: {},
                effect: {
                  id: `${id}:send`,
                  kind: "send",
                  tier: "irreversible",
                  status: "succeeded",
                  runId: id,
                  lineageId: `${id}/root`,
                  seq: 1,
                  durableBoundary: true,
                  providerStream: false
                }
              }]
            }
          }
        })
      }
      const runs = RunStore.makeNoop({
        get: (runId) =>
          Effect.succeed({
            runId,
            status: "suspended",
            owner: null,
            createdAtMs: 0,
            startedAtMs: null,
            heartbeatAtMs: null,
            claim: null,
            claimedAtMs: null,
            finishedAtMs: null,
            parentRunId: null,
            cancelRequestedAtMs: null,
            stateJson: "{}"
          }),
        claim: () => Effect.succeed({ _tag: "Claimed", claimedAtMs: 0 }),
        activate: () => Effect.succeed({ _tag: "Activated" }),
        heartbeat: () => Effect.succeed({ _tag: "Updated" }),
        transitionOwned: () => Effect.succeed({ _tag: "Transitioned" as const })
      })
      const rolledBack: Array<string> = []
      const handler = CompensationHandlers.layer([{
        kind: "send",
        tier: "irreversible",
        requiresIdempotencyKey: false,
        residue: () => "residue",
        revert: () => Effect.succeed({}),
        // Each rollback takes 60% of the one-second compensation deadline.
        rollback: (effect) =>
          Effect.sleep("600 millis").pipe(Effect.andThen(Effect.sync(() => rolledBack.push(effect.id))))
      }])
      const fiber = yield* Effect.forkChild(
        Effect.scoped(Effect.void.pipe(
          Effect.provide(
            layerWith({ compensationTimeout: "1 second" }).pipe(
              Layer.provide(handler),
              Layer.provide(Layer.succeed(RunStore.RunStore, runs)),
              Layer.provide(dependencies(store))
            )
          )
        )),
        { startImmediately: true }
      )
      for (let step = 0; step < 4; step += 1) yield* TestClock.adjust("300 millis")
      const result = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(result)).toBe(true)
      expect(rolledBack).toEqual(["first:send", "second:send"])
      expect(store.state().audits.map((audit) => audit.status)).toEqual(["failed", "failed"])
    }))

  it.effect("finishes startup and releases ownership when a rollback handler never completes", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make()
      yield* store.writeAudit({
        id: "stalled-rollback",
        runId: "run",
        frame: { lineageId: "run/root", seq: 0 },
        status: "in_progress",
        detail: {
          version: 1,
          phase: "preflight_complete",
          originalStatus: "suspended",
          suffixCount: 1,
          warnings: [],
          cancelledChildren: [],
          compensation: {
            handlerReceipts: [{
              id: "receipt",
              data: {},
              effect: {
                id: "send",
                kind: "send",
                tier: "irreversible",
                status: "succeeded",
                runId: "run",
                lineageId: "run/root",
                seq: 1,
                durableBoundary: true,
                providerStream: false
              }
            }]
          }
        }
      })
      const entered = yield* Deferred.make<void>()
      const stopped = yield* Deferred.make<void>()
      let released = false
      const runs = RunStore.makeNoop({
        get: () =>
          Effect.succeed({
            runId: "run",
            status: "suspended",
            owner: null,
            createdAtMs: 0,
            startedAtMs: null,
            heartbeatAtMs: null,
            claim: null,
            claimedAtMs: null,
            finishedAtMs: null,
            parentRunId: null,
            cancelRequestedAtMs: null,
            stateJson: "{}"
          }),
        claim: () => Effect.succeed({ _tag: "Claimed", claimedAtMs: 0 }),
        activate: () => Effect.succeed({ _tag: "Activated" }),
        transitionOwned: () =>
          Effect.sync(() => {
            released = true
            return { _tag: "Transitioned" as const }
          })
      })
      const handler = CompensationHandlers.layer([{
        kind: "send",
        tier: "irreversible",
        requiresIdempotencyKey: false,
        residue: () => "residue",
        revert: () => Effect.succeed({}),
        rollback: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(stopped, undefined))
          )
      }])
      const fiber = yield* Effect.forkChild(
        Effect.scoped(Effect.void.pipe(
          Effect.provide(
            layerWith({ compensationTimeout: "1 second" }).pipe(
              Layer.provide(handler),
              Layer.provide(Layer.succeed(RunStore.RunStore, runs)),
              Layer.provide(dependencies(store))
            )
          )
        )),
        { startImmediately: true }
      )
      yield* Deferred.await(entered)
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.await(fiber)
      expect(released).toBe(true)
      expect(yield* Deferred.isDone(stopped)).toBe(true)
      expect(store.state().audits[0]).toMatchObject({
        status: "failed",
        detail: { phase: "terminal_failure" }
      })
    }))

  for (const configured of [false, true]) {
    it.effect(`bounds startup recovery with the ${configured ? "configured" : "default"} deadline`, () =>
      Effect.gen(function*() {
        const entered = yield* Deferred.make<void>()
        const stopped = yield* Deferred.make<void>()
        const store = {
          ...MemoryTimeTravelStore.make(),
          pendingAudits: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(stopped, undefined))
            )
        }
        const fiber = yield* Effect.forkChild(
          Effect.scoped(
            Effect.void.pipe(Effect.provide(
              layerWith(configured ? { recoveryTimeout: "1 second" } : {}).pipe(
                Layer.provide(dependencies(store))
              )
            ))
          ),
          { startImmediately: true }
        )
        yield* Deferred.await(entered)
        yield* TestClock.adjust(configured ? "2 seconds" : "30 minutes")
        const result = yield* Fiber.await(fiber)
        expect(result._tag).toBe("Failure")
        if (Exit.isFailure(result)) {
          expect(Cause.squash(result.cause)).toMatchObject({
            code: "compensation_failed",
            message: "startup recovery exceeded its deadline",
            cause: { _tag: "TimeoutError" }
          })
        }
        expect(yield* Deferred.isDone(stopped)).toBe(true)
      }))
  }
})
