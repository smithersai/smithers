/**
 * The app's own SQLite database, shared by every tab of an origin.
 *
 * The engine's leader, the one dedicated worker that holds the engine's Web
 * Lock, already holds the origin's OPFS pool and the wa-sqlite build
 * (`BrowserRuntime.layerHost`). It opens a second file there, {@link filename},
 * on a connection of its own, and runs each tab's statements on it. A tab's
 * {@link SharedSqlite} sends `execute` to the leader over a
 * `BroadcastChannel`, whichever tab's worker leads, so an app loads one
 * SQLite build and keeps one OPFS pool, never a second store with its own
 * worker. TanStack DB's browser persistence takes {@link open}'s
 * {@link Database} as its injected `{ execute, close }`.
 *
 * - A tab runs one statement at a time, in the order it asks. A batch
 *   ({@link Database.executeBatch}) runs its statements in order as one
 *   request, one round trip to the leader for all of them.
 * - A transaction a tab opens is the tab's alone until a statement ends it:
 *   another tab's statement waits, so it never runs inside it or reads what
 *   it has not committed.
 * - When a tab ends with a transaction open, the leader rolls it back.
 * - When the leader ends, the next worker takes the lock and serves the same
 *   file. A statement it never answered is sent again. A transaction open on
 *   the old leader ended with it, so the tab runs that transaction's
 *   statements again on the new one, in order, and carries on if each returns
 *   the rows it returned before; a handover is invisible to the caller, as
 *   TanStack DB's persistence needs. If any returns other rows, the tab rolls
 *   the transaction back and the statement fails with a `ConnectionError`. A
 *   statement that committed, a transaction or a write of its own, just as
 *   the old leader ended is answered as committed, with the rows it returned,
 *   never run twice: every change commits with its request's receipt. A
 *   request commits only with its last statement, so `INSERT ...; COMMIT;
 *   SELECT ...` in one request or one batch fails; send them apart.
 *
 * @since 1.0.0
 */

import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Equal from "effect/Equal"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import { ConnectionError, SqlError } from "effect/sql/SqlError"
import * as Stream from "effect/Stream"
import * as SqlProtocol from "./internal/SqlProtocol.ts"
import * as Statements from "./internal/Statements.ts"
import { TabChannel, type TabChannelOverflow } from "./TabChannel.ts"
import * as TabChannelLayer from "./TabChannel.ts"
import { WebLock } from "./WebLock.ts"
import * as WebLockLayer from "./WebLock.ts"

/**
 * The app database's file, beside the engine's `engine.db` in the leader's
 * OPFS pool.
 *
 * @category models
 * @since 1.0.0
 */
export const filename = "app.db"

/**
 * Database operations.
 *
 * @category models
 * @since 1.0.0
 */
export interface Service {
  /**
   * Runs every statement in `sql`, binding `params` to each, and returns the
   * rows they produce as objects keyed by column name. A statement SQLite
   * refuses fails with its `SqlError`.
   */
  readonly execute: (sql: string, params?: ReadonlyArray<unknown>) => Effect.Effect<ReadonlyArray<unknown>, SqlError>
}

/**
 * Service tag for the app's shared database.
 *
 * @category services
 * @since 1.0.0
 */
export class SharedSqlite extends Context.Service<SharedSqlite, Service>()(
  "@smthrs/platform-browser/SharedSqlite"
) {}

/**
 * Which engine's leader serves the database.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  /** The engine's name: the one its worker passes to `BrowserRuntime.run`. */
  readonly name: string
}

/**
 * One statement of a batch: `sql` with `params`, none when absent.
 *
 * @category models
 * @since 1.0.0
 */
export interface Statement {
  readonly sql: string
  readonly params?: ReadonlyArray<unknown> | undefined
}

type Reply = Extract<SqlProtocol.Message, { readonly _tag: "Executed" | "Failed" }>

/** What a tab sends: one statement, or a batch of them under `SqlProtocol.batchSql`. */
interface Request {
  readonly sql: string
  readonly params: ReadonlyArray<unknown>
  readonly batch?: ReadonlyArray<typeof SqlProtocol.Statement.Type>
}

/** What a request returned: its rows, and a batch's rows per statement when the leader ran it as one. */
interface Answer {
  readonly rows: ReadonlyArray<unknown>
  readonly results: ReadonlyArray<ReadonlyArray<unknown>> | undefined
}

/** A request of a tab's open transaction, and what it returned. */
interface Ran {
  readonly request: Request
  readonly answer: Answer
}

/** A tab's open transaction: the leader holding it, the request that opened it, and what it ran. */
interface Transaction {
  readonly leader: string
  readonly opened: number
  replayable: boolean
  readonly ran: Array<Ran>
}

/** What a leader answers a statement of a transaction that ended with an earlier leader. */
const lost = "@smthrs/platform-browser/TransactionLost"

/** Why a statement never reached SQLite, by the tag it failed with: the `ConnectionError`'s message. */
const unreached: Readonly<Record<string, string>> = {
  "@smthrs/platform-browser/PrepareFailed": "The database is not prepared for this build",
  "@smthrs/platform-browser/TabChannelOverflow": "This tab fell too far behind the database's channel"
}

/** The `SqlError` a refused statement fails with. */
const refused = (reply: Extract<Reply, { readonly _tag: "Failed" }>): SqlError =>
  reply.error === lost ?
    new SqlError({
      reason: new ConnectionError({
        cause: reply.error,
        message: "The transaction ended with the leader that held it",
        operation: "execute"
      })
    })
    : reply.error in unreached ?
    new SqlError({
      reason: new ConnectionError({
        cause: { name: reply.error },
        message: unreached[reply.error]!,
        operation: "execute"
      })
    })
    : Statements.failed(
      { name: reply.error, code: reply.code, message: reply.message },
      "Failed to execute statement",
      "execute"
    )

/** The tab's client: {@link Service}'s `execute`, and `executeBatch`, a batch in one request. */
interface Client extends Service {
  readonly executeBatch: (
    statements: ReadonlyArray<Statement>
  ) => Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, SqlError>
}

/**
 * Builds the service: opens the database's channel and holds this tab's
 * lock, both until the scope closes.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (options: Options): Effect.Effect<Service, never, TabChannel | WebLock | Scope.Scope> =>
  Effect.map(connect(options), ({ execute }) => SharedSqlite.of({ execute }))

/** Opens this tab's client: the channel and this tab's lock, both until the scope closes. */
const connect = (options: Options): Effect.Effect<Client, never, TabChannel | WebLock | Scope.Scope> =>
  Effect.gen(function*() {
    const client = crypto.randomUUID()
    // Held while this tab can still be answered: when it ends, or falls the channel's capacity behind, the leader
    // can take it, and rolls back any transaction this tab left open.
    const answerable = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(answerable, Exit.void))
    yield* (yield* WebLock).hold(SqlProtocol.clientLock(options.name, client)).pipe(Scope.provide(answerable))
    const port = yield* (yield* TabChannel).open(SqlProtocol.channel(options.name))
    const inbox = yield* port.subscribe
    const turn = yield* Semaphore.make(1)
    let pending:
      | { readonly message: unknown; readonly id: number; readonly reply: Deferred.Deferred<Reply> }
      | undefined
    let next = 0
    // This tab's open transaction, if one is open: the leader holding it, the request that opened it, and every
    // statement it ran with the rows it returned, so a new leader can run it again.
    let transaction: Transaction | null = null
    // Set once this tab fell the channel's capacity behind: it hears no answer any more, so every statement fails.
    let overflow: TabChannelOverflow | undefined
    const overflowed = (id: number): Reply => ({ _tag: "Failed", client, id, error: overflow!._tag })

    yield* Stream.fromQueue(inbox).pipe(
      Stream.runForEach((input) =>
        Effect.suspend(() => {
          const message = SqlProtocol.decode(input)
          if (message?._tag === "Ready") return pending === undefined ? Effect.void : port.post(pending.message)
          if (
            (message?._tag === "Executed" || message?._tag === "Failed") && message.client === client &&
            message.id === pending?.id
          ) {
            return Deferred.succeed(pending.reply, message)
          }
          return Effect.void
        })
      ),
      Effect.catch((error) =>
        Effect.suspend(() => {
          overflow = error
          return (pending === undefined ? Effect.void : Deferred.succeed(pending.reply, overflowed(pending.id))).pipe(
            Effect.andThen(Scope.close(answerable, Exit.void))
          )
        })
      ),
      Effect.forkScoped
    )

    // Sends one request and waits for its answer, from whichever leader serves it.
    const send = ({ batch, params, sql }: Request) =>
      Effect.gen(function*() {
        const id = next++
        if (overflow !== undefined) return { id, answer: overflowed(id) }
        const reply = yield* Deferred.make<Reply>()
        const message = SqlProtocol.encode({
          _tag: "Execute",
          client,
          id,
          sql,
          params,
          transaction: transaction?.leader ?? null,
          ...(transaction === null ? {} : { opened: transaction.opened }),
          ...(batch === undefined ? {} : { batch })
        })
        pending = { message, id, reply }
        const answer = yield* port.post(message).pipe(
          Effect.andThen(Deferred.await(reply)),
          Effect.ensuring(Effect.sync(() => {
            pending = undefined
          }))
        )
        return { id, answer }
      })

    // Runs one request. When the leader holding this tab's transaction ended before answering it, the transaction
    // runs again on the leader now serving, then the request.
    const run = (request: Request): Effect.Effect<Answer, SqlError> =>
      Effect.gen(function*() {
        const { answer, id } = yield* send(request)
        if (answer._tag === "Executed") {
          if (!answer.open) transaction = null
          else if (transaction === null) transaction = { leader: answer.leader, opened: id, ran: [], replayable: true }
          const answered = { rows: answer.rows, results: answer.results }
          transaction?.ran.push({ request, answer: answered })
          return answered
        }
        if (answer.error !== lost) {
          if (answer.open === false) transaction = null
          else if (answer.open && transaction === null && answer.leader !== undefined) {
            transaction = { leader: answer.leader, opened: id, ran: [], replayable: true }
          }
          if (transaction !== null) transaction.replayable = false
          return yield* refused(answer)
        }
        // Only a statement sent in a transaction is lost.
        const { ran, replayable } = transaction!
        transaction = null
        return replayable && (yield* replay(ran)) ? yield* run(request) : yield* refused(answer)
      })

    // Runs a lost transaction's requests again, in order. The transaction stands only if each returns the rows it
    // returned before, so everything the caller decided on them still holds; otherwise it is rolled back.
    const replay = (ran: ReadonlyArray<Ran>) =>
      Effect.gen(function*() {
        for (const { answer, request } of ran) {
          const again = yield* Effect.option(run(request))
          if (
            Option.isNone(again) || transaction === null || !Equal.equals(again.value.rows, answer.rows) ||
            !Equal.equals(again.value.results, answer.results)
          ) {
            // Outside a transaction SQLite refuses it, which is as good.
            yield* Effect.ignore(run({ sql: "ROLLBACK", params: [] }))
            return false
          }
        }
        return true
      })

    // Runs a batch as one request. A leader of an older build runs `SqlProtocol.batchSql` instead and answers no
    // `results`: the statements then go one at a time.
    const runBatch = (statements: ReadonlyArray<Statement>) =>
      Effect.gen(function*() {
        const batch = statements.map(({ params, sql }) => ({ sql, params: params ?? [] }))
        const { results } = yield* run({ sql: SqlProtocol.batchSql, params: [], batch })
        if (results !== undefined) return results
        return yield* Effect.forEach(batch, (statement) => Effect.map(run(statement), ({ rows }) => rows))
      })

    const scope = yield* Effect.scope
    // The tab owns accepted requests until their replies update transaction state.
    // Cancelling a caller stops waiting; closing the tab still interrupts the request.
    const owned = <A>(effect: Effect.Effect<A, SqlError>) =>
      turn.withPermits(1)(effect).pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join))
    const execute: Service["execute"] = (sql, params = []) =>
      owned(Effect.map(run({ sql, params }), ({ rows }) => rows))
    const executeBatch: Client["executeBatch"] = (statements) =>
      statements.length === 0 ? Effect.succeed([]) : owned(runBatch(statements))

    return { execute, executeBatch }
  })

/**
 * Provides the tab's {@link SharedSqlite} over the browser's own
 * `BroadcastChannel` and Web Locks.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (options: Options): Layer.Layer<SharedSqlite> =>
  Layer.effect(SharedSqlite, make(options)).pipe(
    Layer.provide(Layer.mergeAll(TabChannelLayer.layer, WebLockLayer.layer))
  )

/**
 * The database as a `Promise` API, the `{ execute, close }` shape TanStack
 * DB's browser persistence (`createBrowserWASQLitePersistence`) takes.
 *
 * @category models
 * @since 1.0.0
 */
export interface Database {
  /**
   * Runs `sql` with `params`. A statement SQLite refuses rejects with a
   * {@link SqliteError} carrying SQLite's own message and code, as wa-sqlite's
   * own API does.
   */
  readonly execute: <Row = unknown>(sql: string, params?: ReadonlyArray<unknown>) => Promise<ReadonlyArray<Row>>
  /**
   * Runs each of `statements` in order as one request, one round trip to the
   * leader, and resolves with each one's rows, in order. It rejects with a
   * {@link SqliteError} for the first statement SQLite refuses; the
   * statements after it never run, and a transaction the batch opened stays
   * open, as it would after the same statements one at a time. TanStack DB's
   * browser persistence restores a collection with a few batches
   * (`patches/@tanstack__db-sqlite-persistence-core@0.4.11.patch`).
   */
  readonly executeBatch: (statements: ReadonlyArray<Statement>) => Promise<ReadonlyArray<ReadonlyArray<unknown>>>
  /** Closes the channel and releases this tab's lock. */
  readonly close: () => Promise<void>
}

/**
 * A statement {@link Database.execute} could not run, shaped as wa-sqlite's
 * `SQLiteError`: `message` is SQLite's own, such as
 * `duplicate column name: replay_json`, which TanStack DB's persistence reads
 * to tell a column it already added, and `code` is SQLite's result code. When
 * SQLite never saw the statement, as when no leader holds the transaction it
 * belongs to, `message` is the `SqlError`'s and `code` is absent. `cause` is the
 * `SqlError` the {@link SharedSqlite} service failed with.
 *
 * @category errors
 * @since 1.0.0
 */
export class SqliteError extends Error {
  override readonly name = "SQLiteError"
  readonly code: number | undefined
  constructor(error: SqlError) {
    const sqlite = error.reason.cause as { readonly code?: unknown; readonly message?: unknown } | undefined
    super(typeof sqlite?.message === "string" ? sqlite.message : error.message, { cause: error })
    this.code = typeof sqlite?.code === "number" ? sqlite.code : undefined
  }
}

/**
 * What {@link open} waits for.
 *
 * @category models
 * @since 1.0.0
 */
export interface OpenOptions extends Options {
  /**
   * How long to wait for a leader to answer the first statement, default 30
   * seconds. A tab whose own engine worker starts with it waits at most that
   * worker's start: loading the build and opening the pool.
   */
  readonly within?: Duration.Input
}

/**
 * Opens the shared database for a `Promise` API such as TanStack DB's
 * persistence, and resolves once a leader answers, so a caller can fall back
 * to memory when none does. It rejects with a `SqlError` when no leader
 * answers within `within`.
 *
 * ```ts
 * const persistence = createBrowserWASQLitePersistence({
 *   database: await SharedSqlite.open({ name: "smithers" })
 * })
 * ```
 *
 * @category constructors
 * @since 1.0.0
 */
export const open = (options: OpenOptions): Promise<Database> =>
  Effect.runPromise(Effect.gen(function*() {
    const scope = yield* Scope.make()
    const close = Scope.close(scope, Exit.void)
    const service = yield* connect(options).pipe(
      Scope.provide(scope),
      Effect.provide(Layer.mergeAll(TabChannelLayer.layer, WebLockLayer.layer))
    )
    yield* service.execute("SELECT 1").pipe(
      Effect.timeoutOrElse({
        duration: Duration.fromInputUnsafe(options.within ?? "30 seconds"),
        orElse: () =>
          Effect.fail(
            new SqlError({
              reason: new ConnectionError({
                cause: "no leader",
                message: "No engine leader answered",
                operation: "connect"
              })
            })
          )
      }),
      Effect.tapError(() => close)
    )
    return {
      execute: <Row>(sql: string, params?: ReadonlyArray<unknown>) =>
        Effect.runPromise(
          service.execute(sql, params).pipe(Effect.mapError((error) => new SqliteError(error)))
        ) as Promise<ReadonlyArray<Row>>,
      executeBatch: (statements: ReadonlyArray<Statement>) =>
        Effect.runPromise(service.executeBatch(statements).pipe(Effect.mapError((error) => new SqliteError(error)))),
      close: () => Effect.runPromise(close)
    }
  }))
