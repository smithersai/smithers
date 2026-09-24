import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { FlowEngine } from "@smthrs/engine"
import { DurableEngineState, EngineStore, OwnerIdentity, StepBoundary } from "@smthrs/engine-store"
import * as Migrations from "@smthrs/engine-store/Migrations"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Journal, SqlJournal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { AttemptStore, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"

/**
 * The one sealed atom the fork replays. It is a DECLARED action, so the same
 * value addresses the recorded result in the parent's composition and in the
 * restarted one; only the implementation is attached per composition.
 */
const ForkOnce = Action.make("fork-once", {
  payload: {},
  success: Schema.String,
  tier: "sealed",
  idempotencyKey: "fork-execution-v1"
})

const ForkFlow = Flow.make("TimeTravel/ExecutableFork", {
  payload: {},
  success: Schema.String,
  body: (payload) => ForkOnce.call(payload)
})

const jj = Jj.make({
  snapshot: () => Effect.succeed({ commitId: "fork-execution" as never, changeId: "fork-execution" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

const requirements = (filename: string, sharedCache: boolean) => {
  const database = Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
  const migratedDatabase = Layer.provideMerge(Migrations.layer, database)
  const sqlServices = Layer.provideMerge(
    Layer.mergeAll(
      AttemptStore.layer,
      CacheStore.layer,
      RunStore.layer,
      DurableEngineState.layer,
      SqlJournal.layer({ capacity: 64, overflow: "reject" })
    ),
    migratedDatabase
  )
  // NodeCrypto feeds the merged stack rather than sitting beside it:
  // OwnerIdentity.layer consumes the Crypto service at construction.
  return Layer.mergeAll(
    sqlServices,
    StepBoundary.layerTest(),
    OwnerIdentity.layer,
    Layer.succeed(Jj.Jj, jj),
    // Copied attempt digests still name the parent. Only an explicitly
    // shared sealed cache identity avoids re-executing the prefix here.
    sharedCache ? Action.layerCacheEnvironment({ layers: [], capabilities: {} }) : Layer.empty
  ).pipe(Layer.provideMerge(NodeCrypto.layer))
}

describe("SQL fork execution", () => {
  it.effect.each([
    { sharedCache: false, behavior: "run-scoped prefix re-execution" },
    { sharedCache: true, behavior: "shared cache reuse" }
  ])("drives a fork after restart with $behavior", ({ sharedCache }) =>
    Effect.gen(function*() {
      const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "flows-fork-execution-")))
      const filename = join(directory, "fork.sqlite")
      let dispatches = 0
      /** The implementation, plus the body that names it, over one table. */
      const wiring = (engine: FlowRuntime.FlowRuntime["Service"]) =>
        Layer.mergeAll(
          ForkOnce.toLayer(() =>
            Effect.sync(() => {
              dispatches++
              return "action-result"
            })
          ),
          Interpreter.layer(ForkFlow)
        ).pipe(
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
        )

      try {
        const created = yield* (
          Effect.scoped(
            Effect.gen(function*() {
              const engine = yield* EngineStore.make({
                owner: { hostId: "fork-parent" },
                journalSource: "fork-execution",
                isAlive: () => Effect.succeed(false)
              })
              const parentResult = yield* ForkFlow.execute({}, { executionId: "fork-parent" }).pipe(
                Effect.provide(wiring(engine))
              )
              const journal = yield* Journal.Journal
              yield* journal.flush
              const sql = yield* Effect.service(SqlClient.SqlClient)
              const maximum = yield* sql<{ readonly seq: number | null }>`
              SELECT MAX(seq) AS seq
              FROM flows_journal_events
              WHERE run_id = 'fork-parent'
            `
              const store = yield* SqlTimeTravelStore.make
              // The frame's lineage comes from the constructor that mints it. Re-derived on
              // 2026-09-01: `FlowEngine.Lineage` moved the root address from `<runId>/root`
              // to a versioned encoded tuple, so the old literal named a lineage the engine
              // no longer writes.
              const fork = yield* store.createFork("fork-parent", {
                lineageId: FlowEngine.Lineage.root("fork-parent"),
                seq: maximum[0]?.seq ?? 0
              })
              const states = yield* sql<{ readonly run_id: string; readonly state_json: string }>`
              SELECT run_id, state_json
              FROM flows_runs
              WHERE run_id IN ('fork-parent', ${fork.runId})
              ORDER BY run_id
            `
              const attempts = yield* sql<{ readonly run_id: string; readonly count: number }>`
              SELECT run_id, COUNT(*) AS count
              FROM flows_attempts
              WHERE run_id IN ('fork-parent', ${fork.runId})
              GROUP BY run_id
              ORDER BY run_id
            `
              return { fork, parentResult, states, attempts }
            }).pipe(Effect.provide(requirements(filename, sharedCache)))
          )
        )

        const childState = JSON.parse(
          created.states.find((row) => row.run_id === created.fork.runId)!.state_json
        ) as Record<string, unknown>
        const parentState = JSON.parse(
          created.states.find((row) => row.run_id === "fork-parent")!.state_json
        ) as Record<string, unknown>
        expect(created.parentResult).toBe("action-result")
        expect(parentState.result).toEqual({
          _tag: "Complete",
          exit: { _tag: "Success", value: "action-result" }
        })
        expect(childState).toMatchObject({
          version: 1,
          flowName: ForkFlow._tag,
          payload: {}
        })
        expect(childState).not.toHaveProperty("result")
        expect(childState).not.toHaveProperty("cancellation")
        expect(created.attempts).toEqual([
          { run_id: "fork-parent", count: 1 },
          { run_id: created.fork.runId, count: 1 }
        ])

        const restarted = yield* (
          Effect.scoped(
            Effect.gen(function*() {
              const engine = yield* EngineStore.make({
                owner: { hostId: "fork-restart" },
                journalSource: "fork-execution",
                isAlive: () => Effect.succeed(false)
              })
              const value = yield* ForkFlow.execute({}, { executionId: created.fork.runId }).pipe(
                Effect.provide(wiring(engine))
              )
              const row = yield* (yield* RunStore.RunStore).get(created.fork.runId)
              return { value, row }
            }).pipe(Effect.provide(requirements(filename, sharedCache)))
          )
        )

        expect(restarted.value).toBe("action-result")
        expect(restarted.row.status).toBe("completed")
        expect(dispatches).toBe(sharedCache ? 1 : 2)
      } finally {
        yield* Effect.promise(() => rm(directory, { recursive: true, force: true }))
      }
    }), 15_000)
})
