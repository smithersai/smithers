import { executeUntilParked } from "./ExecuteUntilParked.ts"
/**
 * Issue #2290: an unkeyed irreversible action left in flight leaves an
 * unresolved crossing. The engine that next drives the run refuses to
 * dispatch that action again, and the refusal settles the run as a defect
 * that keeps its tagged fields rather than the generic defect codec's name and
 * message.
 *
 * Two ways to leave it in flight, each on its own SQLite file with one store
 * bundle per process:
 *
 * - released: the first process's scope closes, which interrupts the charge
 *   and releases the run (`suspended`, no owner); the next engine re-drives it.
 * - killed: the first process is frozen mid-charge and its committed state is
 *   copied with `VACUUM INTO`, which is the disk a SIGKILL leaves: a `running`
 *   row and lease under the dead owner and a `running` attempt whose crossing
 *   is `intended`. No finalizer has touched the copy, so the next engine has to
 *   steal the run before it can refuse.
 */
import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Action, Flow } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import * as PersistentDatabase from "./fixtures/PersistentDatabase.ts"
import { withCrypto } from "./Sha256.ts"

const ChargeFlow = Flow.make("IrreversibleRestartRefusal/Flow", {
  payload: {},
  success: Schema.String,
  error: Schema.String,
  body: opaqueHandlerBody
})

const jj = Jj.make({
  snapshot: () => Effect.succeed({ commitId: "engine-pre-image" as never, changeId: "engine-pre-image" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

const run = (executionId: string, end: "released" | "killed") =>
  Effect.gen(function*() {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "irreversible-restart-"))),
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true }))
    )
    // A killed process's disk is copied with `VACUUM INTO`, so that case stays on SQLite.
    const filename = end === "killed" ?
      join(directory, "engine.sqlite") :
      yield* PersistentDatabase.scoped(join(directory, "engine.sqlite"))
    const killed = join(directory, "killed.sqlite")
    const dispatches = { count: 0 }
    // The first dispatch never settles: its process ends mid-charge. A second
    // dispatch would charge again.
    const charge = Action.make({
      name: `${executionId}-charge`,
      success: Schema.String,
      error: Schema.String,
      tier: "irreversible",
      execute: Effect.suspend(() => ++dispatches.count === 1 ? Effect.never : Effect.succeed("charged again"))
    })
    const makeEngine = EngineStore.make({
      owner: { hostId: "irreversible-restart-host" },
      journalSource: "irreversible-restart-test",
      isAlive: () => Effect.succeed(false)
    })

    // First process: the charge is in flight when it ends.
    yield* Effect.scoped(Effect.gen(function*() {
      const engine = yield* makeEngine
      yield* engine.register(ChargeFlow, () => charge)
      yield* executeUntilParked(engine, ChargeFlow, { executionId, payload: {}, discard: true }).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* TestDatabase.until(Effect.sync(() => dispatches.count >= 1))
      if (end === "killed") yield* (yield* SqlClient.SqlClient)`VACUUM INTO ${killed}`.pipe(Effect.orDie)
    })).pipe(Effect.provide(TestStores.layerAt(filename)))

    // Second process: a fresh engine over what the first one left on disk.
    return yield* Effect.scoped(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const store = yield* RunStore.RunStore
      const left = {
        status: (yield* store.get(executionId)).status,
        attempts: yield* sql<{ readonly state: string; readonly meta_json: string }>`
          SELECT state, meta_json FROM flows_attempts WHERE run_id = ${executionId}
        `.pipe(
          Effect.orDie,
          Effect.map((rows) =>
            rows.map((row) => ({ state: row.state, effectCrossing: JSON.parse(row.meta_json).effectCrossing }))
          )
        )
      }
      const engine = yield* makeEngine
      yield* engine.register(ChargeFlow, () => charge)
      const fiber = yield* executeUntilParked(engine, ChargeFlow, { executionId, payload: {}, discard: true }, [
        "completed",
        "failed"
      ]).pipe(Effect.forkChild({ startImmediately: true }))
      yield* TestDatabase.until(
        TestClock.adjust("1 second").pipe(Effect.map(() => fiber.pollUnsafe() !== undefined))
      )
      yield* Fiber.await(fiber)
      return { left, dispatches: dispatches.count, row: yield* store.get(executionId) }
    })).pipe(Effect.provide(TestStores.layerAt(end === "killed" ? killed : filename)))
  }).pipe(
    Effect.scoped,
    Effect.provideService(Jj.Jj, jj),
    Effect.provide(StepBoundary.layerTest()),
    Effect.provide(TestClock.layer()),
    withCrypto
  )

const expectRefused = (result: Effect.Success<ReturnType<typeof run>>, actionName: string) => {
  expect(result.dispatches).toBe(1)
  expect(result.row.status).toBe("failed")
  const exit = JSON.parse(result.row.stateJson).result.exit
  expect(exit._tag).toBe("Failure")
  expect(exit.cause).toEqual([{
    _tag: "Die",
    defect: {
      _tag: "@smthrs/flow/IrreversibleRetryRequiresIdempotencyKey",
      code: "irreversible_retry_requires_idempotency_key",
      actionName,
      attempt: 1
    }
  }])
}

describe("an unkeyed irreversible action left in flight", () => {
  it.effect("fails the re-driven released run with the tagged refusal instead of charging again", () =>
    Effect.gen(function*() {
      const result = yield* run("irreversible-released", "released")

      expect(result.left.status).toBe("suspended")
      expectRefused(result, "irreversible-released-charge")
    }))

  it.effect("fails the run stolen from a killed owner with the tagged refusal instead of charging again", () =>
    Effect.gen(function*() {
      const result = yield* run("irreversible-killed", "killed")

      // The hard-kill state no scope close can produce.
      expect(result.left).toEqual({
        status: "running",
        attempts: [{ state: "running", effectCrossing: "intended" }]
      })
      expectRefused(result, "irreversible-killed-charge")
    }))
})
