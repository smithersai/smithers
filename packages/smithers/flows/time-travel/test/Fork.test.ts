import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as Jj from "@smthrs/jj"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import { Effect } from "effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Memory from "../src/MemoryTimeTravelStore.ts"
import * as Migrations from "../src/Migrations.ts"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"
import * as TimeTravel from "../src/TimeTravel.ts"

describe("fork", () => {
  it.effect("creates unique immutable prefix copies", () =>
    Effect.gen(function*() {
      const store = Memory.make({
        records: [
          { runId: "r", seq: 0, eventId: "a", lineageId: "r", payload: null },
          { runId: "r", seq: 2, eventId: "b", lineageId: "r", payload: null }
        ]
      })
      const before = store.state().records
      const first = yield* (store.createFork("r", { lineageId: "r", seq: 0 }))
      const second = yield* (store.createFork("r", { lineageId: "r", seq: 0 }))

      expect(first.runId).not.toBe(second.runId)
      // The copied prefix record plus the fork-created marker the SQL store
      // also writes on the child at `frame.seq + 1`.
      expect(store.state().records.filter((record) => record.runId === first.runId)).toHaveLength(2)
      expect(store.state().records.filter((record) => record.runId === second.runId)).toHaveLength(2)
      expect(store.state().records.filter((record) => record.runId === "r")).toEqual(before)
    }))

  // The in-memory store mints the SQL store's shape, `<parent>:fork:<seq>:<n>`,
  // counting the edges and reservations already at the frame, so a mint that
  // never committed still keeps its ordinal. The jj lane is named after this
  // id, so a different shape here would name lanes SQL never provisions.
  it.effect("mints a fresh child id on every call, committed or not", () =>
    Effect.gen(function*() {
      const store = Memory.make({
        records: [{ runId: "r", seq: 0, eventId: "a", lineageId: "r", payload: null }]
      })

      const first = yield* store.nextForkId("r", { lineageId: "r", seq: 0 })
      const second = yield* store.nextForkId("r", { lineageId: "r", seq: 0 })

      expect([first, second]).toEqual(["r:fork:0:1", "r:fork:0:2"])
      expect(store.state().records.filter((record) => record.runId !== "r")).toEqual([])
    }))

  it.effect("copies the frame's anchors to the child, and only those", () =>
    Effect.gen(function*() {
      const store = Memory.make({
        records: [{ runId: "r", seq: 0, eventId: "a", lineageId: "r", payload: null }],
        snapshots: [
          { runId: "r", frame: { lineageId: "r", seq: 0 }, changeId: "change-0" },
          { runId: "r", frame: { lineageId: "r", seq: 2 }, changeId: "change-2" }
        ]
      })

      const fork = yield* (store.createFork("r", { lineageId: "r", seq: 0 }))

      // The anchor above the frame stays the parent's alone: the child's
      // copied prefix has no record that could explain it.
      expect(store.state().snapshots.filter((snapshot) => snapshot.runId === fork.runId)).toEqual([
        { runId: fork.runId, frame: { lineageId: "r", seq: 0 }, changeId: "change-0" }
      ])
    }))

  it.effect("refuses a fork when any ancestor is live", () =>
    Effect.gen(function*() {
      const store = Memory.make({
        records: [{ runId: "child", seq: 0, eventId: "child-0", lineageId: "child", payload: null }],
        edges: [
          { parentRunId: "root", parentSeq: 0, childRunId: "middle", kind: "child", attached: true },
          { parentRunId: "middle", parentSeq: 0, childRunId: "child", kind: "child", attached: true }
        ],
        liveRuns: new Set(["root"])
      })

      const failure = yield* (
        Effect.flip(store.createFork("child", { lineageId: "child", seq: 0 }))
      )
      expect(failure.code).toBe("live_parent")
    }))
})

/**
 * A fork's workspace is an identity, not a label.
 *
 * `docs/specs/Concepts/Time Travel.md` §Fork gives every child its own jj
 * workspace, and the store gives every child its own run id. These cases hold
 * the two identities to each other over the REAL SQLite store: the name the
 * lane is provisioned under must distinguish exactly the children the store
 * distinguishes, so a second fork of one frame cannot land in the first
 * child's lane and two parents that sanitize to the same characters cannot
 * share one.
 */
describe("fork workspace identity", () => {
  const frame = { lineageId: "main", seq: 0 } as const

  const insertParent = (sql: SqlClient.SqlClient, runId: string) =>
    sql`
      INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
      VALUES (${runId}, 'suspended', 0, ${JSON.stringify({ version: 1, flowName: "Demo", payload: {} })})
    `

  /** The real store and journal, with jj reduced to a recorder of its lanes. */
  const runForks = <A>(
    body: (
      timeTravel: TimeTravel.Service,
      sql: SqlClient.SqlClient
    ) => Effect.Effect<A, unknown, never>
  ) =>
    Effect.gen(function*() {
      const lanes: Array<{ readonly name: string; readonly path: string }> = []
      const jj = Layer.succeed(
        Jj.Jj,
        Jj.makeNoop({
          workspaceAdd: (name, path) => Effect.sync(() => void lanes.push({ name, path })),
          workspaceForget: () => Effect.void
        })
      )
      const migrated = Layer.provideMerge(Migrations.layer, TestDatabase.layer)
      const persistence = Layer.mergeAll(
        SqlJournal.layer({ capacity: 64, overflow: "reject" }),
        RunStore.layer,
        CacheStore.layer,
        SqlTimeTravelStore.layer,
        jj
      ).pipe(Layer.provideMerge(migrated))
      const result = yield* Effect.scoped(
        Effect.gen(function*() {
          const sql = yield* Effect.service(SqlClient.SqlClient)
          const timeTravel = yield* TimeTravel.TimeTravel
          return yield* body(timeTravel, sql)
        }).pipe(Effect.provide(TimeTravel.TimeTravel.layer.pipe(Layer.provideMerge(persistence))))
      )
      return { lanes, result }
    })

  it.effect("gives a second fork of one frame its own workspace", () =>
    Effect.gen(function*() {
      const { lanes, result } = yield* runForks((timeTravel, sql) =>
        Effect.gen(function*() {
          yield* insertParent(sql, "parent")
          const first = yield* timeTravel.fork({ runId: "parent", frame })
          const second = yield* timeTravel.fork({ runId: "parent", frame })
          return { first, second }
        })
      )

      expect(result.first.runId).not.toBe(result.second.runId)
      expect(lanes).toHaveLength(2)
      expect(lanes[0]!.name).not.toBe(lanes[1]!.name)
      expect(lanes[0]!.path).not.toBe(lanes[1]!.path)
    }))

  it.effect("names the lane after the child run, under the operator-visible smithers prefix", () =>
    Effect.gen(function*() {
      const { lanes } = yield* runForks((timeTravel, sql) =>
        Effect.gen(function*() {
          yield* insertParent(sql, "parent")
          return yield* timeTravel.fork({ runId: "parent", frame })
        })
      )

      // `jj workspace list` shows this name to an operator, so the product
      // name owns the prefix. The rest is the child run id, sanitized, and
      // the digest that restores what sanitizing folded away.
      expect(lanes[0]!.name).toMatch(/^smithers-fork-parent-fork-0-1-[0-9a-f]{8}$/)
    }))

  it.effect("gives run ids that differ only in a sanitized character distinct workspaces", () =>
    Effect.gen(function*() {
      const { lanes, result } = yield* runForks((timeTravel, sql) =>
        Effect.gen(function*() {
          yield* insertParent(sql, "demo/a")
          yield* insertParent(sql, "demo:a")
          const slashed = yield* timeTravel.fork({ runId: "demo/a", frame })
          const colonned = yield* timeTravel.fork({ runId: "demo:a", frame })
          return { colonned, slashed }
        })
      )

      expect(result.slashed.runId).not.toBe(result.colonned.runId)
      expect(lanes).toHaveLength(2)
      expect(lanes[0]!.name).not.toBe(lanes[1]!.name)
      expect(lanes[0]!.path).not.toBe(lanes[1]!.path)
    }))
})

/**
 * The frozen contract refuses a fork while ANY ancestor is live. The store's
 * walk used to follow this package's fork edges alone, so an inactive child a
 * running engine parent had spawned, recorded only through the run table's
 * `parent_run_id` or the engine's `flows_run_parents` edges, forked as if its
 * whole history were settled.
 */
describe("fork ancestry", () => {
  const frame = { lineageId: "main", seq: 0 } as const

  const insertRun = (sql: SqlClient.SqlClient, runId: string, parentRunId: string | null = null) =>
    sql`
      INSERT INTO flows_runs (run_id, status, created_at_ms, parent_run_id, state_json)
      VALUES (${runId}, 'suspended', 0, ${parentRunId}, ${
      JSON.stringify({ version: 1, flowName: "Demo", payload: {} })
    })
    `

  const insertLiveRun = (sql: SqlClient.SqlClient, runId: string) =>
    sql`
      INSERT INTO flows_runs
        (run_id, status, created_at_ms, state_json, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms)
      VALUES (${runId}, 'running', 0, ${JSON.stringify({ version: 1, flowName: "Demo", payload: {} })},
              'engine-host', 7, 'engine-nonce', 0)
    `

  const insertRecord = (sql: SqlClient.SqlClient, runId: string) =>
    sql`
      INSERT INTO flows_journal_events
        (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
      VALUES (${runId}, 0, ${`${runId}-0`}, 'source', 0, 0, 'test', '{}', ${JSON.stringify({ lineageId: "main" })})
    `

  /**
   * The real store and journal, with jj reduced to a recorder of its lanes.
   * `flows_run_parents` is created by the engine's state layer rather than
   * the migration ladder, so `engineEdges` decides whether the walk finds it.
   */
  const runForks = <A>(
    body: (timeTravel: TimeTravel.Service, sql: SqlClient.SqlClient) => Effect.Effect<A, unknown, never>,
    options: { readonly engineEdges: boolean } = { engineEdges: true }
  ) =>
    Effect.gen(function*() {
      const lanes: Array<string> = []
      const jj = Layer.succeed(
        Jj.Jj,
        Jj.makeNoop({
          workspaceAdd: (name) => Effect.sync(() => void lanes.push(name)),
          workspaceForget: () => Effect.void
        })
      )
      const migrated = Layer.provideMerge(Migrations.layer, TestDatabase.layer)
      const persistence = Layer.mergeAll(
        SqlJournal.layer({ capacity: 64, overflow: "reject" }),
        RunStore.layer,
        CacheStore.layer,
        SqlTimeTravelStore.layer,
        options.engineEdges ? DurableEngineState.layer : Layer.empty,
        jj
      ).pipe(Layer.provideMerge(migrated))
      const result = yield* Effect.scoped(
        Effect.gen(function*() {
          const sql = yield* Effect.service(SqlClient.SqlClient)
          const timeTravel = yield* TimeTravel.TimeTravel
          return yield* body(timeTravel, sql)
        }).pipe(Effect.provide(TimeTravel.TimeTravel.layer.pipe(Layer.provideMerge(persistence))))
      )
      return { lanes, result }
    })

  it.effect("refuses an inactive child whose engine parent is live through parent_run_id, before provisioning", () =>
    Effect.gen(function*() {
      const { lanes, result } = yield* runForks((timeTravel, sql) =>
        Effect.gen(function*() {
          yield* insertLiveRun(sql, "root")
          yield* insertRun(sql, "child", "root")
          yield* insertRecord(sql, "child")
          return yield* Effect.flip(timeTravel.fork({ runId: "child", frame }))
        })
      )

      expect(result).toMatchObject({ code: "live_parent", message: "ancestor run root is live" })
      expect(lanes).toEqual([])
    }))

  it.effect("refuses an inactive child whose spawning parent is live through flows_run_parents", () =>
    Effect.gen(function*() {
      const { lanes, result } = yield* runForks((timeTravel, sql) =>
        Effect.gen(function*() {
          yield* insertLiveRun(sql, "root")
          yield* insertRun(sql, "middle", "root")
          yield* insertRun(sql, "child")
          yield* insertRecord(sql, "child")
          yield* sql`INSERT INTO flows_run_parents (child_id, parent_id, seq) VALUES ('child', 'middle', 1)`
          return yield* Effect.flip(timeTravel.fork({ runId: "child", frame }))
        })
      )

      // Only the store's transactional walk sees the spawn edge, so this one
      // provisions a lane and forgets it; the refusal is what matters.
      expect(result).toMatchObject({ code: "live_parent", message: "ancestor run root is live" })
      expect(lanes).toHaveLength(1)
    }))

  it.effect("walks fork edges even where the engine's edge table is not installed", () =>
    Effect.gen(function*() {
      const { result } = yield* runForks(
        (timeTravel, sql) =>
          Effect.gen(function*() {
            yield* insertLiveRun(sql, "root")
            yield* insertRun(sql, "child")
            yield* insertRecord(sql, "child")
            yield* sql`
              INSERT INTO flows_time_travel_edges (parent_run_id, parent_seq, child_run_id, kind, attached)
              VALUES ('root', 0, 'child', 'fork', 0)
            `
            return yield* Effect.flip(timeTravel.fork({ runId: "child", frame }))
          }),
        { engineEdges: false }
      )

      expect(result).toMatchObject({ code: "live_parent", message: "ancestor run root is live" })
    }))

  it.effect("terminates on a cyclic ancestry and forks once every ancestor is settled", () =>
    Effect.gen(function*() {
      const { result } = yield* runForks((timeTravel, sql) =>
        Effect.gen(function*() {
          yield* insertRun(sql, "a")
          yield* insertRun(sql, "b", "a")
          yield* sql`UPDATE flows_runs SET parent_run_id = 'b' WHERE run_id = 'a'`
          yield* insertRecord(sql, "b")
          return yield* timeTravel.fork({ runId: "b", frame })
        })
      )

      expect(result.runId).toBe("b:fork:0:1")
    }))

  it.effect("walks every parent of a child recorded under two edges in the memory store", () =>
    Effect.gen(function*() {
      const store = Memory.make({
        records: [{ runId: "child", seq: 0, eventId: "child-0", lineageId: "child", payload: null }],
        edges: [
          { parentRunId: "settled", parentSeq: 0, childRunId: "child", kind: "fork", attached: false },
          { parentRunId: "live", parentSeq: 0, childRunId: "child", kind: "continuation", attached: false }
        ],
        liveRuns: new Set(["live"])
      })

      const failure = yield* Effect.flip(store.createFork("child", { lineageId: "child", seq: 0 }))

      expect(failure).toMatchObject({ code: "live_parent", message: "ancestor run live is live" })
    }))
})

describe("fork ancestry in the memory store", () => {
  it.effect("terminates on a diamond and a cycle, and forks once every ancestor is settled", () =>
    Effect.gen(function*() {
      // `child` is reachable through both `left` and `right`, both of which
      // hang off `root`, and `root` points back at `child`: every run is
      // enqueued more than once, and the visited set is what ends the walk.
      const store = Memory.make({
        records: [{ runId: "child", seq: 0, eventId: "child-0", lineageId: "child", payload: null }],
        edges: [
          { parentRunId: "left", parentSeq: 0, childRunId: "child", kind: "fork", attached: false },
          { parentRunId: "right", parentSeq: 0, childRunId: "child", kind: "continuation", attached: false },
          { parentRunId: "root", parentSeq: 0, childRunId: "left", kind: "child", attached: true },
          { parentRunId: "root", parentSeq: 0, childRunId: "right", kind: "child", attached: true },
          { parentRunId: "child", parentSeq: 0, childRunId: "root", kind: "continuation", attached: false }
        ]
      })

      const fork = yield* store.createFork("child", { lineageId: "child", seq: 0 })

      expect(fork.edge).toMatchObject({ parentRunId: "child", parentSeq: 0, kind: "fork" })
    }))
})

/**
 * The lane name caps the sanitized run id at 64 characters and appends a
 * digest of the RAW id, so a long id still names a bounded directory and two
 * ids that agree on their first 64 sanitized characters still get two lanes.
 */
describe("fork workspace name", () => {
  it("caps the sanitized run id segment at exactly 64 characters", () => {
    expect(TimeTravel.forkWorkspaceName("a".repeat(100))).toMatch(/^smithers-fork-a{64}-[0-9a-f]{8}$/)
  })

  it("tells apart two ids that share their first 64 sanitized characters", () => {
    const shared = "p".repeat(64)
    const left = TimeTravel.forkWorkspaceName(`${shared}:fork:0:1`)
    const right = TimeTravel.forkWorkspaceName(`${shared}:fork:0:2`)

    expect(left).toMatch(/^smithers-fork-p{64}-[0-9a-f]{8}$/)
    expect(right).toMatch(/^smithers-fork-p{64}-[0-9a-f]{8}$/)
    expect(left).not.toBe(right)
  })
})
