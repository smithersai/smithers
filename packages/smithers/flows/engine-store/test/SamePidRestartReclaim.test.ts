import type * as SecureRandom from "effect/crypto/SecureRandom"
/**
 * Pins issue #4998: a Node host restarted under its crashed predecessor's
 * pid never reclaimed that predecessor's runs.
 *
 * A container entry point gets the same pid on every start, so the restarted
 * host's owner differs from the crashed one's only by `nonce`. The default
 * liveness check `NodeRuntime.layerHost` installs, `HostLiveness.isAlive`,
 * signalled the recorded pid, found the restarted host itself, and refused
 * the steal on every sweep for as long as the host ran.
 *
 * The case leaves the row a crash leaves in this very process: `running`
 * under `{ hostId, pid: process.pid, nonce: <old> }` with a heartbeat that
 * stopped. A new driver with the same host id and pid and the default probe,
 * asking the real process table, must take the run once the lease expired.
 */
import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { SqlJournal } from "@smthrs/journal"
import * as HostLiveness from "@smthrs/platform-node/HostLiveness"
import { Ownership, RunStore } from "@smthrs/run-store"
import type * as EffectDigest from "effect/crypto/Digest"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as Migrations from "../src/Migrations.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const RestartFlow = Flow.make("SamePidRestartReclaim/Restart", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const fakeEngine = {} as unknown as FlowRuntime.FlowRuntime["Service"]

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

const hostId = "container-host"
const staleAfterMs = Duration.toMillis(Ownership.heartbeatStaleAfter)
const heartbeatMs = Duration.toMillis(Ownership.heartbeatInterval)

describe("a host restarted under the same pid (issue #4998)", () => {
  it.effect("reclaims the crashed incarnation's running run with the default Node probe", () =>
    run(Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const runId = "same-pid-restart"
      const crashed: Ownership.OwnerId = { hostId, pid: process.pid, nonce: "crashed-incarnation" }
      yield* store.create(
        runId,
        JSON.stringify({ version: 1, flowName: RestartFlow._tag, payload: {}, capabilityCeilings: [[]] })
      )
      const claimed = yield* store.claimAndOwn(
        runId,
        { status: "pending", owner: null, heartbeatAtMs: null },
        crashed,
        0
      )
      expect(claimed._tag).toBe("Activated")

      // The crashed incarnation's heartbeat stopped at 0; the restart starts
      // after its lease expired, under the same host id and the same pid.
      yield* TestClock.setTime(staleAfterMs + heartbeatMs)
      const driver = yield* RunDriver.make({
        owner: { hostId, pid: process.pid, nonce: "restarted-incarnation" },
        journalSource: "same-pid-restart",
        isAlive: HostLiveness.isAlive({ hostId }),
        engine: Effect.succeed(fakeEngine)
      })
      yield* driver.register(RestartFlow, () => Effect.succeed("reclaimed"))

      let row = yield* store.get(runId)
      for (let tick = 0; tick < 200 && row.status !== "completed"; tick++) {
        yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 2)))
        yield* TestClock.adjust(heartbeatMs)
        row = yield* store.get(runId)
      }
      expect(row.status).toBe("completed")
      expect(row.owner).toBeNull()
    })))
})
