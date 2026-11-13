/**
 * The leader's one connection to the app's database, shared by every tab.
 *
 * Tabs send statements one at a time, and a tab's transaction spans several
 * of them, so the connection belongs to one tab from the statement that
 * opens a transaction to the one that ends it: SQLite's own autocommit flag
 * says which. Another tab's statement waits until then, so it never runs
 * inside a transaction it did not open, nor reads rows one did not commit.
 *
 * Every change a tab's request commits carries the request's receipt
 * (`SqlProtocol.commits`) in the same SQLite transaction, so a later leader
 * can tell whether the request committed and never runs it twice:
 *
 * - A transaction a request opens is receipted inside it at once, after the
 *   statement that opened it, and again after a rollback to a savepoint that
 *   took the receipt with it.
 * - SQLite's commit hook refuses any commit of a tab's change that carries no
 *   receipt, or that comes before the request's last statement, so a request
 *   commits at most once. A request whose change would commit on its own,
 *   outside a transaction, runs again inside a transaction the connection
 *   opens with its receipt, so all of it commits or none does. A request that
 *   both does that and opens a transaction of its own fails as SQLite fails a
 *   nested `BEGIN`.
 * - The rows a committed request returned are kept beside its receipt
 *   (`SqlProtocol.replies`), so a later leader answers it with them.
 * - SQLite's authorizer refuses a tab's statement that would change the
 *   leader's tables or hang a trigger on them.
 * - A read commits nothing, so it never pays for a receipt.
 *
 * @since 1.0.0
 */

import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import type { SqlError } from "effect/sql/SqlError"
import * as BrowserSqlite from "../BrowserSqlite.ts"
import { statements } from "./Metrics.ts"
import * as SqlProtocol from "./SqlProtocol.ts"
import * as Statements from "./Statements.ts"

/**
 * What one statement returned: its rows, and whether it left a transaction
 * open that the same owner continues.
 *
 * @category models
 * @since 1.0.0
 */
export interface Result {
  readonly rows: ReadonlyArray<unknown>
  readonly open: boolean
}

/**
 * What a batch of statements returned: the rows of each, in order, and
 * whether the batch left a transaction open that the same owner continues.
 *
 * @category models
 * @since 1.0.0
 */
export interface BatchResult {
  readonly results: ReadonlyArray<ReadonlyArray<unknown>>
  readonly open: boolean
}

/**
 * The tab's request a statement runs for: `id`, its number, names it in the
 * receipt of every change it commits, and `at` is when it arrived. With
 * `undecided`, an earlier leader may have committed it and this one could not
 * read whether it did, so nothing of it may commit.
 *
 * @category models
 * @since 1.0.0
 */
export interface Request {
  readonly id: number
  readonly at: number
  readonly undecided: boolean
}

/**
 * The owner's transaction is gone: rolled back because its tab ended, or held
 * by a leader that stopped.
 *
 * @category errors
 * @since 1.0.0
 */
export class TransactionLost extends Schema.TaggedError<TransactionLost>()(
  "@smthrs/platform-browser/TransactionLost",
  {}
) {}

/**
 * The connection could not record a request's receipt with what it changed,
 * so it rolled the change back: unrecorded, a later leader could not tell
 * whether it committed.
 *
 * @category errors
 * @since 1.0.0
 */
export class TransactionUnrecorded extends Schema.TaggedError<TransactionUnrecorded>()(
  "@smthrs/platform-browser/TransactionUnrecorded",
  {}
) {}

/**
 * The leader could not read whether an earlier leader committed a request,
 * so it committed nothing of it.
 *
 * @category errors
 * @since 1.0.0
 */
export class TransactionUndecided extends Schema.TaggedError<TransactionUndecided>()(
  "@smthrs/platform-browser/TransactionUndecided",
  {}
) {}

/**
 * A tab cannot compact the shared database: `VACUUM` rebuilds the leader's
 * receipt tables and cannot run inside a receipted transaction.
 *
 * @category errors
 * @since 1.0.0
 */
export class VacuumUnsupported extends Schema.TaggedError<VacuumUnsupported>()(
  "@smthrs/platform-browser/VacuumUnsupported",
  {}
) {}

/**
 * Connection operations.
 *
 * @category models
 * @since 1.0.0
 */
export interface Service {
  /**
   * Runs `sql` with `params` for `owner`. A statement waits while another
   * owner's transaction is open. With `continuing`, the statement belongs to
   * a transaction `owner` opened earlier, and fails with
   * {@link TransactionLost} when that transaction is no longer open. With
   * `request`, every change it commits carries that request's receipt: a
   * change it can't record fails with {@link TransactionUnrecorded}, and one
   * an undecided request would commit with {@link TransactionUndecided}.
   * A tab cannot run `VACUUM`: it fails with {@link VacuumUnsupported}.
   */
  readonly run: {
    (
      owner: string,
      sql: string,
      params: ReadonlyArray<unknown>,
      continuing: boolean
    ): Effect.Effect<Result, SqlError | TransactionLost>
    (
      owner: string,
      sql: string,
      params: ReadonlyArray<unknown>,
      continuing: boolean,
      request: Request | undefined
    ): Effect.Effect<
      Result,
      SqlError | TransactionLost | TransactionUnrecorded | TransactionUndecided | VacuumUnsupported
    >
  }
  /**
   * Runs each of `statements` in order for `owner`, as one request: as {@link run}
   * runs one statement, with the request's last statement the batch's last, so a
   * change commits only with it. A statement SQLite refuses fails the batch with
   * its `SqlError`, and the statements after it never run.
   */
  readonly runBatch: (
    owner: string,
    statements: ReadonlyArray<Statements.Entry>,
    continuing: boolean,
    request: Request | undefined
  ) => Effect.Effect<
    BatchResult,
    SqlError | TransactionLost | TransactionUnrecorded | TransactionUndecided | VacuumUnsupported
  >
  /** Whether this owner still holds an open transaction, including after a failed statement. */
  readonly isOpen: (owner: string) => boolean
  /**
   * The number of the request that opened `owner`'s open transaction, if it has one: its receipt names it. A request
   * that ends the transaction and opens another names itself.
   */
  readonly opened: (owner: string) => number | undefined
  /**
   * Rolls back `owner`'s open transaction, if it has one, and lends the connection again.
   * A failed rollback poisons the connection, wakes its waiters with SQL errors,
   * and defects instead of reporting successful abandonment.
   */
  readonly abandon: (owner: string) => Effect.Effect<void>
}

/**
 * Service tag for the leader's connection to the app's database.
 *
 * @category services
 * @since 1.0.0
 */
export class SqlConnection extends Context.Service<SqlConnection, Service>()(
  "@smthrs/platform-browser/SqlConnection"
) {}

/** The receipt of a transaction a request opened, or its reply, could not be written. */
class ReceiptFailed {
  readonly _tag = "ReceiptFailed"
}

/**
 * The tab's request running now, as the commit hook and the authorizer see it: whether the statement stepping is the
 * request's last, the only one that may commit; whether it ends a transaction; why the hook refused a commit; and
 * whether a commit went through.
 */
interface Guard {
  readonly undecided: boolean
  last: boolean
  ends: boolean
  vetoed: "unreceipted" | "early" | "undecided" | undefined
}

/** SQLite's authorizer action codes this connection reads (https://sqlite.org/c3ref/c_alter_table.html). */
const action = {
  createIndex: 1,
  createTable: 2,
  createTempIndex: 3,
  createTempTable: 4,
  createTempTrigger: 5,
  createTempView: 6,
  createTrigger: 7,
  createView: 8,
  delete: 9,
  dropTable: 11,
  insert: 18,
  pragma: 19,
  transaction: 22,
  update: 23,
  alterTable: 26,
  createVirtualTable: 29,
  savepoint: 32
} as const

/** The leader's own tables, which no tab's statement may change. */
const leaderTables: ReadonlySet<string> = new Set([SqlProtocol.commits, SqlProtocol.replies])

const isLeaders = (table: string | null) => table !== null && leaderTables.has(table.toLowerCase())

/** What a request runs: its statements, and whether it is a batch, whose reply keeps each one's rows. */
interface Script {
  readonly entries: ReadonlyArray<Statements.Entry>
  readonly batch: boolean
}

/** One statement's script. */
const single = (sql: string, params: ReadonlyArray<unknown> = []): Script => ({
  entries: [{ sql, params }],
  batch: false
})

/** A reply as `SqlProtocol.replies` keeps it: a batch's rows per statement, or one statement's rows. */
const replyText = (script: Script, results: ReadonlyArray<ReadonlyArray<unknown>>): string =>
  script.batch ? SqlProtocol.encodeResults(results) : SqlProtocol.encodeRows(results[0]!)

const returnedRows = (results: ReadonlyArray<ReadonlyArray<unknown>>) => results.some((rows) => rows.length > 0)

/**
 * Builds the connection's owner bookkeeping over an open database.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (database: Statements.Database): Effect.Effect<Service, never, Scope.Scope> =>
  Effect.gen(function*() {
    // One statement at a time; `holder`, `opened`, `guard` and `internal` change only under it.
    const statement = yield* Semaphore.make(1)
    // A rollback SQLite refused: the connection still holds that transaction, so every later statement fails with it.
    let poisoned: SqlError | undefined
    let holder:
      | {
        readonly owner: string
        readonly released: Deferred.Deferred<void>
        readonly number: number
        // The request that opened it, whose receipt it holds.
        readonly receipt: Request | undefined
        receipted: boolean
      }
      | undefined
    // How many transactions have opened, so a request can tell the one it opened from a later one.
    let opened = 0
    let guard: Guard | undefined
    // The connection writing a receipt or a reply itself.
    let internal = false
    const { db, sqlite3 } = database

    // A tab's change commits only with its request's last statement, in a transaction that holds the request's receipt,
    // and an undecided request's never.
    sqlite3.commit_hook(db, () => {
      if (guard === undefined) return 0
      guard.vetoed = guard.undecided ?
        "undecided"
        : holder?.receipted !== true ?
        "unreceipted"
        : guard.last ?
        undefined
        : "early"
      return guard.vetoed === undefined ? 0 : 1
    })

    // A tab's statement may not change the leader's tables or hang a trigger on them. A rollback to a savepoint may
    // take the transaction's receipt with it, so the receipt is written again after the statement.
    sqlite3.set_authorizer(db, (_, code, first, second) => {
      if (guard === undefined || internal) return 0
      switch (code) {
        case action.insert:
        case action.update:
        case action.delete:
        case action.dropTable:
        // A table or view by a leader table's name, temporary or not, would stand in for it.
        case action.createTable:
        case action.createTempTable:
        case action.createView:
        case action.createTempView:
        case action.createVirtualTable:
          return isLeaders(first) ? 1 : 0
        case action.alterTable:
        case action.createTrigger:
        case action.createTempTrigger:
        // A unique index would make one tab's receipt replace another's.
        case action.createIndex:
        case action.createTempIndex:
          return isLeaders(second) ? 1 : 0
        // A writable schema could give the leader's storage another name.
        case action.pragma:
          return String(first).toLowerCase() === "writable_schema" ? 1 : 0
        case action.transaction:
          if (first === "COMMIT") guard.ends = true
          return 0
        case action.savepoint:
          if (first === "RELEASE") guard.ends = true
          if (first === "ROLLBACK" && holder !== undefined) holder.receipted = false
          return 0
      }
      return 0
    }, null)

    /** Writes one of the leader's own rows, which must change exactly one row. Under `statement`. */
    const write = async (sql: string, params: ReadonlyArray<unknown>) => {
      internal = true
      try {
        await Statements.runAll(database, sql, params, "object")
        if (sqlite3.changes(db) !== 1) throw new ReceiptFailed()
      } catch {
        throw new ReceiptFailed()
      } finally {
        internal = false
      }
    }

    const writeReply = (owner: string, request: Request, text: string) =>
      write(`INSERT OR REPLACE INTO main.${SqlProtocol.replies} (client, request, rows) VALUES (?, ?, ?)`, [
        owner,
        request.id,
        text
      ])

    /**
     * Moves ownership by the autocommit flag, and receipts the owner's transaction when `request` just opened it or a
     * rollback to a savepoint took its receipt. Under `statement`.
     */
    const track = async (owner: string, request: Request | undefined) => {
      if (guard !== undefined) guard.ends = false
      const open = sqlite3.get_autocommit(db) === 0
      if (open && holder === undefined) {
        holder = { owner, released: Deferred.makeUnsafe<void>(), number: ++opened, receipt: request, receipted: false }
      }
      if (open && holder !== undefined && !holder.receipted && holder.receipt !== undefined) {
        await write(`INSERT OR REPLACE INTO main.${SqlProtocol.commits} (client, opened, at) VALUES (?, ?, ?)`, [
          holder.owner,
          holder.receipt.id,
          holder.receipt.at
        ])
        holder.receipted = true
      }
      if (!open && holder !== undefined) {
        Deferred.doneUnsafe(holder.released, Exit.void)
        holder = undefined
      }
    }

    /** Runs `script` and moves ownership after each statement. Under `statement`. */
    const execute = (owner: string, script: Script, request?: Request) =>
      Effect.tryPromise({
        try: async () => {
          try {
            return await Statements.runEach(database, script.entries, "object", {
              before: async ({ sql, last, results }) => {
                if (guard === undefined || request === undefined) return
                // Inspect SQLite's prepared statement, so comments and earlier statements cannot hide compaction.
                if (Statements.isVacuum(sql)) {
                  throw new VacuumUnsupported()
                }
                guard.last = last
                // The statement that commits is the request's last: what the earlier ones returned is its reply.
                if (last && guard.ends && returnedRows(results) && holder?.receipted === true) {
                  await writeReply(owner, request, replyText(script, results))
                }
              },
              after: () => track(owner, request)
            })
          } finally {
            // A failed statement can change transaction ownership. Reconciliation
            // can itself refuse a missing receipt and belongs in the typed channel.
            await track(owner, undefined)
          }
        },
        catch: (cause) =>
          cause instanceof ReceiptFailed || cause instanceof VacuumUnsupported
            ? cause
            : Statements.failed(cause, "Failed to execute statement", "execute")
      }).pipe(
        Effect.map(({ results }): BatchResult => ({ results, open: holder?.owner === owner }))
      )

    /** Rolls back `owner`'s open transaction. Under `statement`. */
    /**
     * Rolls back `owner`'s open transaction. A ROLLBACK SQLite refuses leaves the transaction in the connection, so the
     * connection is poisoned: its waiters wake, and every later statement fails with the refusal. Under `statement`.
     */
    const rollback = (owner: string): Effect.Effect<void, SqlError> => {
      const abandoned = holder
      if (abandoned?.owner !== owner) return Effect.void
      return execute(owner, single("ROLLBACK")).pipe(
        Effect.catchTag("ReceiptFailed", Effect.die),
        Effect.catchTag("@smthrs/platform-browser/VacuumUnsupported", Effect.die),
        Effect.catch((error) => {
          // The connection still contains the abandoned transaction. Fail closed,
          // and wake every waiter so none can hang or read its uncommitted data.
          poisoned = error
          Deferred.doneUnsafe(abandoned.released, Exit.void)
          holder = undefined
          return Metric.update(Metric.withAttributes(statements, { outcome: "abandon_failed" }), 1).pipe(
            Effect.andThen(
              Effect.logError("browser.runtime.statement").pipe(
                Effect.annotateLogs({ outcome: "abandon_failed", "error.type": error._tag })
              )
            ),
            Effect.andThen(Effect.fail(error))
          )
        }),
        Effect.asVoid
      )
    }

    /**
     * Runs a tab's request so that every change it commits carries its receipt. A change that would commit outside a
     * transaction is refused by the commit hook, rolled back, and the request runs again inside one with its receipt.
     * Under `statement`.
     */
    const receipted = (
      owner: string,
      script: Script,
      continuing: boolean,
      request: Request
    ): Effect.Effect<BatchResult, SqlError | TransactionUnrecorded | TransactionUndecided | VacuumUnsupported> => {
      const current: Guard = { undecided: request.undecided, last: false, ends: false, vetoed: undefined }
      // What a failed request fails with: its own error, or the refusal of a change the commit hook or a receipt
      // refused.
      const failure = (
        error: SqlError | ReceiptFailed | VacuumUnsupported
      ): SqlError | TransactionUnrecorded | TransactionUndecided | VacuumUnsupported =>
        current.vetoed === "undecided" ?
          new TransactionUndecided()
          : error instanceof ReceiptFailed || current.vetoed !== undefined ?
          new TransactionUnrecorded()
          : error
      // A refused change is rolled back with the transaction it was in; a statement SQLite refused leaves its
      // transaction as SQLite left it.
      const refused = (error: SqlError | ReceiptFailed | VacuumUnsupported) =>
        error instanceof ReceiptFailed || current.vetoed !== undefined ?
          rollback(owner).pipe(Effect.andThen(Effect.fail(failure(error))))
          : Effect.fail(error)
      // The request again, in a transaction opened with its receipt and committed at its end if it is still that one:
      // all of it commits, or none of it does.
      const wrapped = Effect.gen(function*() {
        current.vetoed = undefined
        yield* execute(owner, single("BEGIN IMMEDIATE"), request)
        const wrapper = holder?.number
        const result = yield* execute(owner, script, request)
        if (holder !== undefined && holder.number === wrapper) {
          if (returnedRows(result.results)) {
            yield* Effect.tryPromise({
              try: () => writeReply(owner, request, replyText(script, result.results)),
              catch: () => new ReceiptFailed()
            })
          }
          yield* execute(owner, single("COMMIT"), request)
        }
        return { results: result.results, open: holder?.owner === owner }
      }).pipe(Effect.catch((error) => rollback(owner).pipe(Effect.andThen(Effect.fail(failure(error))))))
      return Effect.suspend(() => {
        guard = current
        return execute(owner, script, request)
      }).pipe(
        Effect.catch((error) =>
          // A write refused for want of a receipt, outside a transaction it continues: it runs again, wrapped.
          current.vetoed === "unreceipted" && !continuing ?
            rollback(owner).pipe(Effect.andThen(wrapped))
            : refused(error)
        ),
        Effect.ensuring(Effect.sync(() => {
          guard = undefined
        }))
      )
    }

    type Outcome =
      | { readonly _tag: "Ran"; readonly result: BatchResult }
      | { readonly _tag: "Wait"; readonly released: Deferred.Deferred<void> }
      | { readonly _tag: "Lost" }

    const runScript = (
      owner: string,
      script: Script,
      continuing: boolean,
      request?: Request
    ): Effect.Effect<
      BatchResult,
      SqlError | TransactionLost | TransactionUnrecorded | TransactionUndecided | VacuumUnsupported
    > =>
      statement.withPermits(1)(Effect.suspend((): Effect.Effect<
        Outcome,
        SqlError | TransactionUnrecorded | TransactionUndecided | VacuumUnsupported
      > => {
        if (poisoned !== undefined) return Effect.fail(poisoned)
        const held = holder !== undefined && holder.owner === owner
        if (continuing && !held) return Effect.succeed({ _tag: "Lost" })
        if (holder !== undefined && !held) return Effect.succeed({ _tag: "Wait", released: holder.released })
        // A statement runs to its end once started.
        return Effect.uninterruptible(Effect.map(
          request === undefined ?
            // Only a request's statements write a receipt.
            execute(owner, script).pipe(
              Effect.catchTags({ ReceiptFailed: Effect.die, "@smthrs/platform-browser/VacuumUnsupported": Effect.die })
            )
            : receipted(owner, script, continuing, request),
          (result) => ({ _tag: "Ran", result })
        ))
      })).pipe(
        Effect.flatMap((outcome): Effect.Effect<
          BatchResult,
          SqlError | TransactionLost | TransactionUnrecorded | TransactionUndecided | VacuumUnsupported
        > => {
          switch (outcome._tag) {
            case "Ran":
              return Effect.succeed(outcome.result)
            case "Lost":
              return Effect.fail(new TransactionLost())
            case "Wait":
              // Another owner's transaction is open: wait for it to end, then try again.
              return Effect.andThen(Deferred.await(outcome.released), runScript(owner, script, continuing, request))
          }
        })
      )

    const abandon: Service["abandon"] = (owner) =>
      statement.withPermits(1)(
        Effect.suspend(() =>
          poisoned !== undefined ? Effect.die(poisoned) : Effect.uninterruptible(Effect.orDie(rollback(owner)))
        )
      ).pipe(Effect.withSpan("browser.runtime.abandon"))

    const run = (
      owner: string,
      sql: string,
      params: ReadonlyArray<unknown>,
      continuing: boolean,
      request?: Request
    ): Effect.Effect<
      Result,
      SqlError | TransactionLost | TransactionUnrecorded | TransactionUndecided | VacuumUnsupported
    > =>
      Effect.map(runScript(owner, single(sql, params), continuing, request), ({ open, results }) => ({
        rows: results[0]!,
        open
      }))

    const runBatch: Service["runBatch"] = (owner, statements, continuing, request) =>
      runScript(owner, { entries: statements, batch: true }, continuing, request)

    return SqlConnection.of({
      run: run as Service["run"],
      runBatch,
      abandon,
      isOpen: (owner) => holder?.owner === owner,
      opened: (owner) => holder?.owner === owner ? holder.receipt?.id : undefined
    })
  })

/**
 * Provides the connection over `filename`, opened on the `BrowserSqlite.Sqlite`
 * service's VFS on a connection of its own, until the layer's scope closes.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (
  options: { readonly filename: string }
): Layer.Layer<SqlConnection, SqlError, BrowserSqlite.Sqlite> =>
  Layer.effect(SqlConnection, Effect.flatMap(BrowserSqlite.open(options.filename), make))
