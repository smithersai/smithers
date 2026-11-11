/**
 * The shared consensus conformance contract instantiated for the in-memory
 * single-process strategy — the browser-safe default for tests and local
 * embedding.
 */
import { expect, it } from "@effect/vitest"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Deferred, Effect, Fiber, Layer } from "effect"
import * as Consensus from "../src/Consensus.ts"
import { conformance } from "./ConsensusConformance.ts"

conformance("Consensus.layerLocal", Consensus.layerLocal)

it.effect("noop consensus refuses lease reconfirm without an owner", () =>
  Effect.gen(function*() {
    const consensus = yield* Consensus.Consensus
    expect(yield* consensus.reconfirm("unowned", { hostId: "host", pid: 1, nonce: "owner" }, 0))
      .toEqual({ _tag: "Lost" })
  }).pipe(Effect.provide(Consensus.layerNoop())))

it.effect("undoes each lease change with the managed write that made it", () =>
  Effect.gen(function*() {
    const consensus = yield* Consensus.Consensus
    const writer = yield* DurableWriter.DurableWriter
    const ownerA = { hostId: "host", pid: 1, nonce: "owner-a" }
    const ownerB = { hostId: "host", pid: 2, nonce: "owner-b" }
    const rolledBack = <A, E>(change: Effect.Effect<A, E>) =>
      Effect.exit(writer.write(Effect.andThen(change, Effect.fail("rolled back"))))

    // A claim on a run with no lease rolls back to no lease at all.
    yield* rolledBack(consensus.claim("run", ownerA, 0))
    expect(yield* consensus.claim("run", ownerB, 1)).toEqual({ _tag: "Claimed", grantedAtMs: 1 })

    // Changes to an existing lease roll back, newest first, to the claim.
    yield* rolledBack(Effect.gen(function*() {
      expect(yield* consensus.activate("run", ownerB, 1, 2)).toEqual({ _tag: "Activated" })
      expect(yield* consensus.heartbeat("run", ownerB, 3)).toEqual({ _tag: "Renewed", heartbeatAtMs: 3 })
    }))
    expect(yield* consensus.heartbeat("run", ownerB, 4)).toEqual({ _tag: "Lost" })
    expect(yield* consensus.activate("run", ownerB, 1, 5)).toEqual({ _tag: "Activated" })

    // A committed change stands.
    yield* writer.write(consensus.heartbeat("run", ownerB, 6))
    yield* rolledBack(consensus.release("run", ownerB))
    expect(yield* consensus.heartbeat("run", ownerB, 0)).toEqual({ _tag: "Renewed", heartbeatAtMs: 6 })
  }).pipe(Effect.provide(Layer.merge(Consensus.layerLocal, TestDatabase.layer))))

it.effect("never reverts a lease change another fiber made outside the rolled-back write", () =>
  Effect.gen(function*() {
    const consensus = yield* Consensus.Consensus
    const writer = yield* DurableWriter.DurableWriter
    const ownerA = { hostId: "host", pid: 1, nonce: "owner-a" }
    const ownerB = { hostId: "host", pid: 2, nonce: "owner-b" }
    // Inside a write, `change` runs, then a fiber outside every write
    // releases B's lease, then the write rolls back.
    const releasedDuring = <A, E>(change: Effect.Effect<A, E>) =>
      Effect.gen(function*() {
        const go = yield* Deferred.make<void>()
        const outside = yield* Deferred.await(go).pipe(
          Effect.andThen(consensus.release("run", ownerB)),
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.exit(writer.write(Effect.gen(function*() {
          yield* change
          yield* Deferred.succeed(go, undefined)
          yield* Fiber.join(outside)
          return yield* Effect.fail("rolled back")
        })))
      })
    const ownedByB = Effect.gen(function*() {
      yield* consensus.claim("run", ownerB, 0)
      yield* consensus.activate("run", ownerB, 0, 0)
    })

    // A refused claim changed nothing, so it has nothing to undo.
    yield* ownedByB
    yield* releasedDuring(consensus.claim("run", ownerA, 1))
    expect(yield* consensus.heartbeat("run", ownerB, 2)).toEqual({ _tag: "Lost" })

    // A change the outside release replaced is not restored over it.
    yield* ownedByB
    yield* releasedDuring(consensus.heartbeat("run", ownerB, 3))
    expect(yield* consensus.heartbeat("run", ownerB, 4)).toEqual({ _tag: "Lost" })
    expect(yield* consensus.claim("run", ownerA, 5)).toEqual({ _tag: "Claimed", grantedAtMs: 5 })
  }).pipe(Effect.provide(Layer.merge(Consensus.layerLocal, TestDatabase.layer))))
