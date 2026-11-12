import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Migrations from "@smthrs/engine-store/Migrations"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/sql/SqlClient"
import type { LineageEdge } from "../src/Frame.ts"
import * as MemoryTimeTravelStore from "../src/MemoryTimeTravelStore.ts"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"

const owner = { hostId: "host-a", pid: 1234, nonce: "nonce" } as const

const records: ReadonlyArray<MemoryTimeTravelStore.JournalRecord> = [
  { runId: "parent", seq: 0, eventId: "parent-0", lineageId: "parent/root", payload: {} },
  { runId: "parent", seq: 2, eventId: "parent-2", lineageId: "parent/root", payload: {} },
  { runId: "parent", seq: 4, eventId: "parent-4", lineageId: "parent/root", payload: {} },
  { runId: "at-boundary", seq: 0, eventId: "at-boundary-0", lineageId: "at-boundary/root", payload: {} },
  { runId: "after-boundary", seq: 0, eventId: "after-boundary-0", lineageId: "after-boundary/root", payload: {} },
  { runId: "detached", seq: 0, eventId: "detached-0", lineageId: "detached/root", payload: {} }
]

const edges: ReadonlyArray<LineageEdge> = [
  { parentRunId: "parent", parentSeq: 2, childRunId: "at-boundary", kind: "child", attached: true },
  { parentRunId: "parent", parentSeq: 4, childRunId: "after-boundary", kind: "continuation", attached: true },
  { parentRunId: "parent", parentSeq: 4, childRunId: "detached", kind: "fork", attached: false }
]

const observeMemory = (seq: number) => {
  const store = MemoryTimeTravelStore.make({ records, edges, runOwners: new Map([["parent", owner]]) })
  return store.archiveAndTruncate("parent", { lineageId: "parent/root", seq }, [], owner).pipe(
    Effect.map((archive) => {
      const state = store.state()
      return {
        archived: archive.archived,
        orphaned: archive.orphaned.map((edge) => edge.childRunId).sort(),
        remaining: state.records.map((record) => record.eventId).sort(),
        edges: state.edges.map((edge) => edge.childRunId).sort()
      }
    })
  )
}

const observeSql = (seq: number) =>
  Effect.gen(function*() {
    yield* Migrations.run
    const sql = yield* Effect.service(SqlClient.SqlClient)
    const store = yield* SqlTimeTravelStore.make
    for (const runId of ["parent", "at-boundary", "after-boundary", "detached"]) {
      const status = runId === "at-boundary" || runId === "after-boundary" ? "completed" : "suspended"
      yield* sql`
          INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
          VALUES (${runId}, ${status}, 0, '{}')
        `
    }
    // The truncation is owner-fenced: the archive only commits while
    // `flows_runs` records this owner for the run. The run table's CHECK
    // keeps owner columns on `running` rows only.
    yield* sql`
        UPDATE flows_runs
        SET status = 'running',
          owner_host_id = ${owner.hostId}, owner_pid = ${owner.pid}, owner_nonce = ${owner.nonce},
          heartbeat_at_ms = 0
        WHERE run_id = 'parent'
      `
    for (const record of records) {
      yield* sql`
          INSERT INTO flows_journal_events
            (run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
             event_type, payload_json, meta_json)
          VALUES (${record.runId}, ${record.seq}, ${record.eventId}, 'reset-contract',
                  ${record.seq}, 0, 'test', '{}', '{}')
        `
    }
    for (const edge of edges) {
      yield* sql`
          INSERT INTO flows_time_travel_edges
            (parent_run_id, parent_seq, child_run_id, kind, attached)
          VALUES (${edge.parentRunId}, ${edge.parentSeq}, ${edge.childRunId}, ${edge.kind},
                  ${edge.attached ? 1 : 0})
        `
    }

    const archive = yield* store.archiveAndTruncate(
      "parent",
      { lineageId: "parent/root", seq },
      [],
      owner
    )
    const remaining = yield* sql<{ readonly event_id: string }>`
        SELECT event_id FROM flows_journal_events ORDER BY event_id
      `
    const remainingEdges = yield* sql<{ readonly child_run_id: string }>`
        SELECT child_run_id FROM flows_time_travel_edges ORDER BY child_run_id
      `
    return {
      archived: archive.archived,
      orphaned: archive.orphaned.map((edge) => edge.childRunId).sort(),
      remaining: remaining.map((row) => row.event_id),
      edges: remainingEdges.map((row) => row.child_run_id)
    }
  }).pipe(Effect.provide(TestDatabase.layer))

const boundaries = [
  {
    name: "the first event",
    seq: 0,
    expected: {
      archived: 4,
      orphaned: ["detached"],
      remaining: ["detached-0", "parent-0"],
      edges: ["detached"]
    }
  },
  {
    name: "an exact branch point",
    seq: 2,
    expected: {
      archived: 2,
      orphaned: ["detached"],
      remaining: ["at-boundary-0", "detached-0", "parent-0", "parent-2"],
      edges: ["at-boundary", "detached"]
    }
  },
  {
    name: "the history tail",
    seq: 4,
    expected: {
      archived: 0,
      orphaned: [],
      remaining: [
        "after-boundary-0",
        "at-boundary-0",
        "detached-0",
        "parent-0",
        "parent-2",
        "parent-4"
      ],
      edges: ["after-boundary", "at-boundary", "detached"]
    }
  }
] as const

describe.each(
  [
    ["memory", observeMemory],
    ["SQL", observeSql]
  ] as const
)("%s time-travel store history reset contract", (_name, observe) => {
  it.effect.each(boundaries)("keeps the reset frame inclusive at $name", ({ expected, seq }) =>
    Effect.gen(function*() {
      // Temporal-style reset history includes the selected LCA event and any
      // child branch created exactly there; only strictly later history moves.
      expect(yield* observe(seq)).toEqual(expected)
    }))
})
