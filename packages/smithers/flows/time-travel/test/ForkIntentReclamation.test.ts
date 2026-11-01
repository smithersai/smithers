import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Jj from "@smthrs/jj"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
import type * as Journal from "@smthrs/journal/Journal"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"
import * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { execFileSync } from "node:child_process"
import * as Registry from "../src/internal/EffectHandlerRegistry.ts"
import * as Fork from "../src/internal/Fork.ts"
import * as Memory from "../src/MemoryTimeTravelStore.ts"
import * as Migrations from "../src/Migrations.ts"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"
import { forkWorkspaceName, makeWith } from "../src/TimeTravel.ts"
import { error } from "../src/TimeTravelError.vibe"
import { TimeTravelStore } from "../src/TimeTravelStore.ts"
import { withRealFixture } from "./RealTimeTravelHarness.ts"

const frame = { lineageId: "parent/root", seq: 0 } as const
const record = { runId: "parent", seq: 0, eventId: "parent-0", lineageId: frame.lineageId, payload: {} }
const database = Migrations.layer.pipe(Layer.provideMerge(TestDatabase.layer))
const persistence = Layer.mergeAll(
  SqlTimeTravelStore.layer,
  SqlJournal.layer({ capacity: 128, overflow: "reject" }),
  RunStore.layer,
  CacheStore.layer
).pipe(Layer.provideMerge(database))

const seed = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
    VALUES ('parent', 'suspended', 0, ${JSON.stringify({ version: 1, flowName: "Demo", payload: {} })})`
  yield* sql`INSERT INTO flows_journal_events
    (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
    VALUES ('parent', 0, 'parent-0', 'source', 0, 0, 'test', '{}', ${JSON.stringify({ lineageId: frame.lineageId })})`
  const store = yield* TimeTravelStore
  yield* store.recordSnapshot({ runId: "parent", frame, changeId: "anchor" })
})

const image = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const counts: Array<number> = []
  for (
    const table of [
      "flows_runs",
      "flows_journal_events",
      "flows_attempts",
      "flows_time_travel_edges",
      "flows_time_travel_snapshots"
    ]
  ) {
    const rows = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM ${sql(table)}`
    counts.push(Number(rows[0]!.count))
  }
  return counts
})

for (const kind of ["sql", "memory"] as const) {
  describe(`${kind} fork intent startup reclamation`, () => {
    const withStore = <A>(
      body: (
        store: TimeTravelStore["Service"]
      ) => Effect.Effect<
        A,
        unknown,
        | TimeTravelStore
        | SqlClient.SqlClient
        | RunStore.RunStore
        | CacheStore.CacheStore
        | Journal.Journal
        | Scope.Scope
      >
    ) =>
      Effect.gen(function*() {
        const store = kind === "sql" ? yield* TimeTravelStore : Memory.make({ records: [record] })
        return yield* body(store).pipe(Effect.provideService(TimeTravelStore, store))
      }).pipe(Effect.provide(persistence), Effect.scoped)

    for (const failure of ["workspaceForget", "forgetForkIntent"] as const) {
      it.effect(`retries a failed ${failure} on the next build and stops after success`, () =>
        withStore((store) =>
          Effect.gen(function*() {
            const childRunId = yield* store.nextForkId("parent", frame)
            yield* TestClock.adjust("6 minutes")
            const calls: Array<string> = []
            let acknowledgments = 0
            const faulty = {
              ...store,
              forgetForkIntent: (id: string, reclaimedAtMs: number) =>
                Effect.suspend(() => {
                  acknowledgments += 1
                  return failure === "forgetForkIntent" && acknowledgments === 1
                    ? Effect.fail(error("unknown", "injected acknowledgement failure"))
                    : store.forgetForkIntent(id, reclaimedAtMs)
                })
            }
            const jj = Jj.makeNoop({
              workspaceForget: (name) =>
                Effect.suspend(() => {
                  calls.push(name)
                  return failure === "workspaceForget" && calls.length === 1
                    ? Effect.fail(
                      new Jj.JjError({
                        code: "unknown",
                        command: "workspace forget",
                        message: "injected forget failure"
                      })
                    )
                    : Effect.void
                })
            })
            const build = () =>
              makeWith().pipe(
                Effect.provideService(TimeTravelStore, faulty),
                Effect.provideService(Jj.Jj, jj)
              )
            yield* build()
            yield* build()
            yield* build()
            expect(calls).toEqual([forkWorkspaceName(childRunId), forkWorkspaceName(childRunId)])
            expect(yield* store.abandonForkIntents(Number.MAX_SAFE_INTEGER)).toEqual([])
          })
        ))
    }

    it.effect("keeps a reopened intent retryable after a delayed sweep acknowledgment in the same millisecond", () =>
      withStore((store) =>
        Effect.gen(function*() {
          yield* seed
          const before = yield* image
          const childRunId = yield* store.nextForkId("parent", frame)
          const [claimed] = yield* store.abandonForkIntents(1)
          const refusal = yield* Effect.flip(store.createFork("parent", frame, childRunId))
          expect(refusal.code).toBe("fence_lost")
          // The sweep already forgot the absent lane; its completion write
          // arrives after the refused fork reopened reclamation. No clock tick
          // separates those writes, so the stamp must advance independently.
          yield* store.forgetForkIntent(childRunId, claimed!.reclaimedAtMs!)
          const pending = yield* store.abandonForkIntents(0)
          expect(pending).toHaveLength(1)
          expect(pending[0]!.childRunId).toBe(childRunId)
          expect(pending[0]!.reclaimedAtMs).toBeGreaterThan(claimed!.reclaimedAtMs!)
          expect(yield* image).toEqual(before)
          yield* store.forgetForkIntent(childRunId, pending[0]!.reclaimedAtMs!)
          expect(yield* store.abandonForkIntents(0)).toEqual([])
        })
      ))

    it.effect("supersedes earlier sweep claims even without a clock tick", () =>
      withStore((store) =>
        Effect.gen(function*() {
          const childRunId = yield* store.nextForkId("parent", frame)
          const [first] = yield* store.abandonForkIntents(1)
          const [second] = yield* store.abandonForkIntents(0)
          expect(second!.reclaimedAtMs).toBeGreaterThan(first!.reclaimedAtMs!)
          yield* store.forgetForkIntent(childRunId, first!.reclaimedAtMs!)
          const [third] = yield* store.abandonForkIntents(0)
          expect(third!.childRunId).toBe(childRunId)
          expect(third!.reclaimedAtMs).toBeGreaterThan(second!.reclaimedAtMs!)
          yield* store.forgetForkIntent(childRunId, third!.reclaimedAtMs!)
          expect(yield* store.abandonForkIntents(0)).toEqual([])
        })
      ))

    it.effect("reopens a reclaimed reservation before rejecting its live parent", () =>
      withStore((provided) =>
        Effect.gen(function*() {
          yield* seed
          const runs = yield* RunStore.RunStore
          const snapshot = yield* runs.get("parent")
          expect(yield* runs.claimAndOwn("parent", snapshot, { hostId: "host", pid: 1, nonce: "live" }, 0))
            .toEqual({ _tag: "Activated" })
          const store = kind === "sql" ? provided : Memory.make({ records: [record], liveRuns: new Set(["parent"]) })
          const childRunId = yield* store.nextForkId("parent", frame)
          const [claimed] = yield* store.abandonForkIntents(1)
          yield* store.forgetForkIntent(childRunId, claimed!.reclaimedAtMs!)
          expect(yield* store.abandonForkIntents(0)).toEqual([])
          const before = yield* image
          const refusal = yield* Effect.flip(store.createFork("parent", frame, childRunId))
          expect(refusal.code).toBe("fence_lost")
          const pending = yield* store.abandonForkIntents(0)
          expect(pending).toHaveLength(1)
          expect(pending[0]!.childRunId).toBe(childRunId)
          expect(pending[0]!.reclaimedAtMs).toBeGreaterThan(claimed!.reclaimedAtMs!)
          expect(yield* image).toEqual(before)
        })
      ))

    it.effect("resumes a sweep interrupted before forgetting its lane", () =>
      withStore((store) =>
        Effect.gen(function*() {
          const childRunId = yield* store.nextForkId("parent", frame)
          expect(yield* store.abandonForkIntents(1)).toHaveLength(1)
          const calls: Array<string> = []
          const jj = Jj.makeNoop({
            workspaceForget: (name) =>
              Effect.sync(() => {
                calls.push(name)
              })
          })
          // The earlier sweep claimed it. Even a cutoff before reservation must
          // return pending work left by that sweep.
          yield* makeWith().pipe(Effect.provideService(Jj.Jj, jj))
          yield* makeWith().pipe(Effect.provideService(Jj.Jj, jj))
          expect(calls).toEqual([forkWorkspaceName(childRunId)])
          expect(yield* store.abandonForkIntents(0)).toEqual([])
        })
      ))

    it.effect("refuses a forgotten reservation before a failing add can strand its registered lane", () =>
      withStore((store) =>
        Effect.gen(function*() {
          yield* seed
          const before = yield* image
          const added: Array<string> = []
          const forgotten: Array<string> = []
          const jj = Jj.makeNoop({
            workspaceAdd: (name) =>
              Effect.suspend(() => {
                added.push(name)
                return Effect.fail(
                  new Jj.JjError({
                    code: "unknown",
                    command: "workspace add",
                    message: "injected pinning failure after registration and failed adapter cleanup"
                  })
                )
              }),
            workspaceForget: (name) =>
              Effect.suspend(() => {
                forgotten.push(name)
                return Effect.fail(
                  new Jj.JjError({
                    code: "unknown",
                    command: "workspace forget",
                    message: "injected cleanup failure"
                  })
                )
              })
          })
          const result = yield* Effect.result(
            Fork.fork({
              parentRunId: "parent",
              frame,
              workspaceRoot: "/tmp/fork-lanes",
              retainWorkspace: true,
              hooks: {
                beforeStep: (step) =>
                  step === "provision-workspace"
                    ? Effect.gen(function*() {
                      yield* TestClock.adjust("6 minutes")
                      const [intent] = yield* store.abandonForkIntents(Number.MAX_SAFE_INTEGER)
                      expect(intent!.childRunId).toBe("parent:fork:0:1")
                      // A sweep forgets a lane that does not exist yet, then
                      // acknowledges success before the stalled fork resumes.
                      yield* store.forgetForkIntent(intent!.childRunId, intent!.reclaimedAtMs!)
                      expect(yield* store.abandonForkIntents(0)).toEqual([])
                    })
                    : Effect.void
              }
            }).pipe(Effect.provideService(Jj.Jj, jj), Effect.provide(Registry.layerNoop))
          )
          expect({ result, added, forgotten }).toMatchObject({
            result: {
              _tag: "Failure",
              failure: {
                code: "fence_lost",
                message: "fork reservation parent:fork:0:1 was reclaimed before its lane was provisioned"
              }
            },
            added: [],
            forgotten: []
          })
          expect(yield* store.abandonForkIntents(0)).toEqual([])
          expect(yield* image).toEqual(before)
        })
      ))

    it.effect("reopens a forgotten intent after late provisioning and retries failed refused-commit cleanup", () =>
      withRealFixture("flows-late-fork-", (fixture) =>
        withStore((store) =>
          Effect.gen(function*() {
            yield* seed
            const jj = yield* Jj.Jj
            const pointer = yield* jj.snapshot()
            yield* store.recordSnapshot({ runId: "parent", frame, changeId: pointer.changeId })
            const context = yield* Effect.context<
              Journal.Journal | RunStore.RunStore | CacheStore.CacheStore | Scope.Scope
            >()
            const before = yield* image
            const lane = forkWorkspaceName("parent:fork:0:1")
            const forgets: Array<string> = []
            let refuseCleanup = false
            const faultyJj = {
              ...jj,
              workspaceAdd: (...args: Parameters<Jj.Jj["workspaceAdd"]>): ReturnType<Jj.Jj["workspaceAdd"]> =>
                Effect.gen(function*() {
                  // Stall inside workspaceAdd, after renewal but before jj
                  // registers the lane. The sweep still sees an absent lane.
                  yield* TestClock.adjust("6 minutes")
                  expect(yield* store.abandonForkIntents(Number.MAX_SAFE_INTEGER)).toHaveLength(1)
                  yield* build()
                  expect(yield* store.abandonForkIntents(0)).toEqual([])
                  yield* TestClock.adjust("1 minute")
                  refuseCleanup = true
                  yield* jj.workspaceAdd(...args)
                }).pipe(
                  Effect.mapError((cause) =>
                    new Jj.JjError({
                      code: "unknown",
                      command: "workspace add",
                      message: "injected stall failed",
                      cause
                    })
                  )
                ),
              workspaceForget: (name: string) =>
                Effect.suspend(() => {
                  forgets.push(name)
                  return refuseCleanup
                    ? Effect.fail(
                      new Jj.JjError({
                        code: "unknown",
                        command: "workspace forget",
                        message: "injected refused-commit cleanup failure"
                      })
                    )
                    : jj.workspaceForget(name)
                })
            }
            const build = () =>
              makeWith().pipe(
                Effect.provideService(TimeTravelStore, {
                  ...store,
                  abandonForkIntents: () => store.abandonForkIntents(Number.MAX_SAFE_INTEGER)
                }),
                Effect.provideService(Jj.Jj, faultyJj),
                Effect.provideContext(context)
              )
            const result = yield* Effect.result(
              Fork.fork({
                parentRunId: "parent",
                frame,
                workspaceRoot: `${fixture.directory}/lanes`,
                retainWorkspace: true
              }).pipe(Effect.provideService(Jj.Jj, faultyJj), Effect.provide(Registry.layerNoop))
            )
            expect(result).toMatchObject({ _tag: "Failure", failure: { code: "fence_lost" } })
            const lanes = () => execFileSync("jj", ["workspace", "list"], { cwd: fixture.repository, encoding: "utf8" })
            expect(lanes()).toContain(`${lane}:`)
            expect(forgets).toEqual([lane, lane])
            expect(yield* image).toEqual(before)
            const pending = yield* store.abandonForkIntents(0)
            expect(pending).toEqual([{
              childRunId: "parent:fork:0:1",
              parentRunId: "parent",
              parentSeq: 0,
              reservedAtMs: 0,
              reclaimedAtMs: 420_001
            }])
            if (kind === "sql") {
              const sql = yield* SqlClient.SqlClient
              expect(yield* sql`SELECT reclaimed_at_ms, forgotten_at_ms FROM flows_time_travel_fork_intents`)
                .toEqual([{ reclaimed_at_ms: 420_001, forgotten_at_ms: null }])
            }
            refuseCleanup = false
            yield* build()
            expect(forgets).toEqual([lane, lane, lane])
            expect(lanes()).not.toContain(`${lane}:`)
            expect(yield* store.abandonForkIntents(0)).toEqual([])
            yield* build()
            expect(forgets).toHaveLength(3)
          }).pipe(Effect.provide(NodeJj.layerAt(fixture.repository)))
        )))

    it.effect("refuses a reservation reclaimed while provisioning and forgets the refused lane", () =>
      withStore((store) =>
        Effect.gen(function*() {
          yield* seed
          const before = yield* image
          const memoryBefore = kind === "memory" ? (store as ReturnType<typeof Memory.make>).state() : undefined
          const added: Array<string> = []
          const forgotten: Array<string> = []
          const jj = Jj.makeNoop({
            workspaceAdd: (name) =>
              Effect.sync(() => {
                added.push(name)
              }),
            workspaceForget: (name) =>
              Effect.sync(() => {
                forgotten.push(name)
              })
          })
          const result = yield* Effect.result(
            Fork.fork({
              parentRunId: "parent",
              frame,
              workspaceRoot: "/tmp/fork-lanes",
              retainWorkspace: true,
              hooks: {
                beforeStep: (step) =>
                  step === "commit-fork"
                    ? store.abandonForkIntents(Number.MAX_SAFE_INTEGER).pipe(Effect.asVoid)
                    : Effect.void
              }
            }).pipe(Effect.provideService(Jj.Jj, jj), Effect.provide(Registry.layerNoop))
          )
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: {
              code: "fence_lost",
              message: "fork reservation parent:fork:0:1 was reclaimed before the fork committed"
            }
          })
          expect(added).toEqual([forkWorkspaceName("parent:fork:0:1")])
          expect(forgotten).toEqual(added)
          expect(yield* image).toEqual(before)
          if (kind === "memory") expect((store as ReturnType<typeof Memory.make>).state()).toEqual(memoryBefore)
          expect(yield* store.abandonForkIntents(0)).toHaveLength(1)
        })
      ))
  })
}

it.effect("retries an old reclaimed SQL intent with no forgotten timestamp exactly until forgotten", () =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    // Omitting the new column also reproduces a pre-migration row's NULL.
    yield* sql`INSERT INTO flows_time_travel_fork_intents
      (child_run_id, parent_run_id, parent_seq, reserved_at_ms, reclaimed_at_ms)
      VALUES ('legacy', 'parent', 0, 0, 0)`
    const calls: Array<string> = []
    const jj = Jj.makeNoop({
      workspaceForget: (name) =>
        Effect.sync(() => {
          calls.push(name)
        })
    })
    yield* makeWith().pipe(Effect.provideService(Jj.Jj, jj))
    yield* makeWith().pipe(Effect.provideService(Jj.Jj, jj))
    expect(calls).toEqual([forkWorkspaceName("legacy")])
    const rows = yield* sql`SELECT child_run_id, reclaimed_at_ms, forgotten_at_ms FROM flows_time_travel_fork_intents`
    expect(rows).toEqual([{ child_run_id: "legacy", reclaimed_at_ms: 1, forgotten_at_ms: 0 }])
  }).pipe(Effect.provide(persistence), Effect.scoped))
