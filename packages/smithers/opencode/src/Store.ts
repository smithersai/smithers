/**
 * The session store: sessions, message headers, parts, pending permissions,
 * permission grants, and open turns in SQLite, so a history read is a read
 * and a reload after a restart shows what the app showed before.
 *
 * The file is `<directory>/.smithers/opencode.sqlite`, opened through
 * `@smthrs/database`'s Node driver. The tables carry one JSON column each:
 * the wire shape is the stored shape, and a projection change is a code
 * change, not a migration. The migration is idempotent so every boot runs it.
 *
 * `apply` is how the projection reaches the store: it persists what an
 * emitted OpenCode event implies (a message header, a part, a delta, a
 * session, a permission) so the hub can publish exactly what was stored.
 *
 * Health decisions are kept here too, as `flows.opencode.health.v1`
 * records: the engine's journal is not reachable from the projection (the
 * turns run outside the engine's context, and the scripted driver has no
 * engine at all), so the store is where agreement is scored from.
 *
 * @since 1.0.0
 */
import * as Migrations from "@smthrs/database/Migrations"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Context, Effect, Layer, Option, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type * as Health from "./Health.ts"
import type * as Protocol from "./Protocol.ts"

/**
 * The one failure the store reports: the database refused a statement.
 *
 * @category errors
 * @since 1.0.0
 */
export class StoreError extends Schema.TaggedError<StoreError>()("@smthrs/opencode/StoreError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

/**
 * The database file under the served directory: the one file the store, the
 * engine driver, and the server all mean.
 *
 * @category getters
 * @since 1.0.0
 */
export const databasePath = (directory: string): string => join(resolve(directory), ".smithers", "opencode.sqlite")

/**
 * How many messages a history read returns when the app names no limit.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultMessageLimit = 20

/**
 * One message with its parts, as `GET /session/:id/message` lists them.
 *
 * @category models
 * @since 1.0.0
 */
export interface MessageWithParts {
  readonly info: Protocol.Message
  readonly parts: ReadonlyArray<Protocol.Part>
}

/**
 * A permission decision the operator made for a session: `always` for a
 * flow and the pattern the card showed (`bash echo *`), `once` or `reject`
 * for one request id. Kept so a decision made before a restart still
 * answers the call the resumed turn asks about.
 *
 * @category models
 * @since 1.0.0
 */
export interface Grant {
  readonly sessionID: string
  readonly kind: "always" | "once" | "reject"
  /** The flow and its `always` pattern for `always`, the request id otherwise. */
  readonly key: string
}

/**
 * A turn the engine driver started and has not seen settle: what re-drives
 * it after a restart.
 *
 * @category models
 * @since 1.0.0
 */
export interface Turn {
  readonly sessionID: string
  readonly messageID: string
  readonly prompt: string
  readonly history?: string | undefined
  readonly agent?: string | undefined
  readonly model?: Protocol.ModelRef | undefined
}

/**
 * What the store does.
 *
 * @category models
 * @since 1.0.0
 */
export interface Service {
  readonly putSession: (session: Protocol.Session) => Effect.Effect<void, StoreError>
  readonly getSession: (id: string) => Effect.Effect<Option.Option<Protocol.Session>, StoreError>
  /** Every session, newest first. */
  readonly listSessions: () => Effect.Effect<Array<Protocol.Session>, StoreError>
  readonly deleteSession: (id: string) => Effect.Effect<boolean, StoreError>
  readonly putMessage: (message: Protocol.Message) => Effect.Effect<void, StoreError>
  readonly getMessage: (id: string) => Effect.Effect<Option.Option<Protocol.Message>, StoreError>
  /** The last `limit` messages before `before`, oldest first, each with its parts in id order. */
  readonly listMessages: (
    sessionID: string,
    options?: { readonly limit?: number | undefined; readonly before?: string | undefined }
  ) => Effect.Effect<Array<MessageWithParts>, StoreError>
  readonly putPart: (part: Protocol.Part) => Effect.Effect<void, StoreError>
  readonly getPart: (id: string) => Effect.Effect<Option.Option<Protocol.Part>, StoreError>
  readonly putPermission: (request: Protocol.PermissionRequest) => Effect.Effect<void, StoreError>
  readonly listPermissions: (sessionID?: string) => Effect.Effect<Array<Protocol.PermissionRequest>, StoreError>
  readonly deletePermission: (id: string) => Effect.Effect<boolean, StoreError>
  readonly putGrant: (grant: Grant) => Effect.Effect<void, StoreError>
  /** Every grant, or a session's, in insertion order. */
  readonly listGrants: (sessionID?: string) => Effect.Effect<Array<Grant>, StoreError>
  /** Records a turn as open; storing the same message id again updates it. */
  readonly putTurn: (turn: Turn) => Effect.Effect<void, StoreError>
  /** Every turn recorded as open, oldest first. */
  readonly listTurns: () => Effect.Effect<Array<Turn>, StoreError>
  /** Forgets a turn once it settled. True when it was open. */
  readonly settleTurn: (messageID: string) => Effect.Effect<boolean, StoreError>
  /** Records one health decision. */
  readonly putHealth: (entry: Health.Entry) => Effect.Effect<void, StoreError>
  /** Every health decision, or a session's, oldest first. */
  readonly listHealth: (sessionID?: string) => Effect.Effect<Array<Health.Entry>, StoreError>
  /** Persists what one emitted event implies; events that imply nothing are ignored. */
  readonly apply: (event: Protocol.Emitted) => Effect.Effect<void, StoreError>
}

/**
 * The store service.
 *
 * @category services
 * @since 1.0.0
 */
export class Store extends Context.Service<Store, Service>()("@smthrs/opencode/Store") {}

/**
 * The store's migration set: one table per row kind, under the shared
 * `flows_migrations` ledger every Smithers package records into, so the
 * database driver recognises the file as a 1.0 database on the next open.
 *
 * @category constants
 * @since 1.0.0
 */
export const migrations: Migrations.MigrationSet = {
  namespace: "opencode",
  idOffset: Migrations.idBlock * 9,
  migrations: {
    "0001_initial": Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TABLE opencode_sessions (
        id TEXT PRIMARY KEY,
        created_ms INTEGER NOT NULL,
        info TEXT NOT NULL
      )`
      yield* sql`CREATE TABLE opencode_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        info TEXT NOT NULL
      )`
      yield* sql`CREATE INDEX opencode_messages_session ON opencode_messages (session_id, id)`
      yield* sql`CREATE TABLE opencode_parts (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        part TEXT NOT NULL
      )`
      yield* sql`CREATE INDEX opencode_parts_message ON opencode_parts (message_id, id)`
      yield* sql`CREATE TABLE opencode_permissions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        request TEXT NOT NULL
      )`
    }),
    "0002_grants_and_turns": Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TABLE opencode_grants (
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        UNIQUE (session_id, kind, key)
      )`
      yield* sql`CREATE TABLE opencode_turns (
        message_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn TEXT NOT NULL
      )`
    }),
    "0003_health": Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TABLE opencode_health (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        record TEXT NOT NULL
      )`
      yield* sql`CREATE INDEX opencode_health_session ON opencode_health (session_id, seq)`
    })
  }
}

const failure = (message: string) => (cause: unknown) => new StoreError({ message, cause })

const statement = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void, StoreError> =>
  effect.pipe(Effect.asVoid, Effect.mapError(failure("The store refused a statement")))

const parse = <A>(row: { readonly [column: string]: unknown }, column: string): A =>
  JSON.parse(String(row[column])) as A

/**
 * Builds the store over the ambient `SqlClient`, creating the tables first.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make: Effect.Effect<Service, StoreError, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* Migrations.run([migrations]).pipe(Effect.mapError(failure("The store could not create its tables")))

  const putSession: Service["putSession"] = (session) =>
    sql`INSERT INTO opencode_sessions (id, created_ms, info)
        VALUES (${session.id}, ${session.time.created}, ${JSON.stringify(session)})
        ON CONFLICT (id) DO UPDATE SET info = excluded.info`.pipe(
      Effect.asVoid,
      Effect.mapError(failure("The session could not be stored"))
    )

  const getSession: Service["getSession"] = (id) =>
    sql`SELECT info FROM opencode_sessions WHERE id = ${id}`.pipe(
      Effect.map((rows) => Option.map(Option.fromNullishOr(rows[0]), (row) => parse<Protocol.Session>(row, "info"))),
      Effect.mapError(failure("The session could not be read"))
    )

  const listSessions: Service["listSessions"] = () =>
    sql`SELECT info FROM opencode_sessions ORDER BY created_ms DESC, id ASC`.pipe(
      Effect.map((rows) => rows.map((row) => parse<Protocol.Session>(row, "info"))),
      Effect.mapError(failure("The sessions could not be listed"))
    )

  const deleteSession: Service["deleteSession"] = (id) =>
    Effect.gen(function*() {
      const existing = yield* getSession(id)
      if (Option.isNone(existing)) return false
      yield* statement(sql`DELETE FROM opencode_parts WHERE session_id = ${id}`)
      yield* statement(sql`DELETE FROM opencode_messages WHERE session_id = ${id}`)
      yield* statement(sql`DELETE FROM opencode_permissions WHERE session_id = ${id}`)
      yield* statement(sql`DELETE FROM opencode_grants WHERE session_id = ${id}`)
      yield* statement(sql`DELETE FROM opencode_turns WHERE session_id = ${id}`)
      yield* statement(sql`DELETE FROM opencode_health WHERE session_id = ${id}`)
      yield* statement(sql`DELETE FROM opencode_sessions WHERE id = ${id}`)
      return true
    })

  const putMessage: Service["putMessage"] = (message) =>
    sql`INSERT INTO opencode_messages (id, session_id, info)
        VALUES (${message.id}, ${message.sessionID}, ${JSON.stringify(message)})
        ON CONFLICT (id) DO UPDATE SET info = excluded.info`.pipe(
      Effect.asVoid,
      Effect.mapError(failure("The message could not be stored"))
    )

  const getMessage: Service["getMessage"] = (id) =>
    sql`SELECT info FROM opencode_messages WHERE id = ${id}`.pipe(
      Effect.map((rows) => Option.map(Option.fromNullishOr(rows[0]), (row) => parse<Protocol.Message>(row, "info"))),
      Effect.mapError(failure("The message could not be read"))
    )

  const listMessages: Service["listMessages"] = (sessionID, options = {}) =>
    Effect.gen(function*() {
      const limit = options.limit ?? defaultMessageLimit
      const rows = options.before === undefined
        ? yield* sql`SELECT info FROM opencode_messages WHERE session_id = ${sessionID}
                     ORDER BY id DESC LIMIT ${limit}`
        : yield* sql`SELECT info FROM opencode_messages WHERE session_id = ${sessionID} AND id < ${options.before}
                     ORDER BY id DESC LIMIT ${limit}`
      const messages = rows.map((row) => parse<Protocol.Message>(row, "info")).reverse()
      const parts = yield* sql`SELECT part FROM opencode_parts WHERE session_id = ${sessionID} ORDER BY id ASC`
      const byMessage = new Map<string, Array<Protocol.Part>>()
      for (const row of parts) {
        const part = parse<Protocol.Part>(row, "part")
        const list = byMessage.get(part.messageID)
        if (list === undefined) byMessage.set(part.messageID, [part])
        else list.push(part)
      }
      return messages.map((info): MessageWithParts => ({ info, parts: byMessage.get(info.id) ?? [] }))
    }).pipe(Effect.mapError(failure("The messages could not be listed")))

  const putPart: Service["putPart"] = (part) =>
    sql`INSERT INTO opencode_parts (id, message_id, session_id, part)
        VALUES (${part.id}, ${part.messageID}, ${part.sessionID}, ${JSON.stringify(part)})
        ON CONFLICT (id) DO UPDATE SET part = excluded.part`.pipe(
      Effect.asVoid,
      Effect.mapError(failure("The part could not be stored"))
    )

  const getPart: Service["getPart"] = (id) =>
    sql`SELECT part FROM opencode_parts WHERE id = ${id}`.pipe(
      Effect.map((rows) => Option.map(Option.fromNullishOr(rows[0]), (row) => parse<Protocol.Part>(row, "part"))),
      Effect.mapError(failure("The part could not be read"))
    )

  const putPermission: Service["putPermission"] = (request) =>
    sql`INSERT INTO opencode_permissions (id, session_id, request)
        VALUES (${request.id}, ${request.sessionID}, ${JSON.stringify(request)})
        ON CONFLICT (id) DO UPDATE SET request = excluded.request`.pipe(
      Effect.asVoid,
      Effect.mapError(failure("The permission could not be stored"))
    )

  const listPermissions: Service["listPermissions"] = (sessionID) =>
    (sessionID === undefined
      ? sql`SELECT request FROM opencode_permissions ORDER BY id ASC`
      : sql`SELECT request FROM opencode_permissions WHERE session_id = ${sessionID} ORDER BY id ASC`).pipe(
        Effect.map((rows) => rows.map((row) => parse<Protocol.PermissionRequest>(row, "request"))),
        Effect.mapError(failure("The permissions could not be listed"))
      )

  const deletePermission: Service["deletePermission"] = (id) =>
    sql`DELETE FROM opencode_permissions WHERE id = ${id} RETURNING id`.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(failure("The permission could not be deleted"))
    )

  const putGrant: Service["putGrant"] = (grant) =>
    sql`INSERT INTO opencode_grants (session_id, kind, key)
        VALUES (${grant.sessionID}, ${grant.kind}, ${grant.key})
        ON CONFLICT (session_id, kind, key) DO NOTHING`.pipe(
      Effect.asVoid,
      Effect.mapError(failure("The grant could not be stored"))
    )

  const listGrants: Service["listGrants"] = (sessionID) =>
    (sessionID === undefined
      ? sql`SELECT session_id, kind, key FROM opencode_grants ORDER BY seq ASC`
      : sql`SELECT session_id, kind, key FROM opencode_grants WHERE session_id = ${sessionID} ORDER BY seq ASC`).pipe(
        Effect.map((rows) =>
          rows.map((row): Grant => ({
            sessionID: String(row["session_id"]),
            kind: String(row["kind"]) as Grant["kind"],
            key: String(row["key"])
          }))
        ),
        Effect.mapError(failure("The grants could not be listed"))
      )

  const putTurn: Service["putTurn"] = (turn) =>
    sql`INSERT INTO opencode_turns (message_id, session_id, turn)
        VALUES (${turn.messageID}, ${turn.sessionID}, ${JSON.stringify(turn)})
        ON CONFLICT (message_id) DO UPDATE SET turn = excluded.turn`.pipe(
      Effect.asVoid,
      Effect.mapError(failure("The turn could not be stored"))
    )

  const listTurns: Service["listTurns"] = () =>
    sql`SELECT turn FROM opencode_turns ORDER BY message_id ASC`.pipe(
      Effect.map((rows) => rows.map((row) => parse<Turn>(row, "turn"))),
      Effect.mapError(failure("The turns could not be listed"))
    )

  const settleTurn: Service["settleTurn"] = (messageID) =>
    sql`DELETE FROM opencode_turns WHERE message_id = ${messageID} RETURNING message_id`.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(failure("The turn could not be settled"))
    )

  const putHealth: Service["putHealth"] = (entry) =>
    sql`INSERT INTO opencode_health (session_id, message_id, record)
        VALUES (${entry.sessionID}, ${entry.messageID}, ${JSON.stringify(entry)})`.pipe(
      Effect.asVoid,
      Effect.mapError(failure("The health decision could not be stored"))
    )

  const listHealth: Service["listHealth"] = (sessionID) =>
    (sessionID === undefined
      ? sql`SELECT record FROM opencode_health ORDER BY seq ASC`
      : sql`SELECT record FROM opencode_health WHERE session_id = ${sessionID} ORDER BY seq ASC`).pipe(
        Effect.map((rows) => rows.map((row) => parse<Health.Entry>(row, "record"))),
        Effect.mapError(failure("The health decisions could not be listed"))
      )

  const apply: Service["apply"] = (event) =>
    Effect.gen(function*() {
      const properties = event.properties
      switch (event.type) {
        case "session.created":
        case "session.updated":
          return yield* putSession(properties["info"] as Protocol.Session)
        case "session.deleted":
          return yield* Effect.asVoid(deleteSession((properties["info"] as Protocol.Session).id))
        case "message.updated":
          return yield* putMessage(properties["info"] as Protocol.Message)
        case "message.part.updated":
          return yield* putPart(properties["part"] as Protocol.Part)
        case "message.part.delta": {
          const partID = properties["partID"] as string
          const field = properties["field"] as string
          const delta = properties["delta"] as string
          const existing = yield* getPart(partID)
          if (Option.isNone(existing)) return
          const part = existing.value as unknown as Record<string, unknown>
          const current = part[field]
          return yield* putPart(
            { ...part, [field]: `${typeof current === "string" ? current : ""}${delta}` } as unknown as Protocol.Part
          )
        }
        case "permission.asked":
          return yield* putPermission(properties as unknown as Protocol.PermissionRequest)
        case "permission.replied":
          return yield* Effect.asVoid(deletePermission(properties["requestID"] as string))
        default:
          return
      }
    })

  return {
    putSession,
    getSession,
    listSessions,
    deleteSession,
    putMessage,
    getMessage,
    listMessages,
    putPart,
    getPart,
    putPermission,
    listPermissions,
    deletePermission,
    putGrant,
    listGrants,
    putTurn,
    listTurns,
    settleTurn,
    putHealth,
    listHealth,
    apply
  }
})

/**
 * The store over an ambient `SqlClient`.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer: Layer.Layer<Store, StoreError, SqlClient.SqlClient> = Layer.effect(Store, make)

/**
 * The store over its own SQLite file.
 *
 * @param filename the database file, created when absent
 * @category layers
 * @since 1.0.0
 */
export const layerSqlite = (filename: string): Layer.Layer<Store, StoreError> =>
  layer.pipe(
    Layer.provide(
      Layer.unwrap(
        Effect.sync(() => {
          mkdirSync(dirname(filename), { recursive: true })
          return NodeDatabase.layer({ filename })
        })
      )
    )
  )
