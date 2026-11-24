/**
 * Pins issue #68: the parked-run sweep used to do an unfiltered
 * `waitingRuns()` scan plus one `store.get` per parked row, every heartbeat,
 * in every driver — linear in total parked runs even though it acts only on
 * released or cancel-requested rows. The sweep must fetch only actionable
 * rows through the `WaitingRunsFilter` (reason `released`, and the
 * cancel-requested predicate added for this issue), so a quota/event-parked
 * fleet costs the sweeper nothing per tick.
 *
 * Uses the SQL `DurableEngineState` over the same database as `RunStore`:
 * the filter's cancel predicate reads `flows_runs.cancel_requested_at_ms`.
 */
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { SqlJournal } from "@smthrs/journal"
import { Node } from "@smthrs/plan"
import { Ownership, RunStore } from "@smthrs/run-store"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as Migrations from "../src/Migrations.ts"
import { withCrypto } from "./Sha256.ts"

const TestFlow = Flow.make("SweepFiltering/Test", {
  payload: {},
  success: Schema.String,
  body: () => Node.succeed("unused")
})

const fakeEngine = {} as unknown as FlowRuntime.FlowRuntime["Service"]

const migratedDatabase = Layer.provideMerge(Migrations.layer, TestDatabase.layer)

const services = Layer.mergeAll(
  SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
  RunStore.layer,
  DurableEngineState.layer
).pipe(Layer.provideMerge(migratedDatabase))

/** Inserts a suspended, unowned, parked run row directly (fences bypassed). */
const insertParkedRun = (
  runId: string,
  reason: string,
  cancelRequestedAtMs: number | null
) =>
  Effect.gen(function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    const writer = yield* DurableWriter.DurableWriter
    const stateJson = JSON.stringify({
      version: 1,
      flowName: TestFlow._tag,
      payload: {}
    })
    yield* writer.write(sql`
      INSERT INTO flows_runs (
        run_id,
        status,
        created_at_ms,
        cancel_requested_at_ms,
        waiting_reason,
        state_json
      ) VALUES (
        ${runId},
        'suspended',
        0,
        ${cancelRequestedAtMs},
        ${reason},
        ${stateJson}
      )
    `).pipe(Effect.orDie)
  })

describe("the parked-run sweep fetches only actionable rows (issue #68)", () => {
  it.effect("never issues store.get for rows that are neither released nor cancel-requested", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(
        Effect.scoped(
          Effect.gen(function*() {
            // A quota-parked fleet the sweep must not touch, plus the two
            // actionable shapes.
            yield* insertParkedRun("neutral-quota", "quota", null)
            yield* insertParkedRun("neutral-event", "event", null)
            yield* insertParkedRun("actionable-cancel", "event", 1)
            yield* insertParkedRun("actionable-released", "released", null)

            // Spy on store.get: the sweep's per-row guard is the only reader
            // for runs no execute/resume ever touches.
            const store = yield* RunStore.RunStore
            const getCounts = new Map<string, number>()
            const spyingStore: RunStore.RunStore["Service"] = {
              ...store,
              get: (runId) => {
                getCounts.set(runId, (getCounts.get(runId) ?? 0) + 1)
                return store.get(runId)
              }
            }

            yield* RunDriver.make({
              owner: { hostId: "sweep-filter-host", pid: 1, nonce: "owner-1" },
              journalSource: "sweep-filtering",
              isAlive: () => Effect.succeed(false),
              engine: Effect.succeed(fakeEngine)
            }).pipe(Effect.provideService(RunStore.RunStore, spyingStore))

            for (let i = 0; i < 5; i++) {
              yield* TestClock.adjust(Duration.toMillis(Ownership.heartbeatInterval))
            }
            yield* TestDatabase.until(
              Effect.sync(() =>
                (getCounts.get("actionable-cancel") ?? 0) > 0 && (getCounts.get("actionable-released") ?? 0) > 0
              )
            )
            return {
              neutralQuota: getCounts.get("neutral-quota") ?? 0,
              neutralEvent: getCounts.get("neutral-event") ?? 0,
              actionableCancel: getCounts.get("actionable-cancel") ?? 0,
              actionableReleased: getCounts.get("actionable-released") ?? 0
            }
          })
        ).pipe(
          Effect.provide(services),
          Effect.provide(TestClock.layer())
        )
      )

      // The sweep still examines and wakes the actionable rows…
      expect(result.actionableCancel).toBeGreaterThanOrEqual(1)
      expect(result.actionableReleased).toBeGreaterThanOrEqual(1)
      // …but pays nothing for the parked fleet it cannot act on.
      expect(result.neutralQuota).toBe(0)
      expect(result.neutralEvent).toBe(0)
    }))

  // R1-Fable-D1-024: the sweep read every released row and ran one read and
  // one wake per row on every tick, in every driver. A graceful shutdown that
  // released N runs cost each survivor O(N) per second until they drained.
  it.effect("visits a released fleet one bounded page per tick and reaches every run", () =>
    Effect.gen(function*() {
      const fleet = 200
      const batch = 64
      const result = yield* withCrypto(
        Effect.scoped(
          Effect.gen(function*() {
            const ids = Array.from({ length: fleet }, (_, index) => `released-${String(index).padStart(4, "0")}`)
            for (const runId of ids) yield* insertParkedRun(runId, "released", null)
            const state = yield* DurableEngineState.DurableEngineState
            const pages: Array<ReadonlyArray<string>> = []
            const unbounded: Array<DurableEngineState.WaitingRunsFilter | undefined> = []
            const observed: DurableEngineState.Service = {
              ...state,
              waitingRuns: (filter) => {
                unbounded.push(filter)
                return state.waitingRuns(filter)
              },
              waitingRunsPage: (filter) =>
                state.waitingRunsPage(filter).pipe(Effect.tap(({ rows }) =>
                  Effect.sync(() => {
                    if (filter?.reason === "released") pages.push(rows.map((row) => row.runId))
                  })
                ))
            }
            // No flow is registered: every wake leaves its run parked, so the
            // rows never leave the set and only the cursor can move the sweep on.
            yield* RunDriver.make({
              owner: { hostId: "sweep-filter-host", pid: 1, nonce: "owner-1" },
              journalSource: "sweep-filtering",
              isAlive: () => Effect.succeed(false),
              engine: Effect.succeed(fakeEngine)
            }).pipe(Effect.provideService(DurableEngineState.DurableEngineState, observed))

            const ticks = Math.ceil(fleet / batch)
            // One heartbeat per poll: on a server database a sweep's reads
            // outlast the instant it started in, and its next sleep begins
            // only when they finish.
            yield* TestDatabase.until(Effect.gen(function*() {
              if (pages.length > ticks) return true
              yield* TestClock.adjust(Duration.toMillis(Ownership.heartbeatInterval))
              return false
            }))
            const store = yield* RunStore.RunStore
            return {
              ids,
              pages: pages.slice(0, ticks + 1),
              unbounded,
              statuses: new Set(
                yield* Effect.forEach(ids, (runId) => Effect.map(store.get(runId), (row) => row.status))
              )
            }
          })
        ).pipe(
          Effect.provide(services),
          Effect.provide(TestClock.layer())
        )
      )

      const ticks = Math.ceil(fleet / batch)
      // Every sweep read is a bounded page.
      expect(result.unbounded).toEqual([])
      expect(result.pages.every((page) => page.length <= batch)).toBe(true)
      // ⌈N/64⌉ ticks reach every released run exactly once…
      expect(result.pages.slice(0, ticks).flat().sort()).toEqual(result.ids)
      // …and the next tick starts the cycle over rather than stopping.
      expect(result.pages[ticks]).toEqual(result.ids.slice(0, batch))
      expect([...result.statuses]).toEqual(["suspended"])
    }))
})
