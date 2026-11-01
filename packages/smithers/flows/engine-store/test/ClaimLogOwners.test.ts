/**
 * The `flow.run.claimed` line names the incarnation that took the run and,
 * for a steal, the owner it took the run from and the evidence that let it.
 * Without them two live engines on one host id that each judge the other dead
 * (`Ownership.singleIncarnationLiveness`) log the same line as each takes the
 * run back, and nothing tells which engine holds it.
 */
import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { SqlJournal } from "@smthrs/journal"
import { Ownership, RunStore } from "@smthrs/run-store"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as References from "effect/References"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as Migrations from "../src/Migrations.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const TestFlow = Flow.make("ClaimLogOwners/Test", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const fakeEngine = {} as unknown as FlowRuntime.FlowRuntime["Service"]

const hostId = "claim-log-host"
/** The claiming driver: another incarnation of the dead owner's host. */
const self: Ownership.OwnerId = { hostId, pid: 7, nonce: "resumed" }

const services = Layer.mergeAll(
  SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
  RunStore.layer,
  DurableEngineState.layer
).pipe(Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer)))

type Services = Layer.Success<typeof services> | TestClock.TestClock | Crypto.Crypto | Scope.Scope

const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
  withCrypto(Effect.scoped(effect).pipe(Effect.provide(services), Effect.provide(TestClock.layer())))

/** A `running` row `owner` holds since `heartbeatAtMs`, as an engine whose host died leaves it. */
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

/** Executes `runId` on a driver that judges every other incarnation of its host dead; answers its claim lines. */
const claims = (runId: string, held?: Ownership.OwnerId) =>
  run(Effect.gen(function*() {
    const lines: Array<unknown> = []
    const capture = Logger.make((options) => {
      const message = Array.isArray(options.message) ? options.message[0] : options.message
      if (message === "flow.run.claimed") lines.push(options.fiber.getRef(References.CurrentLogAnnotations))
    })
    yield* TestClock.setTime(1_000)
    if (held !== undefined) yield* insertHeldRun(runId, held, 1_000)
    return yield* Effect.gen(function*() {
      const driver = yield* RunDriver.make({
        owner: self,
        journalSource: "claim-log-owners",
        isAlive: Ownership.singleIncarnationLiveness,
        engine: Effect.succeed(fakeEngine)
      })
      yield* driver.register(TestFlow, () => Effect.succeed("done"))
      const result = yield* driver.execute(TestFlow, { executionId: runId, payload: {}, discard: false })
      expect(result._tag).toBe("Complete")
      return lines
    }).pipe(Effect.provide(Logger.layer([capture])))
  }))

describe("the claim line names who took the run, and from whom", () => {
  it.effect("names the claiming incarnation, and no earlier owner, for a run nobody held", () =>
    Effect.gen(function*() {
      const lines = yield* claims("claim-log-fresh")

      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatchObject({ ownerHostId: hostId, ownerPid: self.pid })
      expect(lines[0]).not.toHaveProperty("stolenFromPid")
      expect(lines[0]).not.toHaveProperty("evidence")
    }))

  it.effect("names the incarnation a steal took the run from, and the evidence that admitted it", () =>
    Effect.gen(function*() {
      const earlier: Ownership.OwnerId = { hostId, pid: 424242, nonce: "cut-off" }
      const lines = yield* claims("claim-log-stolen", earlier)

      expect(lines).toEqual([
        expect.objectContaining({
          ownerHostId: hostId,
          ownerPid: self.pid,
          stolenFromHostId: hostId,
          stolenFromPid: earlier.pid,
          evidence: "same-host-pid-dead"
        })
      ])
    }))
})
