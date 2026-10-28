/**
 * The leader: the one worker per origin that runs the engine.
 *
 * {@link serve} waits for the engine's Web Lock, builds the engine, drives
 * every unfinished run, announces itself on the engine's channel, and then
 * answers followers' requests, runs tabs' statements on the app's shared
 * database, and forwards its engine's events until the worker ends. A leader
 * whose lock another context steals stops leading and waits for the lock
 * again.
 *
 * @since 1.0.0
 */

import { EngineStore, RunCatalogRead, RunInspection } from "@smthrs/engine-store"
import { Flow, FlowRuntime, RetryPolicy, RunMetrics, WaitFor } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import { RunStore } from "@smthrs/run-store"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import { TabChannel, type TabChannelOverflow } from "../TabChannel.ts"
import { WebLock } from "../WebLock.ts"
import { leaderships, requests, statements, wakes } from "./Metrics.ts"
import * as Prepare from "./Prepare.ts"
import * as Protocol from "./Protocol.ts"
import { type Service as Connection, SqlConnection, TransactionLost, TransactionUndecided } from "./SqlConnection.ts"
import * as SqlProtocol from "./SqlProtocol.ts"

/**
 * The services {@link serve} reads from the engine it builds.
 *
 * @category models
 * @since 1.0.0
 */
export type Services =
  | FlowRuntime.FlowRuntime
  | EngineStore.Driver
  | RunStore.RunStore
  | Journal.Journal
  | RunCatalogRead.RunCatalogRead
  | RunInspection.RunInspection

/**
 * What {@link serve} runs.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  /** The engine's name: its Web Lock and its channel. */
  readonly name: string
  /** Every flow followers may start, by tag. Each must be registered with the engine. */
  readonly flows: ReadonlyArray<Flow.Any>
  /**
   * What runs, as the durable flow `device/prepare`, before the leader answers any tab's statement on the app's
   * shared database: once per `epoch`. Its flow must be registered with the engine (`Prepare.declare`), as
   * `BrowserRuntime.layerHost` does. When it fails, the leader refuses every tab's statement with `PrepareFailed`.
   */
  readonly prepare?: Prepare.Prepare | undefined
}

/** The statuses of a run that has work left. */
const unfinished = ["pending", "running", "suspended"] as const

const isRequest = Schema.is(Protocol.Request)

/** A flow this leader was not given. */
class UnknownFlow extends Schema.TaggedError<UnknownFlow>()("@smthrs/platform-browser/UnknownFlow", {}) {}

/** A flow as the runtime's typed operations take it. */
type AnyFlow = Flow.Flow<string, Flow.AnyStructSchema, Schema.Top, Schema.Top, any>

/** Every unfinished run, collected before any is driven. */
const unfinishedRuns = Effect.gen(function*() {
  const catalog = yield* RunCatalogRead.RunCatalogRead
  const runs: Array<{ readonly runId: string; readonly flowName: string }> = []
  for (const status of unfinished) {
    let cursor: string | null = null
    do {
      const page: RunCatalogRead.RunPage = yield* catalog.listRuns({
        filters: { status },
        limit: RunCatalogRead.maximumPageSize,
        ...(cursor === null ? {} : { cursor })
      })
      runs.push(...page.runs)
      cursor = page.cursor
    } while (cursor !== null)
  }
  return runs
})

/**
 * Drives every unfinished run once, in the background: a run the previous
 * leader held, one admitted and never driven, and one whose durable timer
 * came due while no tab was open. A run parked on a later timer or on an
 * event stays parked.
 */
const wake = (flows: ReadonlyMap<string, Flow.Any>) =>
  Effect.gen(function*() {
    const driver = yield* EngineStore.Driver
    const runs = yield* unfinishedRuns.pipe(
      // The engine's own sweep still reclaims these runs, after their lease.
      Effect.tapError((error) =>
        Effect.logWarning("browser.runtime.wake").pipe(
          Effect.annotateLogs({ outcome: "unlisted", "error.type": error._tag })
        )
      ),
      Effect.orElseSucceed(() => [])
    )
    for (const run of runs) {
      const flow = flows.get(run.flowName)
      if (flow === undefined) {
        yield* Metric.update(Metric.withAttributes(wakes, { outcome: "unknown-flow" }), 1)
        yield* Effect.logWarning("browser.runtime.wake").pipe(Effect.annotateLogs({ outcome: "unknown-flow" }))
        continue
      }
      yield* driver.drive(flow, { executionId: run.runId, payload: {} }).pipe(
        Effect.exit,
        Effect.flatMap((exit) => {
          const outcome = Exit.isSuccess(exit) ? exit.value._tag.toLowerCase() : "failed"
          const failure = Exit.isFailure(exit) ? { "error.type": RetryPolicy.failureType(exit.cause) } : {}
          return Metric.update(Metric.withAttributes(wakes, { outcome }), 1).pipe(
            Effect.andThen(
              (Exit.isSuccess(exit) ? Effect.logInfo : Effect.logWarning)("browser.runtime.wake").pipe(
                Effect.annotateLogs({ outcome, ...failure })
              )
            ),
            Effect.andThen(Effect.annotateCurrentSpan({ "smithers.wake": outcome, ...failure }))
          )
        }),
        Effect.withSpan("browser.runtime.wake", {
          attributes: { "smithers.execution.id": run.runId, "smithers.flow": run.flowName }
        }),
        Effect.forkScoped
      )
    }
  })

/** A request that names the flow it acts on. */
type FlowRequest = Exclude<Protocol.Request, { readonly _tag: "Inspect" | "List" }>

/** A read of the engine's runs, which names no flow. */
type ReadRequest = Extract<Protocol.Request, { readonly _tag: "Inspect" | "List" }>

/** Runs a request that acts on a flow; the reply carries the poll's result, or `null`. */
const flowRequest = (flows: ReadonlyMap<string, Flow.Any>, request: FlowRequest) =>
  Effect.gen(function*() {
    const flow = flows.get(request.flow) as AnyFlow | undefined
    if (flow === undefined) return yield* new UnknownFlow()
    const runtime = yield* FlowRuntime.FlowRuntime
    switch (request._tag) {
      case "Start": {
        const payload = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(flow.payloadSchema))(request.payload)
        const started = runtime.execute(flow, { executionId: request.executionId, payload, discard: true })
        yield* (request.origin === undefined ? started : RunMetrics.withOrigin(started, request.origin))
        return null
      }
      case "Poll": {
        const row = yield* (yield* RunStore.RunStore).get(request.executionId)
        // A cancelled run records no result, so its settlement is an interrupt.
        const result = row.status === "cancelled"
          ? Option.some(new Flow.Complete({ exit: Exit.failCause(Cause.interrupt()) }))
          : yield* runtime.poll(flow, request.executionId)
        return Option.isNone(result) ? null : yield* Schema.encodeEffect(Protocol.resultCodec(flow))(result.value)
      }
      case "Cancel": {
        yield* runtime.interrupt(flow, request.executionId)
        return null
      }
      case "Signal": {
        const deferred = WaitFor.deferred(request.name)
        yield* runtime.deferredDone(deferred, {
          flowName: flow._tag,
          executionId: request.executionId,
          deferredName: deferred.name,
          exit: Exit.succeed(request.value)
        })
        return null
      }
    }
  })

/** How many of an inspection's values were cut to their limit. */
const clippedValues = (inspection: RunInspection.Inspection): number =>
  [
    inspection.run.input,
    inspection.run.result,
    ...inspection.steps.flatMap((step) => [step.output, ...step.attempts.map((attempt) => attempt.outcome)]),
    ...inspection.children.flatMap((child) => [child.input, child.result]),
    ...inspection.journal.events.map((event) => event.payload)
  ].filter((value) => value?.clipped === true).length

/**
 * Reads one run for a tab, as `run.inspect`: a span and a log line with the
 * host (`local`), the outcome (`read`, `not_found` or `failed`), how many
 * journal events and bytes it released, how many values it cut, and how long
 * it took. No value is recorded.
 */
const inspectRun = (request: Extract<ReadRequest, { readonly _tag: "Inspect" }>) =>
  Effect.gen(function*() {
    const startedAt = yield* Clock.currentTimeMillis
    const exit = yield* Effect.exit(
      Effect.flatMap(RunInspection.RunInspection, (reads) =>
        reads.inspect(request.runId, {
          ...(request.afterSeq === undefined ? {} : { afterSeq: request.afterSeq }),
          ...(request.limit === undefined ? {} : { limit: request.limit })
        }))
    )
    const durationMs = (yield* Clock.currentTimeMillis) - startedAt
    const fields = Exit.isSuccess(exit) ?
      {
        outcome: "read",
        events: exit.value.journal.events.length,
        bytes: new TextEncoder().encode(JSON.stringify(exit.value)).length,
        clipped: clippedValues(exit.value)
      }
      : { outcome: RetryPolicy.failureType(exit.cause) === "@smthrs/engine-store/RunNotFound" ? "not_found" : "failed" }
    yield* Effect.annotateCurrentSpan({ "smithers.run.host": "local", ...fields, durationMs })
    yield* (Exit.isSuccess(exit) ? Effect.logInfo : Effect.logWarning)("run.inspect").pipe(
      Effect.annotateLogs({ host: "local", ...fields, durationMs })
    )
    return yield* exit
  }).pipe(Effect.withSpan("run.inspect", { attributes: { "smithers.execution.id": request.runId } }))

/** Runs a read of the engine's runs; the reply carries what it read. */
const readRequest = (request: ReadRequest) =>
  request._tag === "Inspect"
    ? inspectRun(request)
    : Effect.flatMap(RunInspection.RunInspection, (reads) =>
      reads.list({
        ...(request.limit === undefined ? {} : { limit: request.limit }),
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        ...(request.roots === undefined ? {} : { roots: request.roots }),
        ...(request.flows === undefined ? {} : { flows: request.flows })
      }))

/** The span attributes that name what a request acts on. */
const requestAttributes = (request: Protocol.Request): Record<string, string> =>
  request._tag === "List" ?
    {} :
    request._tag === "Inspect"
    ? { "smithers.execution.id": request.runId }
    : { "smithers.flow": request.flow, "smithers.execution.id": request.executionId }

/** Handles one request; the reply carries what it read, or `null`. */
const handle = (flows: ReadonlyMap<string, Flow.Any>, request: Protocol.Request) =>
  ((request._tag === "Inspect" || request._tag === "List"
    ? readRequest(request)
    : flowRequest(flows, request)) as Effect.Effect<
      Schema.Json | null,
      unknown,
      FlowRuntime.FlowRuntime | RunStore.RunStore | RunInspection.RunInspection
    >).pipe(
      // A flow's schemas carry the services they need with the flow's
      // registration, so the requirements erased here are satisfied there.
      Effect.exit,
      Effect.flatMap((exit) => {
        const outcome = Exit.isSuccess(exit) ? "replied" : "refused"
        const failure = Exit.isFailure(exit) ? { "error.type": RetryPolicy.failureType(exit.cause) } : {}
        const reply: Protocol.Message = Exit.isSuccess(exit)
          ? { _tag: "Replied", client: request.client, id: request.id, result: exit.value }
          : { _tag: "Refused", client: request.client, id: request.id, error: failure["error.type"]! }
        return Metric.update(Metric.withAttributes(requests, { request: request._tag, outcome }), 1).pipe(
          Effect.andThen(
            (Exit.isSuccess(exit) ? Effect.logDebug : Effect.logWarning)("browser.runtime.request").pipe(
              Effect.annotateLogs({ request: request._tag, outcome, ...failure })
            )
          ),
          Effect.andThen(Effect.annotateCurrentSpan({ "smithers.request.outcome": outcome, ...failure })),
          Effect.as(reply)
        )
      }),
      Effect.withSpan("browser.runtime.request", {
        attributes: { "smithers.request": request._tag, ...requestAttributes(request) }
      })
    )

/** The engine built no database for tabs: its store is not SQLite on OPFS. */
class DatabaseUnavailable extends Schema.TaggedError<DatabaseUnavailable>()(
  "@smthrs/platform-browser/DatabaseUnavailable",
  {}
) {}

/** The `outcome` of a statement that failed with each of these tags; any other failure is `failed`. */
const failureOutcomes: Readonly<Record<string, string>> = {
  "@smthrs/platform-browser/PrepareFailed": "fenced",
  "@smthrs/platform-browser/TransactionLost": "lost",
  "@smthrs/platform-browser/TransactionUnrecorded": "unrecorded",
  "@smthrs/platform-browser/TransactionUndecided": "undecided"
}

/** SQLite's own result code and message for a statement it refused, never logged. */
const sqliteDetail = (error: unknown): { readonly code?: number; readonly message?: string } => {
  const cause =
    (error as { readonly reason?: { readonly cause?: { readonly code?: unknown; readonly message?: unknown } } })
      .reason?.cause
  return typeof cause?.code === "number" && typeof cause.message === "string" ?
    { code: cause.code, message: cause.message }
    : {}
}

/**
 * Creates the leader's tables in the app's database: each tab's receipt
 * (`SqlProtocol.commits`) and its last committed reply (`SqlProtocol.replies`),
 * and answers which tabs hold a receipt. A leader that can't still serves
 * reads: every change commits only with its receipt, so without the tables
 * every request that would change something fails (`TransactionUnrecorded`),
 * and a tab's first write, whose receipt this leader can't read, fails
 * undecided.
 */
const prepareCommits = (connection: Connection, leader: string) =>
  Effect.gen(function*() {
    yield* connection.run(
      leader,
      `CREATE TABLE IF NOT EXISTS main.${SqlProtocol.commits} (client TEXT PRIMARY KEY, opened INTEGER NOT NULL, at INTEGER NOT NULL) WITHOUT ROWID`,
      [],
      false
    )
    yield* connection.run(
      leader,
      `CREATE TABLE IF NOT EXISTS main.${SqlProtocol.replies} (client TEXT PRIMARY KEY, request INTEGER NOT NULL, rows TEXT NOT NULL) WITHOUT ROWID`,
      [],
      false
    )
    const { rows } = yield* connection.run(
      leader,
      `SELECT client, opened, at FROM main.${SqlProtocol.commits}`,
      [],
      false
    )
    return rows.map((row) => (row as { readonly client: string }).client)
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("browser.runtime.statement").pipe(
        Effect.annotateLogs({ outcome: "unprepared", "error.type": error._tag }),
        Effect.as([])
      )
    )
  )

/** What a request an earlier leader committed answers: its receipt's request, and the rows it returned, if any. */
const receiptOf = (connection: Connection, client: string, request: number) =>
  connection.run(
    client,
    `SELECT opened, (SELECT rows FROM main.${SqlProtocol.replies} WHERE client = ? AND request = ?) AS rows FROM main.${SqlProtocol.commits} WHERE client = ?`,
    [client, request, client],
    false
  ).pipe(Effect.map(({ rows }) => {
    const row = rows[0] as { readonly opened: unknown; readonly rows: string | null } | undefined
    return { opened: row?.opened, rows: row?.rows == null ? [] : SqlProtocol.decodeRows(row.rows) }
  }))

/**
 * Serves tabs' statements on the app's shared database until the scope
 * closes: each request once, in the order each tab sent them, and a rollback
 * of the open transaction of a tab that ends. With `fence`, the preparation's
 * failure, it runs none and refuses each with it. Every change a request
 * commits carries its receipt (`SqlProtocol.commits`, written by
 * `SqlConnection`), so this leader answers as committed a request an earlier
 * leader committed and never answered: a tab's first request outside a
 * transaction whose receipt names it, or a statement of a transaction that
 * leader held whose receipt names the request that opened it. It refuses a
 * statement of a transaction that leader held otherwise. The receipt fails
 * closed: a change it can't record is rolled back and its request fails, and a
 * request whose receipt it can't read commits nothing, so no request commits
 * twice.
 */
const serveStatements = (
  name: string,
  database: Option.Option<Connection>,
  fence: Prepare.PrepareFailed | undefined,
  overflowed: Deferred.Deferred<TabChannelOverflow>
) =>
  Effect.gen(function*() {
    const locks = yield* WebLock
    const port = yield* (yield* TabChannel).open(SqlProtocol.channel(name))
    const inbox = yield* port.subscribe
    const leader = crypto.randomUUID()
    const receipted = Option.isSome(database) && fence === undefined
      ? yield* prepareCommits(database.value, leader)
      : []
    // A tab can send a request again only while it lives, holding its lock, so once its lock comes free its receipt
    // and reply go: every tab that holds one, and every tab this leader serves.
    const forgotten = new Set<string>()
    const forget = (client: string) =>
      Effect.suspend(() => {
        if (Option.isNone(database) || forgotten.has(client)) return Effect.void
        forgotten.add(client)
        const connection = database.value
        return Effect.scoped(locks.hold(SqlProtocol.clientLock(name, client))).pipe(
          Effect.andThen(
            connection.run(leader, `DELETE FROM main.${SqlProtocol.commits} WHERE client = ?`, [client], false)
          ),
          Effect.andThen(
            connection.run(leader, `DELETE FROM main.${SqlProtocol.replies} WHERE client = ?`, [client], false)
          ),
          // A receipt left behind costs a row, and the next leader tries again.
          Effect.ignore,
          Effect.forkScoped
        )
      })
    yield* Effect.forEach(receipted, forget, { discard: true })
    // The newest request number taken from each tab: a tab sends one at a
    // time, so a number already taken is a request sent again.
    const taken = new Map<string, number>()
    // A watch on each tab with an open transaction: it ends when the tab does.
    const watched = new Map<string, Fiber.Fiber<void>>()

    const watch = (client: string, open: boolean, connection: Connection) =>
      Effect.gen(function*() {
        const watching = watched.get(client)
        if (open && watching === undefined) {
          watched.set(
            client,
            yield* Effect.scoped(locks.hold(SqlProtocol.clientLock(name, client))).pipe(
              Effect.andThen(connection.abandon(client)),
              Effect.andThen(Metric.update(Metric.withAttributes(statements, { outcome: "abandoned" }), 1)),
              Effect.andThen(
                Effect.logWarning("browser.runtime.statement").pipe(
                  Effect.annotateLogs({ outcome: "abandoned" })
                )
              ),
              Effect.ensuring(Effect.sync(() => watched.delete(client))),
              Effect.forkScoped
            )
          )
        }
        if (!open && watching !== undefined) {
          watched.delete(client)
          yield* Fiber.interrupt(watching)
        }
      })

    const execute = (request: Extract<SqlProtocol.Message, { readonly _tag: "Execute" }>, first: boolean) =>
      Effect.gen(function*() {
        if (Option.isNone(database)) return yield* new DatabaseUnavailable()
        // A database this build could not prepare may hold what it can't read: nothing runs on it.
        if (fence !== undefined) return yield* fence
        const connection = database.value
        const continuing = request.transaction !== null
        if (continuing && request.transaction !== leader) {
          // The transaction this statement belongs to ended with the leader that held it. Every earlier statement of it
          // left it open, so it committed only if this one committed it as that leader ended: its record says so.
          const recorded = yield* receiptOf(connection, request.client, request.id).pipe(
            // Taken as absent, the tab would run a transaction that may have committed again.
            Effect.mapError(() => new TransactionUndecided())
          )
          if (request.opened !== undefined && recorded.opened === request.opened) {
            return { rows: recorded.rows, open: false, committed: true }
          }
          return yield* new TransactionLost()
        }
        // The first request this leader takes from a tab may be one an earlier leader ran and never answered: its
        // receipt says whether it committed. A receipt this leader can't read leaves it undecided, so nothing of it
        // commits, while a read still runs.
        let undecided = false
        if (!continuing && first) {
          const recorded = yield* Effect.option(receiptOf(connection, request.client, request.id))
          if (Option.isSome(recorded) && recorded.value.opened === request.id) {
            return { rows: recorded.value.rows, open: false, committed: true }
          }
          undecided = Option.isNone(recorded)
        }
        const result = yield* connection.run(request.client, request.sql, request.params, continuing, {
          id: request.id,
          at: yield* Clock.currentTimeMillis,
          undecided
        })
        yield* watch(request.client, result.open, connection)
        return { ...result, committed: false }
      }).pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.gen(function*() {
            const open = Option.isSome(database) && database.value.isOpen(request.client)
            if (Option.isSome(database)) yield* watch(request.client, open, database.value)
            const failure = Exit.isFailure(exit) ? RetryPolicy.failureType(exit.cause) : undefined
            const outcome = failure === undefined ?
              Exit.isSuccess(exit) && exit.value.committed ? "committed" : "executed"
              : failureOutcomes[failure] ?? "failed"
            const reply: SqlProtocol.Message = Exit.isSuccess(exit)
              ? {
                _tag: "Executed",
                client: request.client,
                id: request.id,
                leader,
                rows: exit.value.rows,
                open: exit.value.open
              }
              : {
                _tag: "Failed",
                client: request.client,
                id: request.id,
                error: failure!,
                leader,
                // An undecided transaction may still be the tab's: say nothing of it, so the tab asks again.
                ...(failure === "@smthrs/platform-browser/TransactionUndecided" ? {} : { open }),
                ...sqliteDetail(Cause.squash(exit.cause))
              }
            return yield* Metric.update(Metric.withAttributes(statements, { outcome }), 1).pipe(
              Effect.andThen(
                // A statement SQLite refused is its tab's to handle, and TanStack DB's
                // persistence expects some (a column it already added), so only a
                // lost, unrecorded or undecided transaction is a warning.
                failure === undefined ?
                  Effect.void
                  : (outcome === "failed" ? Effect.logDebug : Effect.logWarning)("browser.runtime.statement").pipe(
                    Effect.annotateLogs({ outcome, "error.type": failure })
                  )
              ),
              Effect.as(reply)
            )
          })
        )
      )

    yield* Stream.fromQueue(inbox).pipe(
      Stream.runForEach((input) => {
        const message = SqlProtocol.decode(input)
        if (message?._tag !== "Execute" || (taken.get(message.client) ?? -1) >= message.id) return Effect.void
        const first = !taken.has(message.client)
        taken.set(message.client, message.id)
        return forget(message.client).pipe(
          Effect.andThen(execute(message, first)),
          Effect.flatMap((reply) => port.post(SqlProtocol.encode(reply))),
          Effect.forkScoped
        )
      }),
      // A leader that fell the channel's capacity behind its tabs stops leading.
      Effect.catch((overflow) => Deferred.succeed(overflowed, overflow)),
      Effect.forkScoped
    )
    yield* port.post(SqlProtocol.encode({ _tag: "Ready" }))
  })

/**
 * One leadership: waits for the engine's lock, builds `engine`, wakes
 * unfinished runs, announces itself, then serves both channels until the
 * lock is stolen or the leader falls a channel's capacity behind its tabs
 * (`TabChannelOverflow`), when it returns and everything it built closes. Its
 * tabs send what it never answered to whichever worker leads next.
 */
const lead = <E, R>(
  options: Options,
  engine: Layer.Layer<Services, E, R>
): Effect.Effect<void, E, R | WebLock | TabChannel | Scope.Scope> =>
  Effect.gen(function*() {
    const flows = new Map(options.flows.map((flow) => [flow._tag, flow] as const))
    const held = yield* (yield* WebLock).hold(options.name).pipe(Effect.withSpan("browser.runtime.elect"))
    yield* Metric.update(leaderships, 1)
    yield* Effect.logInfo("browser.runtime.leader").pipe(Effect.annotateLogs({ flows: flows.size }))
    // Losing the lock, or falling a channel's capacity behind its tabs, ends the whole leadership, including
    // initialization and preparation.
    yield* Effect.gen(function*() {
      const context = yield* Layer.build(engine)
      const port = yield* (yield* TabChannel).open(options.name)
      const inbox = yield* port.subscribe
      const overflowed = yield* Deferred.make<TabChannelOverflow>()
      const changes = yield* Effect.flatMap(Journal.Journal, (journal) => journal.changes).pipe(
        Effect.provideContext(context)
      )
      yield* wake(flows).pipe(Effect.provideContext(context))
      yield* Stream.fromSubscription(changes).pipe(
        Stream.runForEach((entry) =>
          port.post(Protocol.encode({ _tag: "RunChanged", executionId: entry.runId, eventType: entry.eventType }))
        ),
        Effect.forkScoped
      )
      // The app's database is prepared for this build before any tab's statement runs on it, and fenced if it can't be.
      const fence = options.prepare === undefined ? undefined : yield* Prepare.run(options.prepare, context)
      yield* serveStatements(
        options.name,
        Context.getOption(context as Context.Context<unknown>, SqlConnection),
        fence,
        overflowed
      )
      yield* port.post(Protocol.encode({ _tag: "Leader" }))
      yield* Stream.fromQueue(inbox).pipe(
        Stream.runForEach((input) => {
          const message = Protocol.decode(input)
          return !isRequest(message)
            ? Effect.void
            : handle(flows, message).pipe(
              Effect.flatMap((reply) => port.post(Protocol.encode(reply))),
              Effect.provideContext(context),
              Effect.forkScoped
            )
        }),
        Effect.catch((overflow) => Deferred.succeed(overflowed, overflow)),
        Effect.forkScoped
      )
      const overflow = yield* Deferred.await(overflowed)
      yield* Effect.logWarning("browser.runtime.lost").pipe(
        Effect.annotateLogs({ reason: "overflow", channel: overflow.channel })
      )
    }).pipe(
      Effect.scoped,
      Effect.raceFirst(
        held.lost.pipe(
          Effect.andThen(Effect.logWarning("browser.runtime.lost").pipe(Effect.annotateLogs({ reason: "stolen" })))
        )
      )
    )
  })

/**
 * Runs the leader: waits for the engine's lock, builds `engine`, wakes
 * unfinished runs, announces itself, then serves the channel until the
 * worker ends. A failure to build the engine ends it, which releases the
 * lock to the next tab's worker. A lock another context steals ends the
 * leadership, engine and all, and the worker waits for the lock again.
 *
 * @category running
 * @since 1.0.0
 */
export const serve = <E, R>(
  options: Options,
  engine: Layer.Layer<Services, E, R>
): Effect.Effect<never, E, R | WebLock | TabChannel> => Effect.forever(Effect.scoped(lead(options, engine)))
