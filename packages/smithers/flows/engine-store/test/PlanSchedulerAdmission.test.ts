import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { KeyMaterial, Plan } from "@smthrs/plan"
import { PlanStore } from "@smthrs/plan-store"
import type * as FileSet from "@smthrs/plan/FileSet"
import { AttemptStore, type Ownership, RunStore } from "@smthrs/run-store"
import { Effect, Exit, FileSystem, Latch, Layer, PlatformError } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as PlanScheduler from "../src/PlanScheduler.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { runPromise } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "admission-test", pid: 99, nonce: "scheduler" }
const draft = (
  id: string,
  writes: ReadonlyArray<FileSet.Entry>,
  reads: ReadonlyArray<FileSet.ReadEntry> = []
): Plan.NodeDraft => ({
  id,
  material: {
    version: KeyMaterial.version,
    kind: "sealed",
    body: { action: id },
    inputs: [],
    layers: [],
    capabilities: []
  },
  effects: { reads, writes, boundaryMode: "hard" }
})
const activate = (runId: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, "{}")
    const row = yield* runs.get(runId)
    const snapshot = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const claim = yield* runs.claim(runId, snapshot, owner, 1)
    if (claim._tag !== "Claimed") return yield* Effect.die("claim lost")
    const activated = yield* runs.activate(runId, owner, claim.claimedAtMs, snapshot)
    if (activated._tag !== "Activated") return yield* Effect.die("activation lost")
  })
const runtime = (executor: PlanScheduler.Executor) =>
  Layer.mergeAll(
    StepBoundary.layerTest(),
    PlanScheduler.layerExecutor(executor),
    Layer.succeed(
      Jj.Jj,
      Jj.make({
        snapshot: () => Effect.succeed({ commitId: "snapshot" as never, changeId: "snapshot" as never }),
        restore: () => Effect.void,
        diff: () => Effect.succeed(""),
        workspaceAdd: () => Effect.void,
        workspaceForget: () => Effect.void,
        status: () => Effect.succeed("")
      })
    )
  )
const scheduler = (runId: string) => PlanScheduler.make({ runId, owner, sourceId: `scheduler/${runId}` })

const failureOf = (exit: Exit.Exit<unknown, unknown>) =>
  exit._tag === "Failure" ? exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error : undefined

describe("scheduler validates plans before side effects", () => {
  it("executes the verified snapshot when caller-owned plan data changes during dispatch", async () => {
    const plan = await runPromise(
      Plan.compile({
        planId: "snapshot",
        flow: "test",
        nodes: [draft("producer", ["producer.out"]), draft("reader", ["reader.out"], ["producer.out"])]
      })
    )
    const callerOwned = JSON.parse(JSON.stringify(plan)) as Plan.Plan
    const executed: Array<string> = []
    const report = await runPromise(
      Effect.gen(function*() {
        yield* activate("snapshot")
        return yield* scheduler("snapshot").run(callerOwned)
      }).pipe(
        Effect.provide(runtime({
          execute: ({ node }) =>
            Effect.sync(() => {
              executed.push(node.id)
              if (node.id === "producer") (callerOwned.nodes as Array<Plan.PlanNode>).splice(1)
              return node.id
            })
        })),
        Effect.provide(TestStores.layer())
      )
    )
    expect(callerOwned.nodes).toHaveLength(1)
    expect(executed).toEqual(["producer", "reader"])
    expect(report.settlements.map((value) => value.nodeId)).toEqual(["producer", "reader"])
  })

  for (const operation of ["record", "append", "run"] as const) {
    it(`${operation} refuses a fabricated digest without journaling, storing, measuring or executing`, async () => {
      const original = await runPromise(
        Plan.compile({ planId: "verify-first", flow: "test", nodes: [draft("task", ["task.out"])] })
      )
      const other = await runPromise(Plan.compile({ planId: "other", flow: "test", nodes: [] }))
      const invalid = { ...original, digest: other.digest }
      let measured = 0
      let executed = 0
      let recorded = 0
      const outcome = await runPromise(
        Effect.gen(function*() {
          yield* activate(`invalid-${operation}`)
          const journal = yield* Journal.Journal
          const store = yield* PlanStore.PlanStore
          const guardedStore = {
            ...store,
            record: (...args: Parameters<typeof store.record>) => {
              recorded++
              return store.record(...args)
            },
            append: (...args: Parameters<typeof store.append>) => {
              recorded++
              return store.append(...args)
            }
          }
          const exit = yield* Effect.exit(scheduler(`invalid-${operation}`)[operation](invalid)).pipe(
            Effect.provideService(PlanStore.PlanStore, guardedStore),
            Effect.provideService(
              FileSystem.FileSystem,
              FileSystem.makeNoop({
                stat: () => {
                  measured++
                  return Effect.die("unexpected stat")
                }
              })
            )
          )
          return {
            exit,
            entries: (yield* journal.entries({ runId: `invalid-${operation}` as never, limit: 100 })).entries
          }
        }).pipe(
          Effect.provide(runtime({
            execute: () => {
              executed++
              return Effect.succeed("unexpected")
            }
          })),
          Effect.provide(TestStores.layerAt(":memory:"))
        )
      )
      expect(failureOf(outcome.exit)).toMatchObject({ code: "invalid_plan", cause: { code: "invalid_plan" } })
      expect(outcome.entries).toEqual([])
      expect({ measured, executed, recorded }).toEqual({ measured: 0, executed: 0, recorded: 0 })
    })
  }
})

describe("scheduler filesystem failure postconditions", () => {
  for (const site of ["source-glob", "produced-stat", "produced-glob", "produced-tree"] as const) {
    for (const reason of ["PermissionDenied", "Unknown", "NotFound"] as const) {
      // Missing exact paths and missing walk roots deliberately mean zero
      // matches. Disappearance is injected inside a discovered subtree below.
      if (site === "produced-stat" && reason === "NotFound") continue
      const cleanupModes = site === "produced-stat" && reason === "PermissionDenied"
        ? ["normal", "store-failure", "journal-failure", "fence-lost"] :
        ["normal"]
      for (const cleanup of cleanupModes) {
        it(`${site} preserves ${reason}, suppresses consumers and releases in-flight siblings (${cleanup})`, async () => {
          const observed = await runPromise(
            Effect.gen(function*() {
              const runId = `${site}-${reason}`
              const siblingStarted = yield* Latch.make()
              let produced = false
              let resources = 0
              let released = 0
              const executed: Array<string> = []
              const fault = PlatformError.systemError({
                _tag: reason,
                module: "FileSystem",
                method: site === "produced-stat" ? "stat" : "readDirectory",
                pathOrDescriptor: "src/generated/nested",
                description: "injected filesystem failure"
              })
              const fs = FileSystem.makeNoop({
                readDirectory: (path) =>
                  Effect.suspend(() => {
                    if (site === "source-glob") {
                      return path === "src" ? Effect.succeed(["nested"]) : Effect.fail(fault)
                    }
                    if (!produced) return Effect.succeed([])
                    // The writer walk discovers a directory; that directory then
                    // disappears or refuses access. A missing walk root is legal.
                    return path === "src/generated" ? Effect.succeed(["nested"]) : Effect.fail(fault)
                  }),
                stat: (path) =>
                  Effect.suspend(() =>
                    site === "produced-stat" && produced
                      ? Effect.fail(fault)
                      : Effect.succeed({ type: "Directory", size: 0n } as FileSystem.File.Info)
                  )
              })
              const writes: ReadonlyArray<FileSet.Entry> = site === "produced-stat" ?
                ["src/generated.txt"]
                : site === "produced-glob" ?
                [{ _tag: "Glob", include: ["src/generated/**"] }]
                : [{ _tag: "TreeArtifact", path: "src/generated" }]
              const nodes = site === "source-glob" ?
                [draft("reader", ["reader.out"], [{ _tag: "Glob", include: ["src/**"] }])]
                : [
                  draft("producer", writes),
                  draft("slow", ["slow.out"]),
                  draft("reader", ["reader.out"], [{ _tag: "Glob", include: ["src/**"] }]),
                  draft("downstream", ["downstream.out"], ["reader.out"])
                ]
              const plan = yield* Plan.compile({ planId: runId, flow: "fs-test", nodes })
              const executor: PlanScheduler.Executor = {
                execute: ({ node }) =>
                  Effect.gen(function*() {
                    executed.push(node.id)
                    if (node.id === "slow") {
                      yield* Effect.acquireRelease(
                        Effect.sync(() => {
                          resources++
                        }),
                        () =>
                          Effect.sync(() => {
                            resources--
                            released++
                          })
                      )
                      yield* Latch.open(siblingStarted)
                      return yield* Effect.never
                    }
                    yield* Latch.await(siblingStarted)
                    produced = true
                    return node.id
                  }).pipe(Effect.scoped)
              }
              yield* activate(runId)
              const attemptsService = yield* AttemptStore.AttemptStore
              const journalService = yield* Journal.Journal
              const cleanupFailure = new AttemptStore.AttemptStoreError({
                code: "persistence_failed",
                method: "finish",
                message: "injected cleanup failure"
              })
              const guardedAttempts = {
                ...attemptsService,
                finish: (attempt: AttemptStore.FinishAttempt, heldOwner: Ownership.OwnerId) =>
                  attempt.state !== "failed" ?
                    attemptsService.finish(attempt, heldOwner)
                    : cleanup === "store-failure" ?
                    Effect.fail(cleanupFailure)
                    : cleanup === "fence-lost" ?
                    Effect.succeed({ _tag: "FenceLost" as const })
                    : attemptsService.finish(attempt, heldOwner)
              }
              const guardedJournal = {
                ...journalService,
                emitDurable: (...args: Parameters<typeof journalService.emitDurable>) =>
                  cleanup === "journal-failure" && args[0].eventType === "flows.engine.attempt-finished" &&
                    (args[0].payload as { reason?: string }).reason === "scheduler_aborted"
                    ? Effect.fail(
                      new Journal.JournalError({ code: "sink_failed", message: "injected journal cleanup failure" })
                    )
                    : journalService.emitDurable(...args)
              }
              const exit = yield* Effect.exit(scheduler(runId).run(plan)).pipe(
                Effect.provide(runtime(executor)),
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(AttemptStore.AttemptStore, guardedAttempts),
                Effect.provideService(Journal.Journal, guardedJournal)
              )
              const sql = yield* SqlClient.SqlClient
              const attempts = yield* sql<{ state: string }>`SELECT state FROM flows_attempts WHERE run_id = ${runId}`
              const cache = yield* sql`SELECT key_digest FROM flows_step_cache`
              const journal = yield* Journal.Journal
              const events = (yield* journal.entries({ runId: runId as never, limit: 100 })).entries
              return { exit, fault, attempts, cache, events, executed, resources, released }
            }).pipe(Effect.provide(TestStores.layerAt(":memory:")))
          )
          expect(failureOf(observed.exit)).toMatchObject({ code: "boundary_unavailable" })
          expect((failureOf(observed.exit) as PlanScheduler.SchedulerError).cause).toBe(observed.fault)
          expect(observed.executed).not.toContain("reader")
          expect(observed.executed).not.toContain("downstream")
          expect(observed.attempts.map((attempt) => attempt.state).sort()).toEqual(
            site === "source-glob" ?
              [] :
              cleanup === "normal"
              ? ["failed", "succeeded"]
              : ["running", "succeeded"]
          )
          const primary = failureOf(observed.exit) as PlanScheduler.SchedulerError
          if (cleanup === "store-failure" || cleanup === "journal-failure") {
            expect(primary.cleanupErrors).toHaveLength(1)
            expect(primary.cleanupErrors?.[0]).toMatchObject({ code: "store_failed" })
          } else expect(primary.cleanupErrors).toBeUndefined()
          const aborted = observed.events.filter((entry) =>
            entry.eventType === "flows.engine.attempt-finished" &&
            (entry.payload as { reason?: string }).reason === "scheduler_aborted"
          )
          expect(aborted).toHaveLength(site !== "source-glob" && cleanup === "normal" ? 1 : 0)
          expect(observed.cache).toHaveLength(site === "source-glob" ? 0 : 1)
          expect(observed.resources).toBe(0)
          expect(observed.released).toBe(site === "source-glob" ? 0 : 1)
          const scheduled = observed.events.filter((entry) => entry.eventType === "flows.engine.node-scheduled")
          expect(
            scheduled.every((entry) => !["reader", "downstream"].includes((entry.payload as { nodeId: string }).nodeId))
          ).toBe(true)
          if (site !== "source-glob") {
            expect(observed.events.some((entry) =>
              entry.eventType === "flows.engine.node-settled" &&
              (entry.payload as { nodeId: string; outcome: string }).nodeId === "producer" &&
              (entry.payload as { outcome: string }).outcome === "built"
            )).toBe(true)
          }
        })
      }
    }
  }
})
