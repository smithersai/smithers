import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as PendingRunStatements from "../src/internal/PendingRunStatements.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { assertIndexed, seedHistory } from "./PendingQueryPlan.ts"

const views = new Map<string, DurableEngineState.MemoryRunView>([
  ["z", { status: "pending", owner: null, createdAtMs: 1, cancelRequestedAtMs: 0 }],
  ["a", { status: "pending", owner: null, createdAtMs: 2, cancelRequestedAtMs: 1 }],
  ["b", { status: "pending", owner: null, createdAtMs: 2, cancelRequestedAtMs: 2 }],
  ["unrequested", { status: "pending", owner: null, createdAtMs: 0, cancelRequestedAtMs: null }],
  ["running", {
    status: "running",
    owner: { hostId: "running", pid: 1, nonce: "live" },
    heartbeatAtMs: 0,
    createdAtMs: 0,
    cancelRequestedAtMs: 0
  }],
  ["suspended", { status: "suspended", owner: null, createdAtMs: 0, cancelRequestedAtMs: 0 }],
  ["completed", { status: "completed", owner: null, createdAtMs: 0, cancelRequestedAtMs: 0 }],
  ["failed", { status: "failed", owner: null, createdAtMs: 0, cancelRequestedAtMs: 0 }],
  ["cancelled", { status: "cancelled", owner: null, createdAtMs: 0, cancelRequestedAtMs: 0 }]
])
const assertQuery = (state: DurableEngineState.Service) =>
  Effect.gen(function*() {
    const z = { runId: "z", createdAtMs: 1 }
    const a = { runId: "a", createdAtMs: 2 }
    const b = { runId: "b", createdAtMs: 2 }
    expect(yield* state.pendingCancellationRuns(64)).toEqual([z, a, b])
    expect(yield* state.pendingCancellationRuns(2)).toEqual([z, a])
    expect(yield* state.pendingCancellationRuns(0)).toEqual([])
    expect(yield* state.pendingCancellationRuns(2, z)).toEqual([a, b])
    expect(yield* state.pendingCancellationRuns(2, a)).toEqual([b])
    expect(yield* state.pendingCancellationRuns(2, b)).toEqual([])
    expect(yield* state.pendingCancellationRuns(2, undefined, z)).toEqual([z])
    expect(yield* state.pendingCancellationRuns(2, z, a)).toEqual([a])
    expect(yield* state.pendingCancellationRuns(2, a, a)).toEqual([])
    expect(Option.getOrThrow(yield* state.pendingCancellationTail())).toEqual(b)
    for (const limit of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const exit = yield* Effect.exit(state.pendingCancellationRuns(limit))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          name: "RangeError",
          message: "Pending cancellation limit must be a non-negative safe integer"
        })
      }
    }
  })

describe("indexed pending cancellation discovery", () => {
  it.effect("matches memory rows, timestamp-zero requests and cursor boundaries", () =>
    assertQuery(DurableEngineState.makeMemory({ listRuns: () => views.entries() })))

  it.effect("keeps absent legacy intent out and orders legacy creation timestamps at zero", () =>
    Effect.gen(function*() {
      const rows = new Map<string, DurableEngineState.MemoryRunView>([
        ["absent-intent", { status: "pending", owner: null }],
        ["b", { status: "pending", owner: null, cancelRequestedAtMs: 0 }],
        ["a", { status: "pending", owner: null, cancelRequestedAtMs: 0 }]
      ])
      const state = DurableEngineState.makeMemory({ listRuns: () => rows.entries() })
      expect(yield* state.pendingCancellationRuns(64)).toEqual([
        { runId: "a", createdAtMs: 0 },
        { runId: "b", createdAtMs: 0 }
      ])
      expect(Option.getOrThrow(yield* state.pendingCancellationTail())).toEqual({ runId: "b", createdAtMs: 0 })
      expect(yield* DurableEngineState.makeMemory().pendingCancellationRuns(64)).toEqual([])
      expect(yield* DurableEngineState.makeMemory().pendingCancellationTail()).toEqual(Option.none())
    }))

  it.effect("matches real database rows and excludes completed/deleted requests", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient
      const state = yield* DurableEngineState.DurableEngineState
      for (const [runId, view] of views) {
        yield* sql`INSERT INTO flows_runs ${
          sql.insert({
            run_id: runId,
            status: view.status,
            created_at_ms: view.createdAtMs!,
            state_json: JSON.stringify({ version: 1, flowName: `absent/${runId}`, payload: {} }),
            cancel_requested_at_ms: view.cancelRequestedAtMs!,
            heartbeat_at_ms: view.heartbeatAtMs ?? null,
            owner_host_id: view.owner?.hostId ?? null,
            owner_pid: view.owner?.pid ?? null,
            owner_nonce: view.owner?.nonce ?? null
          })
        }`
      }
      yield* assertQuery(state)
      yield* sql`DELETE FROM flows_runs WHERE run_id = 'b'`
      expect(Option.getOrThrow(yield* state.pendingCancellationTail())).toEqual({ runId: "a", createdAtMs: 2 })
      yield* sql`UPDATE flows_runs SET status = 'cancelled' WHERE run_id IN ('a', 'z')`
      expect(yield* state.pendingCancellationRuns(64)).toEqual([])
      expect(yield* state.pendingCancellationTail()).toEqual(Option.none())
    }).pipe(Effect.provide(Layer.provideMerge(DurableEngineState.layer, TestStores.database)), Effect.scoped))

  it.effect("uses a creation-order partial index rather than scanning settled history", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient
      yield* seedHistory(sql)
      for (const descending of [false, true]) {
        const statement = PendingRunStatements.cancellations(
          sql,
          64,
          { createdAtMs: 1, runId: "a" },
          { createdAtMs: 2, runId: "z" },
          descending
        )
        yield* assertIndexed(sql, statement, "flows_runs_pending_cancel_idx")
      }
    }).pipe(Effect.provide(TestStores.database), Effect.scoped))
})
