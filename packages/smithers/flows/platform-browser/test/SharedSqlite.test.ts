/**
 * The app's shared database as tabs see it, against real leaders over Node's
 * own Web Locks and `BroadcastChannel`, on wa-sqlite's in-memory VFS: each
 * leader opens its own connection to one file, as leaders in OPFS do.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as PubSub from "effect/PubSub"
import * as Queue from "effect/Queue"
import * as Scope from "effect/Scope"
import { BrowserRuntime, BrowserSqlite, SharedSqlite, TabChannel, WebLock } from "../src/index.ts"
import * as SqlConnection from "../src/internal/SqlConnection.ts"
import * as SqlProtocol from "../src/internal/SqlProtocol.ts"
import * as Statements from "../src/internal/Statements.ts"
import * as Engines from "./fixtures/Engines.ts"
import * as MemorySqlite from "./fixtures/MemorySqlite.ts"
import * as Telemetry from "./fixtures/Telemetry.ts"

/** A leader whose engine opens the shared database on `pool`. */
const leaderOver = (name: string, pool: Effect.Success<typeof MemorySqlite.pool>) =>
  Effect.gen(function*() {
    const database = yield* MemorySqlite.open
    return yield* Engines.leader(name, Engines.engineWithApp(name, database, Engines.steps(), pool))
  })

/** A leader, its shared database, and a tab with a table `t`. */
const setup = Effect.gen(function*() {
  const name = Engines.name()
  const pool = yield* MemorySqlite.pool
  const leader = yield* leaderOver(name, pool)
  const tab = yield* Engines.sharedTab(name)
  yield* tab.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, at TEXT, big INTEGER)")
  return { name, pool, leader, tab }
})

/** A tab in a scope of its own, so a case can end it. */
const ownTab = (name: string) =>
  Effect.gen(function*() {
    const scope = yield* Scope.make()
    const tab = yield* Engines.sharedTab(name).pipe(Scope.provide(scope))
    return { tab, close: Scope.close(scope, Exit.void) }
  })

/**
 * Runs `sql` on the shared database over a connection of its own, as another
 * program on the device could: the leader's tables are no tab's to change.
 */
const tamper = (pool: Effect.Success<typeof MemorySqlite.pool>, sql: string) =>
  Effect.acquireRelease(
    Effect.promise(() => pool.sqlite3.open_v2(SharedSqlite.filename, undefined, pool.vfs)),
    (db) => Effect.promise(() => pool.sqlite3.close(db))
  ).pipe(Effect.flatMap((db) => Effect.promise(() => pool.sqlite3.exec(db, sql))), Effect.scoped)

/**
 * A tab that speaks the protocol by hand under one client id: `send` posts a
 * request and waits for its answer, and `ready` waits for a leader to start
 * serving.
 */
const rawTab = (name: string) =>
  Effect.gen(function*() {
    const client = `raw-${crypto.randomUUID()}`
    // Held while the tab lives, as a tab's is, so the leader leaves its transaction open.
    yield* Effect.flatMap(WebLock.WebLock, (locks) => locks.hold(SqlProtocol.clientLock(name, client)))
    const port = yield* Effect.flatMap(TabChannel.TabChannel, (channels) => channels.open(SqlProtocol.channel(name)))
    const replies = yield* port.subscribe
    const next = (
      accept: (message: SqlProtocol.Message) => boolean
    ): Effect.Effect<SqlProtocol.Message, TabChannel.TabChannelOverflow> =>
      Effect.flatMap(Queue.take(replies), (input) => {
        const message = SqlProtocol.decode(input)
        return message !== undefined && accept(message) ? Effect.succeed(message) : next(accept)
      })
    return {
      send: (
        request: {
          readonly id: number
          readonly sql: string
          readonly transaction: string | null
          readonly opened?: number
        }
      ) =>
        port.post(SqlProtocol.encode({ _tag: "Execute", client, params: [], ...request })).pipe(
          Effect.andThen(next((message) =>
            (message._tag === "Executed" || message._tag === "Failed") && message.client === client &&
            message.id === request.id
          ))
        ),
      ready: next((message) => message._tag === "Ready")
    }
  }).pipe(Effect.provide(Engines.platform))

describe("SharedSqlite", () => {
  it.live("retains a BEGIN reply when its caller is interrupted", () =>
    Effect.gen(function*() {
      const name = Engines.name()
      const pool = yield* MemorySqlite.pool
      const begun = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const real = SqlConnection.layer({ filename: SharedSqlite.filename }).pipe(
        Layer.provide(Layer.succeed(BrowserSqlite.Sqlite)(pool))
      )
      const delayed = Layer.effect(
        SqlConnection.SqlConnection,
        Effect.map(SqlConnection.SqlConnection, (connection) =>
          SqlConnection.SqlConnection.of({
            ...connection,
            run: (owner, sql, params, continuing) =>
              connection.run(owner, sql, params, continuing).pipe(
                Effect.tap(() =>
                  sql === "BEGIN"
                    ? Deferred.succeed(begun, undefined).pipe(Effect.andThen(Deferred.await(release)))
                    : Effect.void
                )
              )
          }))
      ).pipe(Layer.provide(real))
      const leader = yield* Engines.leader(
        name,
        Layer.merge(Engines.engine(name, yield* MemorySqlite.open, Engines.steps()), delayed)
      )
      const tab = yield* Engines.sharedTab(name)
      const work = yield* Effect.forkChild(tab.execute("BEGIN"))
      yield* Deferred.await(begun)
      const interrupted = yield* Effect.forkChild(Fiber.interrupt(work))
      yield* Effect.sleep("20 millis")
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(interrupted)
      expect(yield* tab.execute("SELECT 1 AS n")).toEqual([{ n: 1 }])
      yield* Engines.close(leader)
      yield* leaderOver(name, pool)
      expect(yield* tab.execute("COMMIT")).toEqual([])
      const other = yield* Engines.sharedTab(name)
      expect(yield* other.execute("SELECT 1 AS n")).toEqual([{ n: 1 }])
    }).pipe(Effect.scoped))

  it.live("continues a failed opener on its leader and refuses replay after that leader ends", () =>
    Effect.gen(function*() {
      const { name, pool, leader, tab } = yield* setup
      yield* tab.execute("BEGIN; SELECT * FROM missing").pipe(Effect.flip)
      yield* tab.execute("INSERT INTO t (id) VALUES (1)")
      yield* Engines.close(leader)
      yield* leaderOver(name, pool)
      const failure = yield* tab.execute("COMMIT").pipe(Effect.flip)
      expect(failure.reason._tag).toBe("ConnectionError")
      expect(yield* tab.execute("SELECT count(*) AS n FROM t")).toEqual([{ n: 0 }])
    }).pipe(Effect.scoped))

  it.live("clears transaction state when failed SQL rolls back SQLite's transaction", () =>
    Effect.gen(function*() {
      const { tab } = yield* setup
      yield* tab.execute("BEGIN; INSERT INTO t (id) VALUES (1)")
      yield* tab.execute("INSERT INTO t (id) VALUES (1)").pipe(Effect.flip)
      yield* tab.execute("INSERT OR ROLLBACK INTO t (id) VALUES (1)").pipe(Effect.flip)
      expect(yield* tab.execute("SELECT count(*) AS n FROM t")).toEqual([{ n: 0 }])
    }).pipe(Effect.scoped))

  it.live("tracks and abandons a transaction opened by a failed statement", () =>
    Effect.gen(function*() {
      const { name, tab } = yield* setup
      const doomed = yield* ownTab(name)
      yield* doomed.tab.execute("BEGIN; SELECT * FROM missing").pipe(Effect.flip)
      const read = yield* Effect.forkChild(tab.execute("SELECT count(*) AS n FROM t"))
      yield* Effect.sleep("30 millis")
      expect(read.pollUnsafe()).toBeUndefined()
      yield* doomed.close
      expect(yield* Fiber.join(read)).toEqual([{ n: 0 }])
    }).pipe(Effect.scoped, Effect.timeout("2 seconds")))

  it.live("runs a tab's statements on the leader and returns rows as objects", () =>
    Effect.gen(function*() {
      const { tab } = yield* setup
      const at = new Date("2026-10-20T08:00:00.000Z")
      expect(yield* tab.execute("INSERT INTO t (id, at, big) VALUES (?, ?, ?)", [1, at, 1_760_000_000_000])).toEqual([])
      expect(yield* tab.execute("SELECT id, at, typeof(big) AS kind FROM t")).toEqual([
        { id: 1, at: "2026-10-20T08:00:00.000Z", kind: "integer" }
      ])
    }).pipe(Effect.scoped))

  it.live("fails a statement SQLite refuses with its SqlError, classified by SQLite's code, and keeps serving", () =>
    Effect.gen(function*() {
      const { tab } = yield* setup
      yield* tab.execute("INSERT INTO t (id) VALUES (1)")
      const duplicate = yield* tab.execute("INSERT INTO t (id) VALUES (1)").pipe(Effect.flip)
      expect(duplicate.reason._tag).toBe("ConstraintError")
      const missing = yield* tab.execute("SELECT * FROM missing").pipe(Effect.flip)
      expect(missing._tag).toBe("SqlError")
      expect(String((missing.reason.cause as { readonly message?: unknown }).message)).toContain("no such table")
      expect(yield* tab.execute("SELECT count(*) AS n FROM t")).toEqual([{ n: 1 }])
    }).pipe(Effect.scoped))

  it.live("keeps a tab's transaction its own: another tab waits, and never reads what is not committed", () =>
    Effect.gen(function*() {
      const { name, tab } = yield* setup
      const other = yield* Engines.sharedTab(name)
      yield* tab.execute("BEGIN IMMEDIATE")
      yield* tab.execute("INSERT INTO t (id) VALUES (1)")
      const read = yield* Effect.forkChild(other.execute("SELECT count(*) AS n FROM t"))
      yield* Effect.sleep("50 millis")
      expect(read.pollUnsafe()).toBeUndefined()
      yield* tab.execute("COMMIT")
      expect(yield* Fiber.join(read)).toEqual([{ n: 1 }])
    }).pipe(Effect.scoped))

  it.live("rolls back the transaction of a tab that ends, counts it, and lets the next tab in", () => {
    const telemetry = Telemetry.make()
    return telemetry.observed(
      Effect.gen(function*() {
        const { name, tab } = yield* setup
        const doomed = yield* ownTab(name)
        yield* doomed.tab.execute("BEGIN IMMEDIATE")
        yield* doomed.tab.execute("INSERT INTO t (id) VALUES (1)")
        const read = yield* Effect.forkChild(tab.execute("SELECT count(*) AS n FROM t"))
        yield* Effect.sleep("30 millis")
        expect(read.pollUnsafe()).toBeUndefined()
        yield* doomed.close
        expect(yield* Fiber.join(read)).toEqual([{ n: 0 }])
      }).pipe(Effect.scoped)
    ).pipe(Effect.andThen(Effect.sync(() => {
      expect(telemetry.count(BrowserRuntime.statements, { outcome: "abandoned" })).toBe(1)
    })))
  })

  it.live("runs a transaction again on the next leader when the one holding it ends, and carries on as if nothing happened", () => {
    const telemetry = Telemetry.make()
    const sentinel = "SENTINEL-51c2"
    return telemetry.observed(
      Effect.gen(function*() {
        const { leader, name, pool, tab } = yield* setup
        yield* tab.execute("BEGIN IMMEDIATE")
        expect(yield* tab.execute("SELECT count(*) AS n FROM t")).toEqual([{ n: 0 }])
        yield* tab.execute("INSERT INTO t (id, at) VALUES (?, ?)", [1, sentinel])
        // The leader's tab closes; its connection closes, and SQLite rolls the transaction back.
        yield* Engines.close(leader)
        yield* leaderOver(name, pool)
        // The tab runs the transaction again on the new leader, then this statement: the caller never knows.
        expect(yield* tab.execute(`INSERT INTO t (id) VALUES (2) -- ${sentinel}`)).toEqual([])
        yield* tab.execute("COMMIT")
        expect(yield* tab.execute("SELECT id, at FROM t")).toEqual([{ id: 1, at: sentinel }, { id: 2, at: null }])
      }).pipe(Effect.scoped)
    ).pipe(Effect.andThen(Effect.sync(() => {
      expect(telemetry.count(BrowserRuntime.statements, { outcome: "lost" })).toBe(1)
      const lines = telemetry.lines("browser.runtime.statement").map((line) => line.annotations)
      expect(lines).toContainEqual(
        expect.objectContaining({ outcome: "lost", "error.type": "@smthrs/platform-browser/TransactionLost" })
      )
      // No SQL, parameter or row reaches telemetry.
      expect(Telemetry.dump(telemetry)).not.toContain(sentinel)
    })))
  })

  it.live("rolls a lost transaction back when it reads otherwise on the next leader, fails the statement, and starts afresh", () =>
    Effect.gen(function*() {
      const { leader, name, pool, tab } = yield* setup
      const other = yield* Engines.sharedTab(name)
      yield* tab.execute("BEGIN IMMEDIATE")
      expect(yield* tab.execute("SELECT count(*) AS n FROM t")).toEqual([{ n: 0 }])
      yield* tab.execute("INSERT INTO t (id) VALUES (1)")
      yield* Engines.close(leader)
      yield* leaderOver(name, pool)
      // Another tab writes first, so the transaction's read would come out otherwise: running it again is refused.
      yield* other.execute("INSERT INTO t (id) VALUES (5)")
      const lost = yield* tab.execute("INSERT INTO t (id) VALUES (2)").pipe(Effect.flip)
      expect(lost.reason._tag).toBe("ConnectionError")
      expect(lost.message).toBe("The transaction ended with the leader that held it")
      // Rolled back: nothing of it stays, and the other tab isn't kept waiting.
      expect(yield* other.execute("SELECT id FROM t")).toEqual([{ id: 5 }])
      // TanStack's driver rolls back after a failure: outside any transaction, SQLite refuses it.
      yield* tab.execute("ROLLBACK").pipe(Effect.flip)
      yield* tab.execute("BEGIN IMMEDIATE")
      yield* tab.execute("INSERT INTO t (id) VALUES (3)")
      yield* tab.execute("COMMIT")
      expect(yield* tab.execute("SELECT id FROM t")).toEqual([{ id: 3 }, { id: 5 }])
    }).pipe(Effect.scoped))

  it.live("runs a lost transaction again across two leaders ending, one mid-way through running it again", () =>
    Effect.gen(function*() {
      const { leader, name, pool, tab } = yield* setup
      yield* tab.execute("BEGIN IMMEDIATE")
      yield* tab.execute("INSERT INTO t (id) VALUES (1)")
      yield* Engines.close(leader)
      const second = yield* leaderOver(name, pool)
      yield* tab.execute("INSERT INTO t (id) VALUES (2)")
      yield* Engines.close(second)
      yield* leaderOver(name, pool)
      yield* tab.execute("INSERT INTO t (id) VALUES (3)")
      yield* tab.execute("COMMIT")
      expect(yield* tab.execute("SELECT id FROM t")).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
    }).pipe(Effect.scoped))

  it.live("sends a statement no leader answered to the next leader once it is ready, and serves idle tabs too", () =>
    Effect.gen(function*() {
      const name = Engines.name()
      const pool = yield* MemorySqlite.pool
      const tab = yield* Engines.sharedTab(name)
      const idle = yield* Engines.sharedTab(name)
      const asked = yield* Effect.forkChild(tab.execute("SELECT 1 AS one"))
      yield* Effect.sleep("30 millis")
      expect(asked.pollUnsafe()).toBeUndefined()
      yield* leaderOver(name, pool)
      expect(yield* Fiber.join(asked)).toEqual([{ one: 1 }])
      expect(yield* idle.execute("SELECT 2 AS two")).toEqual([{ two: 2 }])
    }).pipe(Effect.scoped))

  it.live("runs a request posted twice once, answers only its own tab, and ignores what is not a request", () =>
    Effect.gen(function*() {
      const { name, tab } = yield* setup
      const port = yield* Effect.flatMap(TabChannel.TabChannel, (channels) => channels.open(SqlProtocol.channel(name)))
        .pipe(Effect.provide(TabChannel.layer))
      const replies = yield* port.subscribe
      const request = SqlProtocol.encode({
        _tag: "Execute",
        client: "stranger",
        id: 0,
        sql: "INSERT INTO t (id) VALUES (9)",
        params: [],
        transaction: null
      })
      yield* port.post("not a message")
      yield* port.post(request)
      yield* port.post(request)
      const reply = SqlProtocol.decode(yield* Queue.take(replies))
      expect(reply).toMatchObject({ _tag: "Executed", client: "stranger", id: 0, open: false })
      // The stranger's reply reached this tab too, which ignored it.
      expect(yield* tab.execute("SELECT id FROM t")).toEqual([{ id: 9 }])
    }).pipe(Effect.scoped))

  it.live("answers a statement that committed its transaction as the leader ended as committed, and never runs it twice", () => {
    const telemetry = Telemetry.make()
    return telemetry.observed(
      Effect.gen(function*() {
        const { leader, name, pool, tab } = yield* setup
        // A tab speaking the protocol by hand, so the old leader's answer to its COMMIT can go unread.
        const raw = yield* rawTab(name)
        const begun = yield* raw.send({ id: 0, sql: "BEGIN IMMEDIATE", transaction: null })
        expect(begun).toMatchObject({ _tag: "Executed", open: true })
        const held = (begun as { readonly leader: string }).leader
        yield* raw.send({ id: 1, sql: "INSERT INTO t (id) VALUES (1)", transaction: held, opened: 0 })
        const commit = { id: 2, sql: "COMMIT", transaction: held, opened: 0 }
        expect(yield* raw.send(commit)).toMatchObject({ _tag: "Executed", open: false })
        // A suspended tab can outlive any wall-clock retention period. Only the leader may change its receipts.
        yield* tamper(pool, `UPDATE ${SqlProtocol.commits} SET at = 0`)
        yield* Engines.close(leader)
        yield* leaderOver(name, pool)
        yield* raw.ready
        // The tab never saw that answer, so it sends the COMMIT again: the new leader says it committed.
        expect(yield* raw.send(commit)).toMatchObject({ _tag: "Executed", rows: [], open: false })
        expect(yield* tab.execute("SELECT id FROM t")).toEqual([{ id: 1 }])
      }).pipe(Effect.scoped)
    ).pipe(Effect.andThen(Effect.sync(() => {
      expect(telemetry.count(BrowserRuntime.statements, { outcome: "committed" })).toBe(1)
    })))
  })

  it.live("refuses a statement of a transaction an ended leader held when it didn't commit, or says nothing of its start", () =>
    Effect.gen(function*() {
      const { leader, name, pool } = yield* setup
      const raw = yield* rawTab(name)
      const begun = yield* raw.send({ id: 0, sql: "BEGIN IMMEDIATE", transaction: null })
      const held = (begun as { readonly leader: string }).leader
      yield* raw.send({ id: 1, sql: "INSERT INTO t (id) VALUES (1)", transaction: held, opened: 0 })
      yield* Engines.close(leader)
      yield* leaderOver(name, pool)
      yield* raw.ready
      const lost = { _tag: "Failed", error: "@smthrs/platform-browser/TransactionLost" }
      expect(yield* raw.send({ id: 2, sql: "COMMIT", transaction: held, opened: 0 })).toMatchObject(lost)
      expect(yield* raw.send({ id: 3, sql: "COMMIT", transaction: held })).toMatchObject(lost)
      expect(yield* raw.send({ id: 4, sql: "SELECT count(*) AS n FROM t", transaction: null })).toMatchObject({
        rows: [{ n: 0 }]
      })
    }).pipe(Effect.scoped))

  it.live("commits nothing it can't record when another table stands where the leader records receipts, and serves reads", () => {
    const telemetry = Telemetry.make()
    return telemetry.observed(
      Effect.gen(function*() {
        const { leader, name, pool, tab } = yield* setup
        yield* Engines.close(leader)
        yield* tamper(pool, `DROP TABLE ${SqlProtocol.commits}; CREATE TABLE ${SqlProtocol.commits} (x INTEGER)`)
        yield* leaderOver(name, pool)
        // The receipt can't be written, so the transaction is rolled back and the statement that opened it fails.
        const opened = yield* tab.execute("BEGIN IMMEDIATE; INSERT INTO t (id) VALUES (1)").pipe(Effect.flip)
        expect(opened.reason.cause).toMatchObject({ name: "@smthrs/platform-browser/TransactionUnrecorded" })
        // A write outside a transaction can't carry its receipt either, so it is rolled back too.
        const single = yield* tab.execute("INSERT INTO t (id) VALUES (2)").pipe(Effect.flip)
        expect(single.reason.cause).toMatchObject({ name: "@smthrs/platform-browser/TransactionUnrecorded" })
        // A read commits nothing, and runs.
        expect(yield* tab.execute("SELECT id FROM t")).toEqual([])
      }).pipe(Effect.scoped)
    ).pipe(Effect.andThen(Effect.sync(() => {
      const lines = telemetry.lines("browser.runtime.statement").map((line) => line.annotations)
      expect(lines).toContainEqual(expect.objectContaining({ outcome: "unprepared", "error.type": "SqlError" }))
      expect(telemetry.count(BrowserRuntime.statements, { outcome: "unrecorded" })).toBe(2)
    })))
  })

  it.live("refuses statements when the leader's engine opened no shared database", () =>
    Effect.gen(function*() {
      const name = Engines.name()
      yield* Engines.leader(name, Engines.engine(name, yield* MemorySqlite.open, Engines.steps()))
      const refused = yield* Effect.flatMap(SharedSqlite.SharedSqlite, (tab) => tab.execute("SELECT 1")).pipe(
        Effect.provide(SharedSqlite.layer({ name })),
        Effect.flip
      )
      expect(refused._tag).toBe("SqlError")
      expect(refused.reason.cause).toMatchObject({ name: "@smthrs/platform-browser/DatabaseUnavailable" })
    }).pipe(Effect.scoped))
})

/** Faults a case injects into a leader's connection to the shared database, read at each statement. */
interface Faults {
  /** The next `COMMIT` commits and is never answered, as when the leader's tab closes right then. */
  hangAfterCommit: boolean
  /** Reading the record of tabs' transactions fails, as on an I/O error. */
  refuseRecordRead: boolean
  /** The next statement with this SQL runs and is never answered, as when the leader's tab closes right then. */
  hangAfter?: string | undefined
  /** The next batch runs and is never answered, as when the leader's tab closes right then. */
  hangAfterBatch?: boolean
}

/**
 * A leader whose connection to the shared database carries `faults`, a test
 * `SqlConnection` over the real one. `committed` completes when a `COMMIT` it
 * will never answer has committed.
 */
const faultyLeaderOver = (name: string, pool: Effect.Success<typeof MemorySqlite.pool>, faults: Faults) =>
  Effect.gen(function*() {
    const committed = yield* Deferred.make<void>()
    const real = SqlConnection.layer({ filename: SharedSqlite.filename }).pipe(
      Layer.provide(Layer.succeed(BrowserSqlite.Sqlite)(pool))
    )
    const faulty = Layer.effect(
      SqlConnection.SqlConnection,
      Effect.map(SqlConnection.SqlConnection, (connection) =>
        SqlConnection.SqlConnection.of({
          abandon: connection.abandon,
          isOpen: connection.isOpen,
          opened: connection.opened,
          runBatch: (owner, statements, continuing, request) =>
            connection.runBatch(owner, statements, continuing, request).pipe(
              Effect.tap(() =>
                faults.hangAfterBatch ?
                  Deferred.succeed(committed, undefined).pipe(Effect.andThen(Effect.never))
                  : Effect.void
              )
            ),
          run: ((
            owner: string,
            sql: string,
            params: ReadonlyArray<unknown>,
            continuing: boolean,
            request?: SqlConnection.Request
          ) =>
            faults.refuseRecordRead && sql.startsWith("SELECT opened") ?
              Effect.fail(Statements.failed({ code: 10, message: "disk I/O error" }, "Failed to read", "execute"))
              : connection.run(owner, sql, params, continuing, request).pipe(
                Effect.tap(() =>
                  (faults.hangAfterCommit && sql === "COMMIT") || sql === faults.hangAfter ?
                    Deferred.succeed(committed, undefined).pipe(Effect.andThen(Effect.never))
                    : Effect.void
                )
              )) as SqlConnection.Service["run"]
        }))
    ).pipe(Layer.provide(real))
    const database = yield* MemorySqlite.open
    const fiber = yield* Engines.leader(name, Layer.merge(Engines.engine(name, database, Engines.steps()), faulty))
    return { fiber, committed: Deferred.await(committed) }
  })

/** Runs `work` until it settles, or until `leader` commits a `COMMIT` it never answers; then returns `"committed"`. */
const untilCommitted = <A, E>(
  work: Fiber.Fiber<A, E>,
  leader: { readonly committed: Effect.Effect<void> }
) =>
  Effect.raceFirst(
    leader.committed.pipe(Effect.as("committed" as const)),
    Fiber.await(work).pipe(Effect.as("settled" as const))
  )

describe("SharedSqlite across a handover", () => {
  it.live("never commits a transaction twice when the leader can't record it: the statement that opens it fails, and a recorded one lands once", () => {
    const telemetry = Telemetry.make()
    return telemetry.observed(
      Effect.gen(function*() {
        const name = Engines.name()
        const pool = yield* MemorySqlite.pool
        const faults: Faults = { hangAfterCommit: true, refuseRecordRead: false }
        const first = yield* faultyLeaderOver(name, pool, faults)
        const tab = yield* Engines.sharedTab(name)
        yield* tab.execute("CREATE TABLE log (v TEXT)")
        // Writing the receipt fails as a full disk would, inside the transaction the tab opens next.
        yield* tamper(
          pool,
          `CREATE TRIGGER refuse_record BEFORE INSERT ON ${SqlProtocol.commits} BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`
        )
        const transaction = (value: string) =>
          Effect.gen(function*() {
            yield* tab.execute("BEGIN IMMEDIATE")
            yield* tab.execute("INSERT INTO log (v) VALUES (?)", [value])
            yield* tab.execute("COMMIT")
          })
        const unrecorded = yield* Effect.forkChild(transaction("unrecorded"))
        if ((yield* untilCommitted(unrecorded, first)) === "committed") {
          // The leader committed and its tab closed before it answered: the next leader takes the COMMIT.
          yield* Engines.close(first.fiber)
          yield* leaderOver(name, pool)
        }
        const exit = yield* Fiber.await(unrecorded)
        // Nothing of it landed, and the caller is told it failed: never told once and applied twice.
        expect(yield* tab.execute("SELECT v FROM log")).toEqual([])
        expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit).toMatchObject({
          _tag: "SqlError",
          reason: { cause: { name: "@smthrs/platform-browser/TransactionUnrecorded" } }
        })
        // Outside a transaction the tab is served, and nothing is left holding the connection.
        yield* tamper(pool, "DROP TRIGGER refuse_record")
        // Recorded, the same handover lands the transaction exactly once.
        const recorded = yield* Effect.forkChild(transaction("recorded"))
        expect(yield* untilCommitted(recorded, first)).toBe("committed")
        yield* Engines.close(first.fiber)
        yield* faultyLeaderOver(name, pool, { hangAfterCommit: false, refuseRecordRead: false })
        yield* Fiber.join(recorded)
        expect(yield* tab.execute("SELECT v FROM log")).toEqual([{ v: "recorded" }])
      }).pipe(Effect.scoped)
    ).pipe(Effect.andThen(Effect.sync(() => {
      expect(telemetry.count(BrowserRuntime.statements, { outcome: "unrecorded" })).toBe(1)
      expect(telemetry.count(BrowserRuntime.statements, { outcome: "committed" })).toBe(1)
      expect(telemetry.lines("browser.runtime.statement").map((line) => line.annotations)).toContainEqual(
        expect.objectContaining({
          outcome: "unrecorded",
          "error.type": "@smthrs/platform-browser/TransactionUnrecorded"
        })
      )
    })))
  })

  it.live("lands once a transaction one request rolled back and opened again, when the leader ended as it committed", () => {
    const telemetry = Telemetry.make()
    return telemetry.observed(
      Effect.gen(function*() {
        const name = Engines.name()
        const pool = yield* MemorySqlite.pool
        const first = yield* faultyLeaderOver(name, pool, { hangAfterCommit: true, refuseRecordRead: false })
        const tab = yield* Engines.sharedTab(name)
        yield* tab.execute("CREATE TABLE log (v TEXT)")
        const work = yield* Effect.forkChild(Effect.gen(function*() {
          yield* tab.execute("BEGIN IMMEDIATE")
          yield* tab.execute("INSERT INTO log (v) VALUES ('discarded')")
          // The transaction the COMMIT ends is the one this request opened, not the first.
          yield* tab.execute("ROLLBACK; BEGIN IMMEDIATE")
          yield* tab.execute("INSERT INTO log (v) VALUES ('once')")
          yield* tab.execute("COMMIT")
        }))
        expect(yield* untilCommitted(work, first)).toBe("committed")
        yield* Engines.close(first.fiber)
        yield* leaderOver(name, pool)
        expect(Exit.isSuccess(yield* Fiber.await(work))).toBe(true)
        expect(yield* tab.execute("SELECT v FROM log")).toEqual([{ v: "once" }])
      }).pipe(Effect.scoped)
    ).pipe(Effect.andThen(Effect.sync(() => {
      expect(telemetry.count(BrowserRuntime.statements, { outcome: "committed" })).toBe(1)
      expect(telemetry.count(BrowserRuntime.statements, { outcome: "lost" })).toBe(0)
    })))
  })

  it.live("never runs a transaction again when the next leader can't read whether it committed: it asks again on the tab's next statement", () => {
    const telemetry = Telemetry.make()
    return telemetry.observed(
      Effect.gen(function*() {
        const name = Engines.name()
        const pool = yield* MemorySqlite.pool
        const first = yield* faultyLeaderOver(name, pool, { hangAfterCommit: true, refuseRecordRead: false })
        const tab = yield* Engines.sharedTab(name)
        yield* tab.execute("CREATE TABLE log (v TEXT)")
        const work = yield* Effect.forkChild(Effect.gen(function*() {
          yield* tab.execute("BEGIN IMMEDIATE")
          yield* tab.execute("INSERT INTO log (v) VALUES ('once')")
          yield* tab.execute("COMMIT")
        }))
        expect(yield* untilCommitted(work, first)).toBe("committed")
        yield* Engines.close(first.fiber)
        const faults: Faults = { hangAfterCommit: false, refuseRecordRead: true }
        yield* faultyLeaderOver(name, pool, faults)
        // The new leader can't tell whether the COMMIT committed: it says so, and runs nothing.
        const undecided = yield* Fiber.await(work)
        expect(yield* tab.execute("SELECT v FROM log").pipe(Effect.option)).not.toEqual(
          Option.some([{ v: "once" }, { v: "once" }])
        )
        expect(Exit.isFailure(undecided) ? Cause.squash(undecided.cause) : undecided).toMatchObject({
          _tag: "SqlError",
          reason: { cause: { name: "@smthrs/platform-browser/TransactionUndecided" } }
        })
        faults.refuseRecordRead = false
        // TanStack's driver rolls back after a failure: the leader reads the record now, and it committed.
        expect(yield* tab.execute("ROLLBACK")).toEqual([])
        expect(yield* tab.execute("SELECT v FROM log")).toEqual([{ v: "once" }])
      }).pipe(Effect.scoped)
    ).pipe(Effect.andThen(Effect.sync(() => {
      // The COMMIT, and the read the tab sent while the record was unreadable.
      expect(telemetry.count(BrowserRuntime.statements, { outcome: "undecided" })).toBe(2)
      expect(telemetry.count(BrowserRuntime.statements, { outcome: "lost" })).toBe(0)
      expect(telemetry.lines("browser.runtime.statement").map((line) => line.annotations)).toContainEqual(
        expect.objectContaining({
          outcome: "undecided",
          "error.type": "@smthrs/platform-browser/TransactionUndecided"
        })
      )
    })))
  })
})

describe("SharedSqlite across a handover, outside a transaction", () => {
  it.live("never runs a write twice when the leader ends before answering it: the next leader answers it as committed", () => {
    const telemetry = Telemetry.make()
    return telemetry.observed(
      Effect.gen(function*() {
        const name = Engines.name()
        const pool = yield* MemorySqlite.pool
        const write = "INSERT INTO log (v) VALUES ('once')"
        const first = yield* faultyLeaderOver(name, pool, {
          hangAfterCommit: false,
          refuseRecordRead: false,
          hangAfter: write
        })
        const tab = yield* Engines.sharedTab(name)
        yield* tab.execute("CREATE TABLE log (v TEXT)")
        const work = yield* Effect.forkChild(tab.execute(write))
        // The write committed on its own, and the leader's tab closed before it answered.
        expect(yield* untilCommitted(work, first)).toBe("committed")
        yield* Engines.close(first.fiber)
        yield* leaderOver(name, pool)
        // The tab sends it again; the new leader finds its receipt and runs nothing.
        expect(yield* Fiber.join(work)).toEqual([])
        expect(yield* tab.execute("SELECT v FROM log")).toEqual([{ v: "once" }])
      }).pipe(Effect.scoped)
    ).pipe(Effect.andThen(Effect.sync(() => {
      expect(telemetry.count(BrowserRuntime.statements, { outcome: "committed" })).toBe(1)
    })))
  })

  it.live("refuses a write the next leader can't tell committed, and still serves a read", () =>
    Effect.gen(function*() {
      const name = Engines.name()
      const pool = yield* MemorySqlite.pool
      const write = "INSERT INTO log (v) VALUES ('once')"
      const first = yield* faultyLeaderOver(name, pool, {
        hangAfterCommit: false,
        refuseRecordRead: false,
        hangAfter: write
      })
      const tab = yield* Engines.sharedTab(name)
      const reader = yield* Engines.sharedTab(name)
      yield* tab.execute("CREATE TABLE log (v TEXT)")
      const work = yield* Effect.forkChild(tab.execute(write))
      expect(yield* untilCommitted(work, first)).toBe("committed")
      yield* Engines.close(first.fiber)
      yield* faultyLeaderOver(name, pool, { hangAfterCommit: false, refuseRecordRead: true })
      const undecided = yield* Fiber.await(work)
      expect(Exit.isFailure(undecided) ? Cause.squash(undecided.cause) : undecided).toMatchObject({
        _tag: "SqlError",
        reason: { cause: { name: "@smthrs/platform-browser/TransactionUndecided" } }
      })
      // A tab's first read on the new leader runs although its receipt can't be read: a read commits nothing.
      expect(yield* reader.execute("SELECT v FROM log")).toEqual([{ v: "once" }])
    }).pipe(Effect.scoped))
})

describe("SharedSqlite receipts across leaders", () => {
  it.live("answers a write the old leader committed with the rows it returned", () =>
    Effect.gen(function*() {
      const name = Engines.name()
      const pool = yield* MemorySqlite.pool
      const write = "INSERT INTO log (v) VALUES ('once') RETURNING v, length(v) AS n"
      const first = yield* faultyLeaderOver(name, pool, {
        hangAfterCommit: false,
        refuseRecordRead: false,
        hangAfter: write
      })
      const tab = yield* Engines.sharedTab(name)
      yield* tab.execute("CREATE TABLE log (v TEXT)")
      const work = yield* Effect.forkChild(tab.execute(write))
      expect(yield* untilCommitted(work, first)).toBe("committed")
      yield* Engines.close(first.fiber)
      yield* leaderOver(name, pool)
      expect(yield* Fiber.join(work)).toEqual([{ v: "once", n: 4 }])
      expect(yield* tab.execute("SELECT v FROM log")).toEqual([{ v: "once" }])
    }).pipe(Effect.scoped))

  it.live("keeps a tab's receipt however old while the tab lives, and forgets it once the tab ends", () =>
    Effect.gen(function*() {
      const { leader, name, pool, tab } = yield* setup
      const short = yield* ownTab(name)
      yield* short.tab.execute("INSERT INTO t (id) VALUES (1)")
      yield* Engines.close(leader)
      // Both receipts a week old: age is no reason to forget one a tab may still need.
      yield* tamper(pool, `UPDATE ${SqlProtocol.commits} SET at = 0`)
      yield* leaderOver(name, pool)
      const receipts = Effect.map(tab.execute(`SELECT count(*) AS n FROM ${SqlProtocol.commits}`), (rows) => rows)
      expect(yield* receipts).toEqual([{ n: 2 }])
      yield* short.close
      while ((yield* receipts)[0]?.["n" as never] !== 1) yield* Effect.sleep("5 millis")
      expect(yield* receipts).toEqual([{ n: 1 }])
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")))
})

describe("SharedSqlite.open", () => {
  it.live("resolves once a leader answers, runs statements as Promises, and closes", () =>
    Effect.gen(function*() {
      const name = Engines.name()
      yield* leaderOver(name, yield* MemorySqlite.pool)
      const database = yield* Effect.promise(() => SharedSqlite.open({ name }))
      const rows = yield* Effect.promise(() => database.execute<{ readonly two: number }>("SELECT ? AS two", [2]))
      expect(rows).toEqual([{ two: 2 }])
      const refused = yield* Effect.promise(() => database.execute("SELECT * FROM missing").catch((error) => error))
      expect(refused).toMatchObject({ name: "SQLiteError", message: "no such table: missing", code: 1 })
      yield* Effect.promise(() => database.close())
      // The leader takes the tab's lock for a moment once it comes free, to forget the tab's receipt.
      const held = Effect.map(
        Effect.promise(() => navigator.locks.query()),
        (state) => (state.held ?? []).some((lock) => lock.name?.startsWith(`${name}/sql/`))
      )
      while (yield* held) yield* Effect.sleep("5 millis")
    }).pipe(Effect.scoped))

  it.live("rejects a statement SQLite refuses with SQLite's own message and code, as wa-sqlite does", () =>
    Effect.gen(function*() {
      const name = Engines.name()
      yield* leaderOver(name, yield* MemorySqlite.pool)
      const database = yield* Effect.promise(() => SharedSqlite.open({ name }))
      yield* Effect.promise(() => database.execute("CREATE TABLE t (id INTEGER)"))
      yield* Effect.promise(() => database.execute("ALTER TABLE t ADD COLUMN c TEXT"))
      // TanStack DB's persistence adds a column and treats exactly this message as "already there".
      const duplicate = yield* Effect.promise(() =>
        database.execute("ALTER TABLE t ADD COLUMN c TEXT").then(() => undefined, (error: unknown) => error)
      )
      expect(duplicate).toBeInstanceOf(SharedSqlite.SqliteError)
      expect(duplicate).toMatchObject({ message: "duplicate column name: c", code: 1 })
      expect((duplicate as Error).cause).toMatchObject({ _tag: "SqlError" })
      yield* Effect.promise(() => database.close())
    }).pipe(Effect.scoped))

  it.live("rejects a statement SQLite never saw with the SqlError's message and no code", () =>
    Effect.gen(function*() {
      const name = Engines.name()
      const pool = yield* MemorySqlite.pool
      const leader = yield* leaderOver(name, pool)
      const database = yield* Effect.promise(() => SharedSqlite.open({ name }))
      const other = yield* Effect.promise(() => SharedSqlite.open({ name }))
      yield* Effect.promise(() => database.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)"))
      yield* Effect.promise(() => database.execute("BEGIN IMMEDIATE"))
      yield* Effect.promise(() => database.execute("SELECT count(*) AS n FROM t"))
      yield* Engines.close(leader)
      yield* leaderOver(name, pool)
      yield* Effect.promise(() => other.execute("INSERT INTO t (id) VALUES (1)"))
      const lost = yield* Effect.promise(() =>
        database.execute("SELECT 1").then(() => undefined, (error: unknown) => error)
      )
      expect(lost).toBeInstanceOf(SharedSqlite.SqliteError)
      expect(lost).toMatchObject({ message: "The transaction ended with the leader that held it", code: undefined })
      yield* Effect.promise(() => Promise.all([database.close(), other.close()]))
    }).pipe(Effect.scoped))

  it.live("rejects when no leader answers in time, and lets go of what it opened", () =>
    Effect.gen(function*() {
      const name = Engines.name()
      const refused = yield* Effect.promise(() =>
        SharedSqlite.open({ name, within: "50 millis" }).then(() => undefined, (error: unknown) => error)
      )
      expect(refused).toMatchObject({ _tag: "SqlError", reason: { _tag: "ConnectionError" } })
      const state = yield* Effect.promise(() => navigator.locks.query())
      expect((state.held ?? []).some((lock) => lock.name?.startsWith(`${name}/sql/`))).toBe(false)
    }))
})

/** Counts the requests tabs send on `name`'s database channel. */
const requests = (name: string) =>
  Effect.gen(function*() {
    const port = yield* Effect.flatMap(TabChannel.TabChannel, (channels) => channels.open(SqlProtocol.channel(name)))
    const inbox = yield* port.subscribe
    const sent: Array<SqlProtocol.Message> = []
    yield* Queue.take(inbox).pipe(
      Effect.map((input) => {
        const message = SqlProtocol.decode(input)
        if (message?._tag === "Execute") sent.push(message)
      }),
      Effect.forever,
      Effect.forkScoped
    )
    return sent
  }).pipe(Effect.provide(Engines.platform))

/**
 * A leader of a build that knows no batches: it runs a batch's `sql` and answers no `results`, and answers every
 * other statement with its own SQL as its one row.
 */
const olderLeader = (name: string) =>
  Effect.gen(function*() {
    const port = yield* Effect.flatMap(TabChannel.TabChannel, (channels) => channels.open(SqlProtocol.channel(name)))
    const inbox = yield* port.subscribe
    yield* Queue.take(inbox).pipe(
      Effect.flatMap((input) => {
        const message = SqlProtocol.decode(input)
        if (message?._tag !== "Execute") return Effect.void
        return port.post(SqlProtocol.encode({
          _tag: "Executed",
          client: message.client,
          id: message.id,
          leader: "older",
          rows: message.sql === SqlProtocol.batchSql ? [] : [{ sql: message.sql }],
          open: false
        }))
      }),
      Effect.forever,
      Effect.forkScoped
    )
    yield* port.post(SqlProtocol.encode({ _tag: "Ready" }))
  }).pipe(Effect.provide(Engines.platform))

describe("SharedSqlite batches", () => {
  it.live("runs a batch in one request and answers each statement's rows; an empty batch sends none", () =>
    Effect.gen(function*() {
      const name = Engines.name()
      yield* leaderOver(name, yield* MemorySqlite.pool)
      const database = yield* Effect.promise(() => SharedSqlite.open({ name }))
      yield* Effect.promise(() => database.execute("CREATE TABLE log (v TEXT)"))
      const sent = yield* requests(name)
      const results = yield* Effect.promise(() =>
        database.executeBatch([
          { sql: "BEGIN IMMEDIATE" },
          { sql: "INSERT INTO log (v) VALUES (?) RETURNING v", params: ["a"] },
          { sql: "SELECT count(*) AS n FROM log" },
          { sql: "COMMIT" }
        ])
      )
      expect(results).toEqual([[], [{ v: "a" }], [{ n: 1 }], []])
      expect(yield* Effect.promise(() => database.executeBatch([]))).toEqual([])
      while (sent.length < 1) yield* Effect.sleep("5 millis")
      expect(sent).toHaveLength(1)
      yield* Effect.promise(() => database.close())
    }).pipe(Effect.scoped))

  it.live("fails with the first statement SQLite refuses, runs none after it, and commits nothing of a batch outside a transaction", () =>
    Effect.gen(function*() {
      const name = Engines.name()
      yield* leaderOver(name, yield* MemorySqlite.pool)
      const database = yield* Effect.promise(() => SharedSqlite.open({ name }))
      yield* Effect.promise(() => database.execute("CREATE TABLE log (v TEXT)"))
      const refused = yield* Effect.promise(() =>
        database.executeBatch([
          { sql: "INSERT INTO log (v) VALUES ('a')" },
          { sql: "SELECT * FROM missing" },
          { sql: "INSERT INTO log (v) VALUES ('b')" }
        ]).then(() => undefined, (error: unknown) => error)
      )
      expect(refused).toBeInstanceOf(SharedSqlite.SqliteError)
      expect(refused).toMatchObject({ message: "no such table: missing", code: 1 })
      expect(yield* Effect.promise(() => database.execute("SELECT v FROM log"))).toEqual([])
      // In a transaction the batch opened, the transaction stays open for the caller to roll back.
      const inside = yield* Effect.promise(() =>
        database.executeBatch([
          { sql: "BEGIN IMMEDIATE" },
          { sql: "INSERT INTO log (v) VALUES ('c')" },
          { sql: "SELECT * FROM missing" },
          { sql: "COMMIT" }
        ]).then(() => undefined, (error: unknown) => error)
      )
      expect(inside).toMatchObject({ message: "no such table: missing" })
      expect(yield* Effect.promise(() => database.execute("SELECT v FROM log"))).toEqual([{ v: "c" }])
      yield* Effect.promise(() => database.execute("ROLLBACK"))
      expect(yield* Effect.promise(() => database.execute("SELECT v FROM log"))).toEqual([])
      yield* Effect.promise(() => database.close())
    }).pipe(Effect.scoped))

  it.live("sends a batch's statements one at a time to a leader that knows no batches", () =>
    Effect.gen(function*() {
      const name = Engines.name()
      yield* olderLeader(name)
      const tab = yield* Effect.promise(() => SharedSqlite.open({ name }))
      const sent = yield* requests(name)
      const results = yield* Effect.promise(() =>
        tab.executeBatch([{ sql: "SELECT 1" }, { sql: "SELECT ?", params: [2] }])
      )
      expect(results).toEqual([[{ sql: "SELECT 1" }], [{ sql: "SELECT ?" }]])
      while (sent.length < 3) yield* Effect.sleep("5 millis")
      expect(sent.map((message) => message._tag === "Execute" && message.sql)).toEqual([
        SqlProtocol.batchSql,
        "SELECT 1",
        "SELECT ?"
      ])
      yield* Effect.promise(() => tab.close())
    }).pipe(Effect.scoped))

  it.live("answers a batch the old leader committed with each statement's rows, and runs it once", () =>
    Effect.gen(function*() {
      const name = Engines.name()
      const pool = yield* MemorySqlite.pool
      const faults: Faults = { hangAfterCommit: false, refuseRecordRead: false }
      const first = yield* faultyLeaderOver(name, pool, faults)
      const database = yield* Effect.promise(() => SharedSqlite.open({ name }))
      yield* Effect.promise(() => database.execute("CREATE TABLE log (v TEXT)"))
      faults.hangAfterBatch = true
      const batch = (value: string) =>
        Effect.promise(() =>
          database.executeBatch([
            { sql: "BEGIN IMMEDIATE" },
            { sql: "INSERT INTO log (v) VALUES (?) RETURNING v", params: [value] },
            { sql: "SELECT count(*) AS n FROM log" },
            { sql: "COMMIT" }
          ])
        )
      const work = yield* Effect.forkChild(batch("once"))
      expect(yield* untilCommitted(work, first)).toBe("committed")
      yield* Engines.close(first.fiber)
      const second = yield* faultyLeaderOver(name, pool, {
        hangAfterCommit: false,
        refuseRecordRead: false,
        hangAfterBatch: true
      })
      expect(yield* Fiber.join(work)).toEqual([[], [{ v: "once" }], [{ n: 1 }], []])
      // A batch that returned no rows keeps no reply: the next leader answers each statement's rows as none.
      const quiet = yield* Effect.forkChild(
        Effect.promise(() =>
          database.executeBatch([{ sql: "INSERT INTO log (v) VALUES ('a')" }, {
            sql: "INSERT INTO log (v) VALUES ('b')"
          }])
        )
      )
      expect(yield* untilCommitted(quiet, second)).toBe("committed")
      yield* Engines.close(second.fiber)
      yield* leaderOver(name, pool)
      expect(yield* Fiber.join(quiet)).toEqual([[], []])
      expect(yield* Effect.promise(() => database.execute("SELECT v FROM log"))).toEqual([
        { v: "once" },
        { v: "a" },
        { v: "b" }
      ])
      yield* Effect.promise(() => database.close())
    }).pipe(Effect.scoped))
})
