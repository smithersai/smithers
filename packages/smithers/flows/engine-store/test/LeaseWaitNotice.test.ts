import type * as SecureRandom from "effect/crypto/SecureRandom"
/**
 * Issue #3897: a run held by another owner is taken at once when a same-host
 * probe proves that owner's process gone, and otherwise waits with one logged
 * line saying why and for how long.
 *
 * `ReclaimedAttemptCache` covers the shape a SIGKILL leaves with real child
 * processes. These cases write the held row directly, so each owner relation
 * the driver distinguishes is one row: no probe, this process's own pid, and
 * a probe that proves death. The test clock stands on the row's heartbeat, so
 * every lease is fresh.
 */
import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Journal, SqlJournal } from "@smthrs/journal"
import { Ownership, RunStore } from "@smthrs/run-store"
import type * as EffectDigest from "effect/crypto/Digest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as Migrations from "../src/Migrations.vibe"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const TestFlow = Flow.make("LeaseWaitNotice/Test", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const fakeEngine = {} as unknown as FlowRuntime.FlowRuntime["Service"]

const hostId = "notice-host"
/** The driver's own identity: pid 7 stands for this process. */
const self: Ownership.OwnerId = { hostId, pid: 7, nonce: "survivor" }

const services = Layer.mergeAll(
  SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
  RunStore.layer,
  DurableEngineState.layer
).pipe(Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer)))

type Services =
  | Layer.Success<typeof services>
  | TestClock.TestClock
  | (EffectDigest.Digest | SecureRandom.SecureRandom)
  | Scope.Scope

const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
  withCrypto(Effect.scoped(effect).pipe(Effect.provide(services), Effect.provide(TestClock.layer())))

/**
 * A `running` row held by `owner` since `heartbeatAtMs`, as a killed process
 * leaves it: created as an engine creates a root run, then claimed and owned
 * through the public store contract. The test clock must read `heartbeatAtMs`.
 */
const insertHeldRun = (runId: string, owner: Ownership.OwnerId, heartbeatAtMs: number) =>
  Effect.gen(function*() {
    const store = yield* RunStore.RunStore
    yield* store.create(
      runId,
      JSON.stringify({ version: 1, flowName: TestFlow._tag, payload: {}, capabilityCeilings: [[]] }),
      { lineageId: runId, roundOrdinal: 0 }
    )
    const owned = yield* store.claimAndOwn(
      runId,
      { status: "pending", owner: null, heartbeatAtMs: null },
      owner,
      heartbeatAtMs
    )
    expect(owned._tag).toBe("Activated")
  }).pipe(Effect.orDie)

/** The engine decisions journaled for one run. */
const decisionsOf = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* journal.flush
    const entries = yield* journal.entries({ runId: runId as never, limit: 200 })
    return entries.entries
      .filter((entry) => entry.eventType === "flows.engine.run-decision")
      .map((entry) => entry.payload as { readonly decision: string; readonly evidence?: string })
  })

/**
 * Asks a driver with `isAlive` to execute a run `owner` holds, twice, and
 * reports what it answered, what it logged, and who holds the row after.
 */
const rerun = (
  runId: string,
  owner: Ownership.OwnerId,
  heartbeatAtMs: number,
  isAlive?: Ownership.LivenessCheck
) =>
  run(Effect.gen(function*() {
    const logs: Array<string> = []
    const capture = Logger.make(({ message }) => {
      logs.push((Array.isArray(message) ? message : [message]).map(String).join(" "))
    })
    const store = yield* RunStore.RunStore
    yield* TestClock.setTime(heartbeatAtMs)
    yield* insertHeldRun(runId, owner, heartbeatAtMs)
    return yield* Effect.gen(function*() {
      const driver = yield* RunDriver.make({
        owner: self,
        journalSource: "lease-wait-notice",
        ...(isAlive === undefined ? {} : { isAlive }),
        engine: Effect.succeed(fakeEngine)
      })
      yield* driver.register(TestFlow, () => Effect.succeed("reclaimed"))
      const execute = driver.execute(TestFlow, { executionId: runId, payload: {}, discard: false })
      const first = yield* execute
      const second = yield* execute
      const row = yield* store.get(runId)
      return {
        results: [first._tag, second._tag],
        logs,
        status: row.status,
        owner: row.owner,
        decisions: yield* decisionsOf(runId)
      }
    }).pipe(Effect.provide(Logger.layer([capture])))
  }))

const stolen = expect.objectContaining({ decision: "stolen-and-activated" })

describe("a held run is taken at once or waited on out loud (issue #3897)", () => {
  it.effect("takes a fresh lease at once when the probe proves a same-host pid gone", () =>
    Effect.gen(function*() {
      const dead: Ownership.OwnerId = { hostId, pid: 424242, nonce: "killed" }
      const result = yield* rerun("notice-dead", dead, 1_000, () => Effect.succeed(false))

      expect(result.results[0]).toBe("Complete")
      expect(result.status).toBe("completed")
      expect(result.decisions).toContainEqual(
        expect.objectContaining({ decision: "stolen-and-activated", evidence: "same-host-pid-dead" })
      )
      expect(result.logs.filter((line) => line.includes("waiting"))).toEqual([])
    }))

  it.effect("waits out the lease when no probe is configured, and says so once", () =>
    Effect.gen(function*() {
      const killed: Ownership.OwnerId = { hostId, pid: 424242, nonce: "killed" }
      const result = yield* rerun("notice-no-probe", killed, 1_000)

      expect(result.results).toEqual(["Suspended", "Suspended"])
      expect(result.status).toBe("running")
      expect(result.owner).toEqual(killed)
      expect(result.decisions).not.toContainEqual(stolen)
      expect(result.logs.filter((line) => line.includes("waiting"))).toEqual([
        `engine-store: run notice-no-probe is held by ${hostId}:424242, which no liveness probe checks; waiting up to 30 s for its lease to expire`
      ])
    }))

  it.effect("never proves this process's own pid gone, whatever the probe answers", () =>
    Effect.gen(function*() {
      const earlier: Ownership.OwnerId = { hostId, pid: self.pid, nonce: "earlier-engine" }
      const result = yield* rerun("notice-own-pid", earlier, 1_000, () => Effect.succeed(false))

      expect(result.results).toEqual(["Suspended", "Suspended"])
      expect(result.owner).toEqual(earlier)
      expect(result.decisions).not.toContainEqual(stolen)
      expect(result.logs.filter((line) => line.includes("waiting"))).toEqual([
        `engine-store: run notice-own-pid is held by ${hostId}:${self.pid}, an earlier owner in this process; waiting up to 30 s for its lease to expire`
      ])
    }))
})
