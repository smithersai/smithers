/**
 * The host's TTL pass as a durable poll: `MemoryTtlGc.start` over a real
 * engine store, a real memory store and a test clock.
 */
import { NodeCrypto } from "@effect/platform-node"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { EngineStore, StepBoundary } from "@smthrs/engine-store"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import { FlowRuntime } from "@smthrs/flow"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
import { MemoryError } from "@smthrs/memory/MemoryError"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as TestMemory from "@smthrs/memory/test/TestMemory"
import { RunStore } from "@smthrs/run-store"
import { Context, Deferred, Effect, Layer, Logger, type Scope } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import * as MemoryTtlGc from "../src/internal/MemoryTtlGc.ts"
import { platform } from "../src/internal/NodeControlHost.ts"
import * as SupervisorMemory from "../src/internal/SupervisorMemory.ts"

const namespace = { kind: "flow", id: "ttl-gc" } as const

const engineAt = (filename: string) =>
  EngineStore.layer({ owner: { hostId: "memory-ttl-gc" }, journalSource: "memory-ttl-gc" }).pipe(
    Layer.provideMerge(TestStores.layerAt(filename)),
    Layer.provide(StepBoundary.layerUnsupported),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provide(NodeJj.layerAt(process.cwd()))
  )

/** A store whose pass is `pass`, so a test can fail, kill or hold one. */
const storeOf = (pass: Effect.Effect<number, MemoryError>): MemoryStore.Service =>
  MemoryStore.MemoryStore.of({ deleteExpiredFacts: pass } as unknown as MemoryStore.Service)

const capture = (logs: Array<string>) =>
  Logger.layer([Logger.make((entry) => logs.push(`${entry.logLevel}: ${JSON.stringify(entry.message)}`))])

const run = <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<ReturnType<typeof engineAt>> | Scope.Scope>
) =>
  Effect.runPromise(effect.pipe(Effect.provide(engineAt(":memory:")), Effect.provide(TestClock.layer()), Effect.scoped))

/** Advances the durable timer until `done`, one interval at a time. */
const passesUntil = (done: () => boolean) =>
  TestDatabase.until(
    Effect.sync(done).pipe(Effect.tap((reached) => reached ? Effect.void : TestClock.adjust(MemoryTtlGc.intervalMs)))
  )

describe("the host's memory TTL pass", () => {
  it("deletes expired facts now and again on the durable ten-minute timer", async () => {
    const result = await run(
      Effect.gen(function*() {
        const memory = yield* Layer.build(TestMemory.layerWithDatabase)
        const store = Context.get(memory, MemoryStore.MemoryStore)
        const sql = Context.get(memory, SqlClient)
        const physicalKeys = sql<{ readonly fact_key: string }>`SELECT fact_key FROM memory_facts ORDER BY fact_key`
          .pipe(Effect.map((rows) => rows.map((row) => row.fact_key)))
        yield* store.putFact({ namespace, key: "expired-at-start", value: "value", ttlMs: 1, provenance: {} })
        yield* store.putFact({ namespace, key: "permanent", value: "value", provenance: {} })
        yield* TestClock.adjust(2)
        yield* MemoryTtlGc.start([store])
        yield* TestDatabase.until(physicalKeys.pipe(Effect.map((keys) => keys.length === 1)))
        const afterStart = yield* physicalKeys
        yield* store.putFact({ namespace, key: "expired-later", value: "value", ttlMs: 1, provenance: {} })
        // The wait is the engine's: the round is parked on a durable timer.
        const runs = yield* RunStore.RunStore
        yield* TestDatabase.until(
          runs.lineage(MemoryTtlGc.executionId).pipe(
            Effect.map((lineage) => lineage.some((round) => round.status === "suspended"))
          )
        )
        yield* TestClock.adjust(MemoryTtlGc.intervalMs - 1)
        const beforeInterval = yield* physicalKeys
        yield* TestClock.adjust(1)
        yield* TestDatabase.until(physicalKeys.pipe(Effect.map((keys) => keys.length === 1)))
        return { afterStart, beforeInterval, afterInterval: yield* physicalKeys }
      })
    )
    expect(result.afterStart).toEqual(["permanent"])
    expect(result.beforeInterval).toEqual(["expired-later", "permanent"])
    expect(result.afterInterval).toEqual(["permanent"])
  })

  // The forked loop this replaced ended on a defect without a log, and
  // expired facts were never deleted again in that process.
  it("logs a pass that fails or dies, runs the next pass, and still sweeps the other stores", async () => {
    const logs: Array<string> = []
    let passes = 0
    let otherPasses = 0
    const flaky = storeOf(Effect.suspend(() => {
      passes += 1
      return passes === 1
        ? Effect.fail(new MemoryError({ code: "store", message: "database temporarily unavailable" }))
        : passes === 2
        ? Effect.die(new Error("driver threw"))
        : Effect.succeed(3)
    }))
    const other = storeOf(Effect.sync(() => {
      otherPasses += 1
      return 0
    }))
    await run(
      Effect.gen(function*() {
        yield* MemoryTtlGc.start([flaky, other])
        yield* passesUntil(() => passes >= 3 && otherPasses >= 3)
      }).pipe(Effect.provide(capture(logs)))
    )
    expect(logs.filter((log) => log.includes("memory TTL GC pass failed"))).toHaveLength(2)
    expect(logs.filter((log) => log.includes("memory TTL GC deleted expired facts"))).toHaveLength(1)
    expect(logs.filter((log) => log.includes("schedule did not start"))).toEqual([])
  })

  it("logs nothing when the closing host interrupts a pass in flight", async () => {
    const logs: Array<string> = []
    await run(
      Effect.gen(function*() {
        const inFlight = yield* Deferred.make<void>()
        const held = storeOf(Deferred.succeed(inFlight, undefined).pipe(Effect.andThen(Effect.never)))
        yield* Effect.scoped(Effect.gen(function*() {
          yield* MemoryTtlGc.start([held])
          yield* Deferred.await(inFlight)
        }))
      }).pipe(Effect.provide(capture(logs)))
    )
    expect(logs.filter((log) => log.includes("memory TTL GC"))).toEqual([])
  })

  it("joins the lineage an earlier host left instead of starting a second one", () =>
    Effect.runPromise(
      Effect.acquireUseRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "memory-ttl-gc-restart-"))),
        (directory) =>
          Effect.gen(function*() {
            let passes = 0
            const store = storeOf(Effect.sync(() => {
              passes += 1
              return 0
            }))
            const host = (expected: number) =>
              Effect.scoped(Effect.gen(function*() {
                const services = yield* Layer.build(Layer.fresh(engineAt(join(directory, "engine.db"))))
                yield* MemoryTtlGc.start([store]).pipe(Effect.provide(services))
                yield* passesUntil(() => passes >= expected)
                const runs = Context.get(services, RunStore.RunStore)
                yield* TestDatabase.until(
                  runs.lineage(MemoryTtlGc.executionId).pipe(
                    Effect.map((lineage) => lineage.some((round) => round.status === "suspended"))
                  )
                )
                const sql = Context.get(services, SqlClient)
                return yield* sql<{ readonly runId: string }>`SELECT run_id AS "runId" FROM flows_runs
                  WHERE json_extract(state_json, '$.flowName') = ${MemoryTtlGc.flowName} AND round_ordinal = 0`
              }))
            const first = yield* host(1)
            const second = yield* host(2)
            return { first, second, passes }
          }),
        (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true }))
      ).pipe(Effect.provide(TestClock.layer()))
    ).then((result) => {
      expect(result.first.map((row) => row.runId)).toEqual([MemoryTtlGc.executionId])
      expect(result.second.map((row) => row.runId)).toEqual([MemoryTtlGc.executionId])
      expect(result.passes).toBe(2)
    }))

  it("logs a warning and lets the host start when the engine refuses the lineage", async () => {
    const logs: Array<string> = []
    let passes = 0
    await run(
      Effect.gen(function*() {
        const runtime = yield* FlowRuntime.FlowRuntime
        yield* MemoryTtlGc.start([storeOf(Effect.sync(() => passes += 1))]).pipe(
          Effect.provideService(FlowRuntime.FlowRuntime, {
            ...runtime,
            execute: () => Effect.fail(new FlowRuntime.StoreUnavailable({ executionId: MemoryTtlGc.executionId }))
          })
        )
      }).pipe(Effect.provide(capture(logs)))
    )
    expect(passes).toBe(0)
    expect(logs.filter((log) => log.includes("memory TTL GC schedule did not start"))).toHaveLength(1)
  })

  describe("SupervisorMemory.startTtlGc", () => {
    const physicalKeys = (filename: string): ReadonlyArray<string> => {
      const database = new DatabaseSync(filename, { readOnly: true })
      try {
        return (database.prepare("SELECT fact_key FROM memory_facts ORDER BY fact_key")
          .all() as unknown as ReadonlyArray<
            { readonly fact_key: string }
          >).map((row) => row.fact_key)
      } finally {
        database.close()
      }
    }

    /** A host whose supervisor store and workspace stores are two files, each holding one expired fact. */
    const twoStores = <A>(
      environment: (memoryFile: string) => Record<string, string>,
      use: (files: { readonly memory: string; readonly workspace: string }) => Effect.Effect<A>
    ) =>
      Effect.runPromise(
        Effect.acquireUseRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "memory-ttl-gc-stores-"))),
          (directory) =>
            Effect.gen(function*() {
              const files = { memory: join(directory, "memory.db"), workspace: join(directory, "control.db") }
              const stores = Layer.succeedContext(yield* Layer.build(platform.database(files.workspace)))
              const supervisor = Context.get(
                yield* Layer.build(SupervisorMemory.layer({
                  environment: { SMITHERS_MEMORY_DB: files.memory },
                  database: platform.database,
                  crypto: platform.crypto
                })),
                MemoryStore.MemoryStore
              )
              const workspace = Context.get(
                yield* Layer.build(MemoryStore.layer.pipe(Layer.provide([stores, platform.crypto]), Layer.orDie)),
                MemoryStore.MemoryStore
              )
              for (const [store, key] of [[supervisor, "supervisor"], [workspace, "workspace"]] as const) {
                yield* store.putFact({ namespace, key, value: "value", ttlMs: 1, provenance: {} })
              }
              yield* TestClock.adjust(2)
              yield* SupervisorMemory.startTtlGc({
                environment: environment(files.memory),
                crypto: platform.crypto,
                stores
              })
                .pipe(Effect.provideService(MemoryStore.MemoryStore, supervisor))
              yield* TestDatabase.until(Effect.sync(() => physicalKeys(files.memory).length === 0))
              return yield* use(files)
            }).pipe(Effect.provide(engineAt(":memory:")), Effect.scoped),
          (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true }))
        ).pipe(Effect.provide(TestClock.layer()))
      )

    it("also sweeps the workspace's own store when SMITHERS_MEMORY_DB moved the supervisor's elsewhere", async () => {
      const workspaceKeys = await twoStores(
        (memoryFile) => ({ SMITHERS_MEMORY_DB: memoryFile }),
        (files) =>
          TestDatabase.until(Effect.sync(() => physicalKeys(files.workspace).length === 0)).pipe(
            Effect.map(() => physicalKeys(files.workspace))
          )
      )
      expect(workspaceKeys).toEqual([])
    })

    it("sweeps the supervisor's store alone when it is the workspace's own", async () => {
      // Without the variable the host hands one database to both, so a second
      // pass over `stores` would only repeat the first.
      const workspaceKeys = await twoStores(() => ({}), (files) => Effect.sync(() => physicalKeys(files.workspace)))
      expect(workspaceKeys).toEqual(["workspace"])
    })

    it("sweeps the supervisor's store alone when the host has no workspace stores", async () => {
      let passes = 0
      await run(
        Effect.gen(function*() {
          yield* SupervisorMemory.startTtlGc({
            environment: { SMITHERS_MEMORY_DB: "/nonexistent/memory.db" },
            crypto: platform.crypto
          }).pipe(Effect.provideService(MemoryStore.MemoryStore, storeOf(Effect.sync(() => passes += 1))))
          yield* passesUntil(() => passes >= 1)
        })
      )
      expect(passes).toBe(1)
    })
  })
})
