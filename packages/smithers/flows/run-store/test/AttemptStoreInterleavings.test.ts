import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Deferred, Effect, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import * as AttemptStore from "../src/AttemptStore.vibe"
import * as Migrations from "../src/Migrations.vibe"
import type { OwnerId } from "../src/Ownership.vibe"
import * as RunStore from "../src/RunStore.vibe"

const ownerA: OwnerId = { hostId: "attempt-host", pid: 1, nonce: "old-owner" }
const ownerB: OwnerId = { hostId: "attempt-host", pid: 2, nonce: "new-owner" }
const id: AttemptStore.AttemptId = { runId: "interleaving-run", stepKeyDigest: "step", attempt: 0 }

const layer = Layer.mergeAll(RunStore.layer, AttemptStore.layer).pipe(
  Layer.provide(Layer.provideMerge(Migrations.layer, TestDatabase.layer))
)

const migrated = <A, E>(
  effect: Effect.Effect<A, E, RunStore.RunStore | AttemptStore.AttemptStore>
) => effect.pipe(Effect.provide(layer), Effect.provide(TestClock.layer()), Effect.scoped)

const arrange = Effect.gen(function*() {
  const runs = yield* RunStore.RunStore
  const attempts = yield* AttemptStore.AttemptStore
  yield* runs.create(id.runId, "{}")
  expect(
    yield* runs.claimAndOwn(
      id.runId,
      { status: "pending", owner: null, heartbeatAtMs: null },
      ownerA,
      0
    )
  ).toEqual({ _tag: "Activated" })
  expect(
    yield* attempts.put({
      ...id,
      state: "running",
      startedAtMs: 10,
      outcome: { writer: "old", phase: "running" },
      meta: { writer: "old" }
    }, ownerA)
  ).toEqual({ _tag: "Inserted" })
  const stale = yield* runs.get(id.runId)
  yield* TestClock.adjust("30001 millis")
  expect(
    yield* runs.claimAndOwn(
      id.runId,
      { status: stale.status, owner: stale.owner, heartbeatAtMs: stale.heartbeatAtMs },
      ownerB,
      30_001,
      {
        expectedOwner: ownerA,
        checkedAtMs: 30_001,
        kind: "same-host-pid-dead"
      }
    )
  ).toEqual({ _tag: "Activated" })
  return { attempts, runs }
})

describe("AttemptStore ownership interleavings", () => {
  it.effect("fences an old owner's finish while the takeover owner completes the attempt", () =>
    Effect.gen(function*() {
      const result = yield* migrated(
        Effect.gen(function*() {
          const { attempts } = yield* arrange
          const finish = (writer: string, owner: OwnerId) =>
            attempts.finish({
              ...id,
              state: "completed",
              finishedAtMs: 40,
              outcome: { writer }
            }, owner)
          const [oldOwner, newOwner] = yield* Effect.all(
            [finish("old", ownerA), finish("new", ownerB)],
            { concurrency: "unbounded" }
          )
          return {
            newOwner,
            oldOwner,
            stored: Option.getOrThrow(yield* attempts.get(id))
          }
        })
      )

      expect(result.oldOwner).toEqual({ _tag: "FenceLost" })
      expect(result.newOwner).toEqual({ _tag: "Finished" })
      expect(result.stored).toMatchObject({ state: "completed", outcome: { writer: "new" } })
    }))

  for (const first of ["run", "attempt"] as const) {
    it.effect(`pins the run-terminal/attempt-terminal race when ${first} finishes first`, () =>
      Effect.gen(function*() {
        const result = yield* migrated(
          Effect.gen(function*() {
            const { attempts, runs } = yield* arrange
            const before = Option.getOrThrow(yield* attempts.get(id))
            expect(before).toEqual({
              ...id,
              state: "running",
              startedAtMs: 10,
              outcome: { writer: "old", phase: "running" },
              meta: { writer: "old" }
            })
            const finished = {
              ...id,
              state: "completed",
              finishedAtMs: 50,
              outcome: { writer: "new" },
              meta: { writer: "new", terminal: true }
            }
            // Release the second write only after the first has committed,
            // exercising both serializations without relying on scheduling.
            const firstDone = yield* Deferred.make<void>()
            const [runTransition, attemptFinish] = yield* Effect.all(
              [
                Effect.gen(function*() {
                  if (first === "attempt") yield* Deferred.await(firstDone)
                  const transition = yield* runs.transitionOwned(id.runId, ownerB, "completed", "{\"terminal\":true}")
                  if (first === "run") yield* Deferred.succeed(firstDone, undefined)
                  return transition
                }),
                Effect.gen(function*() {
                  if (first === "run") yield* Deferred.await(firstDone)
                  const finish = yield* attempts.finish(finished, ownerB)
                  if (first === "attempt") yield* Deferred.succeed(firstDone, undefined)
                  return finish
                })
              ],
              { concurrency: "unbounded" }
            )
            return {
              attempt: Option.getOrThrow(yield* attempts.get(id)),
              attemptFinish,
              before,
              finished,
              run: yield* runs.get(id.runId),
              runTransition
            }
          })
        )

        expect(result.runTransition).toEqual({ _tag: "Transitioned" })
        expect(result.run.status).toBe("completed")
        if (first === "attempt") {
          expect(result.attempt).toEqual({ ...result.before, ...result.finished })
          expect(result.attemptFinish).toEqual({ _tag: "Finished" })
        } else {
          expect(result.attempt).toStrictEqual(result.before)
          expect(result.attempt).not.toHaveProperty("finishedAtMs")
          expect(result.attemptFinish).toEqual({ _tag: "FenceLost" })
        }
      }))
  }

  // `patch` is fenced on run ownership like every other write: a delayed
  // patch from the pre-takeover owner arrives after the takeover owner
  // finished the attempt and completed the run, so the run's owner columns
  // are cleared and the fence refuses it — the opaque terminal outcome the
  // engine replays verbatim is never rewritten.
  it.effect("refuses an old worker's patch after takeover and terminal transition", () =>
    Effect.gen(function*() {
      const result = yield* migrated(
        Effect.gen(function*() {
          const { attempts, runs } = yield* arrange
          yield* attempts.finish({
            ...id,
            state: "completed",
            finishedAtMs: 50,
            outcome: { writer: "new", terminal: true }
          }, ownerB)
          yield* runs.transitionOwned(id.runId, ownerB, "completed")
          // The delayed write carries the old worker's own token, and the
          // fence — not the caller's honesty — is what refuses it.
          const patch = yield* attempts.patch(id, {
            outcome: { writer: "old", terminal: false },
            meta: { writer: "delayed-old" }
          }, ownerA)
          // The terminal transition cleared the owner columns, so even the
          // owner that won the takeover cannot patch the settled row.
          const patchByWinner = yield* attempts.patch(id, { meta: { writer: "late-new" } }, ownerB)
          return { patch, patchByWinner, stored: Option.getOrThrow(yield* attempts.get(id)) }
        })
      )

      expect(result.patch).toEqual({ _tag: "FenceLost" })
      expect(result.patchByWinner).toEqual({ _tag: "FenceLost" })
      expect(result.stored).toMatchObject({
        state: "completed",
        outcome: { writer: "new", terminal: true },
        meta: { writer: "old" }
      })
    }))
})
