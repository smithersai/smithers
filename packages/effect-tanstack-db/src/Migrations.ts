/**
 * Migrations of the data a device keeps, across builds of a program.
 *
 * Every store a program keeps on the device declares its history here: an
 * append-only list of versions, each an Effect `Schema`, and a pure migration
 * between each pair. `registry` collects the declarations; the build carries
 * them, so each version is stamped on what it writes:
 *
 * - `local`: a collection whose rows exist only on the device, made with
 *   `Collection.persisted`. Older rows are migrated in place.
 * - `synced`: a collection a sync source fills, such as Electric's. Its rows
 *   are a cache: a new version drops them and the source sends them again.
 * - `payload`: the rows an outbox write carries, by the collection key the
 *   outbox names it with.
 * - `retired`: a store a build no longer keeps. Its rows are kept aside.
 *
 * `apply` brings a device store to this build's versions, one SQLite
 * transaction per collection, before anything reads it. `outbox` upgrades the
 * writes an older build stored before the outbox loads them. A row or write
 * that can't be brought forward is kept, never deleted: rows go to the
 * `device_kept` table, writes are parked. `fingerprint`, `lock` and `check`
 * make a schema change without a new version fail a test.
 *
 * Nothing here imports a platform: `apply` runs on any SQLite `execute`.
 *
 * @since 0.3.0
 */

import * as Clock from "effect/Clock"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Metric from "effect/Metric"
import * as Schema from "effect/Schema"
import type { Key } from "./internal/model.ts"
import { decodeStored, encodeKey, encodeStored, quote } from "./internal/stored.ts"

/**
 * A row schema: it checks rows and never transforms them, as
 * `Collection.RowSchema`.
 *
 * @category models
 * @since 0.3.0
 */
export type Row<A> = Schema.Codec<A, A>

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

/**
 * A migration refused a row: the new shape can't say what the old one meant.
 * `reason` names why, in a word, never with the row's content.
 *
 * @category errors
 * @since 0.3.0
 */
export class Unmigratable extends Data.TaggedError("Unmigratable")<{ readonly reason: string }> {}

/**
 * A declaration that can't hold: no versions, a migration missing or between
 * the wrong versions, or two stores with one id. Thrown as the program loads,
 * so a mistake fails every test.
 *
 * @category errors
 * @since 0.3.0
 */
export class InvalidDeclaration extends Data.TaggedError("InvalidDeclaration")<{
  readonly store: string
  readonly message: string
}> {}

/**
 * A pure change from version `from`'s row to version `to`'s. It returns the
 * new row, or `Unmigratable` to refuse it. It never changes the row's key.
 *
 * @category models
 * @since 0.3.0
 */
export interface Step<From = any, To = any> {
  readonly from: Row<From>
  readonly to: Row<To>
  readonly migrate: (row: From) => To | Unmigratable
}

/**
 * A migration from one version's row to the next's.
 *
 * @category constructors
 * @since 0.3.0
 */
export const step = <From, To>(
  from: Row<From>,
  to: Row<To>,
  migrate: (row: From) => To | Unmigratable
): Step<From, To> => ({ from, to, migrate })

/**
 * A collection whose rows exist only on the device. Its fields are
 * `Collection.persisted`'s options, so the declaration makes the collection.
 *
 * @category models
 * @since 0.3.0
 */
export interface Local<A extends object, K extends Key = Key> {
  readonly _tag: "Local"
  readonly id: string
  /** This build's row schema: the last version's. */
  readonly schema: Row<A>
  readonly getKey: (row: A) => K
  /** This build's version: `first` plus the number of versions after it. */
  readonly schemaVersion: number
  /** The version of `versions[0]`: 1, unless the store's earlier versions were never declared. */
  readonly first: number
  /** Every declared version's schema, oldest first: version `n` is `versions[n - first]`. */
  readonly versions: ReadonlyArray<Row<any>>
  /** `migrations[n - first]` takes version `n`'s row to version `n + 1`'s. */
  readonly migrations: ReadonlyArray<Step>
  /** Rows derived from elsewhere, such as a cache: a row that doesn't migrate is deleted and counted, not kept. */
  readonly discard: boolean
}

/**
 * A collection a sync source fills: its rows are the server's, so a new
 * version drops them and the source sends them again. With `family`, the
 * collections `<id>:<anything>` share its declaration, as one per conversation.
 *
 * @category models
 * @since 0.3.0
 */
export interface Synced<A extends object> {
  readonly _tag: "Synced"
  readonly id: string
  readonly family: boolean
  readonly schema: Row<A>
  readonly schemaVersion: number
}

/**
 * The rows an outbox write carries for the collection the outbox names `key`,
 * by version.
 *
 * @category models
 * @since 0.3.0
 */
export interface Payload<A extends object> {
  readonly _tag: "Payload"
  readonly key: string
  readonly schema: Row<A>
  readonly schemaVersion: number
  readonly versions: ReadonlyArray<Row<any>>
  readonly migrations: ReadonlyArray<Step>
}

/**
 * A store this build no longer keeps, at the last version a build kept. A
 * local one's rows are kept aside in `device_kept`.
 *
 * @category models
 * @since 0.3.0
 */
export interface Retired {
  readonly _tag: "Retired"
  readonly id: string
  readonly kind: "local" | "synced"
  readonly family: boolean
  readonly schemaVersion: number
}

/**
 * A store a device keeps.
 *
 * @category models
 * @since 0.3.0
 */
export type Store = Local<any, any> | Synced<any>

// Checks a history: one migration between each pair of versions, in order.
const history = (
  store: string,
  versions: ReadonlyArray<Row<any>>,
  migrations: ReadonlyArray<Step>,
  required: boolean
) => {
  if (versions.length === 0) throw new InvalidDeclaration({ store, message: "a store needs at least one version" })
  if (!required && migrations.length === 0) return
  if (migrations.length !== versions.length - 1) {
    throw new InvalidDeclaration({
      store,
      message: `${versions.length} versions need ${versions.length - 1} migrations, not ${migrations.length}`
    })
  }
  migrations.forEach((migration, index) => {
    if (migration.from !== versions[index] || migration.to !== versions[index + 1]) {
      throw new InvalidDeclaration({
        store,
        message: `migration ${index + 1} must take version ${index + 1}'s schema to version ${index + 2}'s`
      })
    }
  })
}

/**
 * Declares a local collection: its versions, oldest first, the migrations
 * between them, and its key. With `discard`, older rows that don't migrate,
 * or have no migrations, are deleted and counted instead of kept. `first` is
 * the version of the first schema listed, for a store whose earlier versions
 * were never declared: a row stored at one of them is kept, or deleted with
 * `discard`, as a version with no history is.
 *
 * ```ts
 * const Drafts = Migrations.local({
 *   id: "drafts",
 *   versions: [DraftV1, Draft],
 *   migrations: [Migrations.step(DraftV1, Draft, (row) => ({ ...row, title: "" }))],
 *   getKey: (row) => row.id
 * })
 * const drafts = yield* Collection.persisted(Drafts)
 * ```
 *
 * @category constructors
 * @since 0.3.0
 */
export const local = <A extends object, K extends Key>(options: {
  readonly id: string
  readonly versions: readonly [...ReadonlyArray<Row<any>>, Row<A>]
  readonly migrations?: ReadonlyArray<Step> | undefined
  readonly getKey: (row: NoInfer<A>) => K
  readonly discard?: boolean | undefined
  readonly first?: number | undefined
}): Local<A, K> => {
  const migrations = options.migrations ?? []
  const first = options.first ?? 1
  if (!Number.isInteger(first) || first < 1) {
    throw new InvalidDeclaration({ store: options.id, message: "a version is a whole number from 1" })
  }
  history(options.id, options.versions, migrations, options.discard !== true)
  return {
    _tag: "Local",
    id: options.id,
    schema: options.versions[options.versions.length - 1] as Row<A>,
    getKey: options.getKey,
    schemaVersion: first + options.versions.length - 1,
    first,
    versions: options.versions,
    migrations,
    discard: options.discard === true
  }
}

/**
 * Declares a synced collection at `version`, checked by `schema`. Any change
 * to the schema needs a new version, which drops the rows the device kept.
 *
 * @category constructors
 * @since 0.3.0
 */
export const synced = <A extends object>(options: {
  readonly id: string
  readonly version: number
  readonly schema: Row<A>
  readonly family?: boolean | undefined
}): Synced<A> => {
  if (!Number.isInteger(options.version) || options.version < 1) {
    throw new InvalidDeclaration({ store: options.id, message: "a version is a whole number from 1" })
  }
  return {
    _tag: "Synced",
    id: options.id,
    family: options.family === true,
    schema: options.schema,
    schemaVersion: options.version
  }
}

/**
 * The id of `name`'s collection in a family: `<id>:<name>`.
 *
 * @category constructors
 * @since 0.3.0
 */
export const member = (store: Synced<any>, name: string): string => `${store.id}:${name}`

/**
 * Declares the rows the outbox carries for collection `key`, by version.
 *
 * @category constructors
 * @since 0.3.0
 */
export const payload = <A extends object>(options: {
  readonly key: string
  readonly versions: readonly [...ReadonlyArray<Row<any>>, Row<A>]
  readonly migrations?: ReadonlyArray<Step> | undefined
}): Payload<A> => {
  const migrations = options.migrations ?? []
  history(options.key, options.versions, migrations, true)
  return {
    _tag: "Payload",
    key: options.key,
    schema: options.versions[options.versions.length - 1] as Row<A>,
    schemaVersion: options.versions.length,
    versions: options.versions,
    migrations
  }
}

/**
 * Declares a store this build no longer keeps, at the last version a build
 * kept it.
 *
 * @category constructors
 * @since 0.3.0
 */
export const retired = (options: {
  readonly id: string
  readonly kind: "local" | "synced"
  readonly version: number
  readonly family?: boolean | undefined
}): Retired => ({
  _tag: "Retired",
  id: options.id,
  kind: options.kind,
  family: options.family === true,
  schemaVersion: options.version
})

/**
 * What an outbox's writes may name: the payload of each collection, the
 * mutation names, the versions a write stored before stamping carries
 * (`unstamped`, by collection key), mutation names that changed (`renamed`,
 * old to new) and mutation names no build sends any more (`retired`): a write
 * naming one is parked.
 *
 * @category models
 * @since 0.3.0
 */
export interface OutboxDeclaration {
  readonly payloads: ReadonlyArray<Payload<any>>
  readonly mutations: ReadonlyArray<string>
  readonly unstamped?: Readonly<Record<string, number>> | undefined
  readonly renamed?: Readonly<Record<string, string>> | undefined
  readonly retired?: ReadonlyArray<string> | undefined
}

/**
 * Every store a program keeps, the stores it retired and its outbox's
 * writes. `epoch` grows with every new version, store or retirement, so two
 * builds compare by it.
 *
 * @category models
 * @since 0.3.0
 */
export interface Registry {
  readonly stores: ReadonlyArray<Store>
  readonly retired: ReadonlyArray<Retired>
  readonly outbox: OutboxDeclaration
  readonly epoch: number
}

/**
 * Collects a program's declarations. Two stores or payloads with one id are
 * an `InvalidDeclaration`, as is an unstamped version no payload has.
 *
 * @category constructors
 * @since 0.3.0
 */
export const registry = (options: {
  readonly stores: ReadonlyArray<Store>
  readonly retired?: ReadonlyArray<Retired> | undefined
  readonly outbox?: OutboxDeclaration | undefined
}): Registry => {
  const retiredStores = options.retired ?? []
  const outbox = options.outbox ?? { payloads: [], mutations: [] }
  const seen = new Set<string>()
  for (const id of [...options.stores, ...retiredStores].map((store) => store.id)) {
    if (seen.has(id)) throw new InvalidDeclaration({ store: id, message: "declared twice" })
    seen.add(id)
  }
  const keys = new Set<string>()
  for (const declared of outbox.payloads) {
    if (keys.has(declared.key)) throw new InvalidDeclaration({ store: declared.key, message: "declared twice" })
    keys.add(declared.key)
  }
  for (const [key, version] of Object.entries(outbox.unstamped ?? {})) {
    const declared = outbox.payloads.find((candidate) => candidate.key === key)
    if (declared === undefined || version < 1 || version > declared.schemaVersion) {
      throw new InvalidDeclaration({ store: key, message: `no payload version ${version} for unstamped writes` })
    }
  }
  const epoch = [...options.stores, ...outbox.payloads].reduce((sum, store) => sum + store.schemaVersion, 0) +
    retiredStores.reduce((sum, store) => sum + store.schemaVersion + 1, 0)
  return { stores: options.stores, retired: retiredStores, outbox, epoch }
}

const belongs = (store: { readonly id: string; readonly family: boolean }, collection: string) =>
  store.id === collection || (store.family && collection.startsWith(`${store.id}:`))

/**
 * The declaration a stored collection belongs to: a store, a retired store,
 * or none.
 *
 * @category declarations
 * @since 0.3.0
 */
export const declarationOf = (registry: Registry, collection: string): Store | Retired | undefined =>
  registry.stores.find((store) => belongs(store._tag === "Local" ? { id: store.id, family: false } : store, collection))
    ?? registry.retired.find((store) => belongs(store, collection))

/**
 * A collection opened that the registry doesn't declare, or at another
 * version or kind than declared.
 *
 * @category errors
 * @since 0.3.0
 */
export class Undeclared extends Data.TaggedError("Undeclared")<{
  readonly collection: string
  readonly kind: "local" | "synced"
  readonly schemaVersion: number
}> {}

/**
 * Whether `registry` declares collection `collection` as `kind` at
 * `schemaVersion`: an `Undeclared` when it doesn't.
 *
 * @category declarations
 * @since 0.3.0
 */
export const declared = (
  registry: Registry,
  collection: string,
  kind: "local" | "synced",
  schemaVersion: number
): Undeclared | undefined => {
  const store = declarationOf(registry, collection)
  const matches = store !== undefined && store._tag !== "Retired" && store.schemaVersion === schemaVersion &&
    (store._tag === "Local") === (kind === "local")
  return matches ? undefined : new Undeclared({ collection, kind, schemaVersion })
}

// ---------------------------------------------------------------------------
// Bringing a device store forward
// ---------------------------------------------------------------------------

/**
 * A SQLite database: runs one statement with its parameters and answers its
 * rows as objects. `@smthrs/platform-browser`'s `SharedSqlite` service is one;
 * `promiseSql` makes one from a `Promise` API.
 *
 * @category models
 * @since 0.3.0
 */
export interface Sql {
  readonly execute: (sql: string, params?: ReadonlyArray<unknown>) => Effect.Effect<ReadonlyArray<unknown>, unknown>
}

/**
 * `Sql` over a database with a `Promise` `execute`, as TanStack DB's browser
 * persistence takes one.
 *
 * @category constructors
 * @since 0.3.0
 */
export const promiseSql = (database: {
  readonly execute: (sql: string, params?: ReadonlyArray<unknown>) => Promise<ReadonlyArray<unknown>>
}): Sql => ({
  execute: (sql, params) => Effect.tryPromise(() => database.execute(sql, params ?? []))
})

/**
 * A statement failed while bringing collection `collection` forward. Its
 * transaction rolled back, so the collection is as it was.
 *
 * @category errors
 * @since 0.3.0
 */
export class MigrationFailed extends Data.TaggedError("MigrationFailed")<{
  readonly collection: string
  readonly cause: unknown
}> {}

/**
 * What `apply` did to one stored collection:
 * - `current`: it was at this build's version;
 * - `migrated`: its rows were brought to this build's version, `migrated` of
 *   them, with `kept` set aside and `dropped` deleted;
 * - `reset`: it was at a version this build can't read, newer or unknown, so
 *   its rows were set aside and it starts empty at this build's version;
 * - `resync`: a synced collection at another version, which drops its rows
 *   when it opens, and syncs again;
 * - `retired`: a store this build retired; its rows were set aside;
 * - `skipped`: no declaration names it: a newer build's.
 *
 * @category models
 * @since 0.3.0
 */
export const Outcome = Schema.Literals(["current", "migrated", "reset", "resync", "retired", "skipped"])

/**
 * One stored collection's outcome. `store` is the declaration's id; `from` the
 * stored version; `to` this build's, or null for one it doesn't declare.
 *
 * @category models
 * @since 0.3.0
 */
export const CollectionReport = Schema.Struct({
  collection: Schema.String,
  store: Schema.NullOr(Schema.String),
  outcome: Outcome,
  from: Schema.Number,
  to: Schema.NullOr(Schema.Number),
  migrated: Schema.Number,
  kept: Schema.Number,
  dropped: Schema.Number
})

/**
 * One stored collection's outcome, as `apply` reports it.
 *
 * @category models
 * @since 0.3.0
 */
export type CollectionReport = typeof CollectionReport.Type

/**
 * What `apply` did: the registry's epoch and each stored collection's
 * outcome. It names collections and counts, never a row's content.
 *
 * @category models
 * @since 0.3.0
 */
export const Report = Schema.Struct({ epoch: Schema.Number, collections: Schema.Array(CollectionReport) })

/**
 * What `apply` did to the device store.
 *
 * @category models
 * @since 0.3.0
 */
export type Report = typeof Report.Type

/**
 * Stored collections `apply` saw, by `store` and `outcome`.
 *
 * @category metrics
 * @since 0.3.0
 */
export const migrations = Metric.counter("device_migrations", {
  description: "Collections of the device store brought to this build's version, by store and outcome",
  incremental: true
})

/**
 * Rows set aside in `device_kept`, or deleted from a store that discards, by
 * `store` and `reason`.
 *
 * @category metrics
 * @since 0.3.0
 */
export const rowsKept = Metric.counter("device_rows_kept", {
  description: "Rows a migration couldn't bring forward, set aside or discarded, by store and reason",
  incremental: true
})

/**
 * Milliseconds `apply` took over the whole device store.
 *
 * @category metrics
 * @since 0.3.0
 */
export const applyMs = Metric.histogram("device_migrate_ms", {
  description: "Milliseconds to bring the device store to this build's versions",
  boundaries: Metric.exponentialBoundaries({ start: 1, factor: 2, count: 14 })
})

/**
 * The table rows are set aside in: a row a migration couldn't bring forward,
 * with its collection, key, version and stored value, why, and when.
 *
 * @category bringing forward
 * @since 0.3.0
 */
export const KEPT_TABLE = "device_kept"

interface StoredCollection {
  readonly collection_id: string
  readonly table_name: string
  readonly schema_version: number
}

interface StoredRow {
  readonly key: string
  readonly value: string
}

const nothing = { migrated: 0, kept: 0, dropped: 0 }

const report = (
  stored: StoredCollection,
  store: Store | Retired | undefined,
  outcome: typeof Outcome.Type,
  counts: { readonly migrated: number; readonly kept: number; readonly dropped: number } = nothing
): CollectionReport => ({
  collection: stored.collection_id,
  store: store?.id ?? null,
  outcome,
  from: stored.schema_version,
  to: store === undefined || store._tag === "Retired" ? null : store.schemaVersion,
  ...counts
})

/** A row brought forward, or why not. */
type Forward = { readonly _tag: "Row"; readonly value: string } | { readonly _tag: "Kept"; readonly reason: string }

const kept = (reason: string): Forward => ({ _tag: "Kept", reason })

/**
 * Brings one stored row of `store` from version `from` to this build's. It
 * decodes the row with its version's schema, runs each migration, checks the
 * result with this build's schema, and keeps the key.
 */
const forward = (store: Local<any, any>, from: number, row: StoredRow): Forward => {
  let value: unknown
  try {
    value = decodeStored(row.value)
  } catch {
    return kept("unreadable")
  }
  const decoded = Schema.decodeUnknownExit(store.versions[from - store.first]!)(value)
  if (Exit.isFailure(decoded)) return kept("decode")
  let current: unknown = decoded.value
  for (let version = from; version < store.schemaVersion; version++) {
    let next: unknown
    try {
      next = store.migrations[version - store.first]!.migrate(current)
    } catch {
      return kept("defect")
    }
    if (next instanceof Unmigratable) return kept(next.reason)
    current = next
  }
  const checked = Schema.decodeUnknownExit(store.schema)(current)
  if (Exit.isFailure(checked)) return kept("invalid")
  if (encodeKey(store.getKey(checked.value)) !== row.key) return kept("key")
  return { _tag: "Row", value: encodeStored(checked.value) }
}

/** Runs `body` in one transaction on `sql`, and rolls back if it fails. */
const transaction = <A>(sql: Sql, collection: string, body: Effect.Effect<A, unknown>) =>
  Effect.gen(function*() {
    yield* sql.execute("BEGIN IMMEDIATE")
    const exit = yield* Effect.exit(body)
    if (Exit.isFailure(exit)) {
      yield* Effect.ignore(sql.execute("ROLLBACK"))
      return yield* Effect.failCause(exit.cause)
    }
    yield* sql.execute("COMMIT")
    return exit.value
  }).pipe(Effect.mapError((cause) => new MigrationFailed({ collection, cause })))

/**
 * Brings a local collection forward in one transaction: migrates each row to
 * this build's version, sets aside each one that can't be, and records the
 * collection's version. A collection at a version this build has no history
 * for, newer or unknown, has every row set aside and starts empty.
 */
const bringLocal = (sql: Sql, store: Local<any, any>, stored: StoredCollection) =>
  transaction(
    sql,
    stored.collection_id,
    Effect.gen(function*() {
      const id = stored.collection_id
      // Read again inside the transaction: another program may have brought it forward already.
      const [now] = (yield* sql.execute(
        "SELECT schema_version FROM collection_registry WHERE collection_id = ?",
        [id]
      )) as ReadonlyArray<{ readonly schema_version: number }>
      const from = now!.schema_version
      if (from === store.schemaVersion) return report({ ...stored, schema_version: from }, store, "current")
      const table = quote(stored.table_name)
      const rows = (yield* sql.execute(`SELECT key, value FROM ${table}`)) as ReadonlyArray<StoredRow>
      // A store that discards needs no migrations: its older rows are deleted.
      const known = from >= store.first && from < store.schemaVersion && store.migrations.length > 0
      const reason = from > store.schemaVersion ? "newer" : from < store.first ? "unknown" : "discarded"
      const outcomes = rows.map((row) => ({ row, forward: known ? forward(store, from, row) : kept(reason) }))
      const [latest] = (yield* sql.execute(
        "SELECT latest_row_version FROM collection_version WHERE collection_id = ?",
        [id]
      )) as ReadonlyArray<{ readonly latest_row_version: number }>
      const rowVersion = (latest?.latest_row_version ?? 0) + 1
      const at = yield* Clock.currentTimeMillis
      let migrated = 0
      let keptRows = 0
      let dropped = 0
      for (const { forward, row } of outcomes) {
        if (forward._tag === "Row") {
          migrated++
          yield* sql.execute(`UPDATE ${table} SET value = ?, row_version = ? WHERE key = ?`, [
            forward.value,
            rowVersion,
            row.key
          ])
          continue
        }
        if (store.discard) dropped++
        else {
          keptRows++
          yield* sql.execute(
            `INSERT OR REPLACE INTO ${KEPT_TABLE} (collection_id, key, version, value, reason, kept_at) VALUES (?, ?, ?, ?, ?, ?)`,
            [id, row.key, from, row.value, forward.reason, at]
          )
        }
        yield* Metric.update(Metric.withAttributes(rowsKept, { store: store.id, reason: forward.reason }), 1)
        // The persistence notices a key leaving its expected set; remove it there first.
        yield* sql.execute("DELETE FROM collection_expected_keys WHERE collection_id = ? AND key = ?", [id, row.key])
        yield* sql.execute(`DELETE FROM ${table} WHERE key = ?`, [row.key])
      }
      if (outcomes.length > 0) {
        yield* sql.execute("UPDATE collection_version SET latest_row_version = ? WHERE collection_id = ?", [
          rowVersion,
          id
        ])
      }
      yield* sql.execute("UPDATE collection_registry SET schema_version = ? WHERE collection_id = ?", [
        store.schemaVersion,
        id
      ])
      return report({ ...stored, schema_version: from }, store, known ? "migrated" : "reset", {
        migrated,
        kept: keptRows,
        dropped
      })
    })
  )

/** Sets aside every row of a retired local collection, and empties it. */
const retire = (sql: Sql, store: Retired, stored: StoredCollection) =>
  transaction(
    sql,
    stored.collection_id,
    Effect.gen(function*() {
      const id = stored.collection_id
      const table = quote(stored.table_name)
      const rows = (yield* sql.execute(`SELECT key, value FROM ${table}`)) as ReadonlyArray<StoredRow>
      const at = yield* Clock.currentTimeMillis
      for (const row of rows) {
        yield* sql.execute(
          `INSERT OR REPLACE INTO ${KEPT_TABLE} (collection_id, key, version, value, reason, kept_at) VALUES (?, ?, ?, ?, ?, ?)`,
          [id, row.key, stored.schema_version, row.value, "retired", at]
        )
        yield* Metric.update(Metric.withAttributes(rowsKept, { store: store.id, reason: "retired" }), 1)
        yield* sql.execute("DELETE FROM collection_expected_keys WHERE collection_id = ? AND key = ?", [id, row.key])
        yield* sql.execute(`DELETE FROM ${table} WHERE key = ?`, [row.key])
      }
      return report(stored, store, "retired", { migrated: 0, kept: rows.length, dropped: 0 })
    })
  )

const bring = (sql: Sql, registry: Registry, stored: StoredCollection) => {
  const store = declarationOf(registry, stored.collection_id)
  if (store === undefined) return Effect.succeed(report(stored, store, "skipped"))
  if (store._tag === "Retired") {
    return store.kind === "local" ? retire(sql, store, stored) : Effect.succeed(report(stored, store, "retired"))
  }
  if (stored.schema_version === store.schemaVersion) return Effect.succeed(report(stored, store, "current"))
  // A synced collection's rows are the server's: the persistence drops them as it opens, and they sync again.
  if (store._tag === "Synced") return Effect.succeed(report(stored, store, "resync"))
  return bringLocal(sql, store, stored)
}

/**
 * Logs and counts one collection's outcome, without its rows: at Warn when a migration couldn't bring rows forward,
 * so they were set aside or dropped and no longer show; Debug when it was current; Info otherwise.
 */
const record = (outcome: CollectionReport) =>
  Effect.all([
    Metric.update(
      Metric.withAttributes(migrations, { store: outcome.store ?? "undeclared", outcome: outcome.outcome }),
      1
    ),
    (outcome.outcome === "current"
      ? Effect.logDebug
      : outcome.outcome === "migrated" && outcome.kept + outcome.dropped > 0
      ? Effect.logWarning
      : Effect.logInfo)("device.migrate").pipe(
      Effect.annotateLogs({ ...outcome, store: outcome.store ?? "undeclared", to: outcome.to ?? "none" })
    )
  ], { discard: true })

/**
 * Brings every collection of the device store on `sql` to this build's
 * version, before anything reads it: each local collection in one
 * transaction, which first reads its version again, so running `apply` again,
 * or from two programs, does nothing more. A synced collection at another
 * version is left for the persistence, which drops its rows as it opens.
 * Rows that can't be brought forward go to `device_kept`. A database the
 * persistence never wrote to has nothing to bring forward.
 *
 * Each collection's outcome is a log line `device.migrate` and a count of
 * `migrations`; each row set aside counts in `rowsKept`; the whole run is a
 * span `device.migrate` and a `applyMs` sample. None carries a row's content.
 * A statement that fails ends `apply` with `MigrationFailed`, and the
 * collection it was bringing forward is as it was.
 *
 * @category bringing forward
 * @since 0.3.0
 */
export const apply = (registry: Registry, sql: Sql): Effect.Effect<Report, MigrationFailed> =>
  Effect.gen(function*() {
    const startedAt = yield* Clock.currentTimeMillis
    const fail = (cause: unknown) => new MigrationFailed({ collection: "collection_registry", cause })
    const tables = yield* sql.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'collection_registry'"
    ).pipe(Effect.mapError(fail))
    if (tables.length === 0) return { epoch: registry.epoch, collections: [] }
    yield* sql.execute(
      `CREATE TABLE IF NOT EXISTS ${KEPT_TABLE} (collection_id TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL, value TEXT NOT NULL, reason TEXT NOT NULL, kept_at INTEGER NOT NULL, PRIMARY KEY (collection_id, key, version))`
    ).pipe(Effect.mapError(fail))
    const stored = (yield* sql.execute(
      "SELECT collection_id, table_name, schema_version FROM collection_registry ORDER BY collection_id"
    ).pipe(Effect.mapError(fail))) as ReadonlyArray<StoredCollection>
    const collections: Array<CollectionReport> = []
    for (const collection of stored) {
      const outcome = yield* bring(sql, registry, collection)
      yield* record(outcome)
      collections.push(outcome)
    }
    yield* Metric.update(applyMs, (yield* Clock.currentTimeMillis) - startedAt)
    return { epoch: registry.epoch, collections }
  }).pipe(Effect.withSpan("device.migrate", { attributes: { epoch: registry.epoch } }))

/**
 * What a host runs before it serves the device store:
 * `@smthrs/platform-browser`'s `BrowserRuntime.run({ prepare })` runs `run`
 * once per `epoch`, as the durable flow `device/prepare`, whose result is a
 * `Report`.
 *
 * @category bringing forward
 * @since 0.3.0
 */
export const prepare = (registry: Registry) => ({
  epoch: registry.epoch,
  success: Report,
  run: (sql: Sql) => apply(registry, sql)
})

// ---------------------------------------------------------------------------
// The outbox
// ---------------------------------------------------------------------------

/**
 * A stored outbox write, as this build should store it:
 * - `Current`: as stored;
 * - `Upgraded`: its rows brought to this build's versions, stamped, as
 *   `value`;
 * - `Parked`: this build can't send it, for `reason`: `unreadable`, a
 *   `mutation` or `collection` it doesn't have, a `newer` or `unknown`
 *   version, a row that won't `decode`, or a migration's own reason.
 *
 * @category outbox
 * @since 0.3.0
 */
export type UpgradedWrite =
  | { readonly _tag: "Current" }
  | { readonly _tag: "Upgraded"; readonly value: string }
  | { readonly _tag: "Parked"; readonly reason: string }

/**
 * What `Outbox.layer` takes to carry writes across builds: the versions
 * `transact` stamps on each write, and the upgrade of a stored one.
 *
 * @category outbox
 * @since 0.3.0
 */
export interface OutboxUpgrade {
  readonly stamp: Readonly<Record<string, number>>
  readonly write: (stored: string) => UpgradedWrite
}

interface StoredMutation {
  readonly collectionId: string
  readonly type: string
  readonly modified?: unknown
  readonly original?: unknown
  readonly changes?: unknown
  readonly [field: string]: unknown
}

interface StoredWrite {
  readonly mutationFnName: string
  readonly mutations: ReadonlyArray<StoredMutation>
  readonly metadata?: { readonly versions?: Readonly<Record<string, number>>; readonly [field: string]: unknown }
  readonly [field: string]: unknown
}

const parked = (reason: string): UpgradedWrite => ({ _tag: "Parked", reason })

/** One row of a write from version `from` to `declared`'s current one, or why not. */
const upgradeRow = (declared: Payload<any>, from: number, row: unknown): { readonly row: unknown } | string => {
  const decoded = Schema.decodeUnknownExit(declared.versions[from - 1]!)(row)
  if (Exit.isFailure(decoded)) return "decode"
  let current: unknown = decoded.value
  for (let version = from; version < declared.schemaVersion; version++) {
    let next: unknown
    try {
      next = declared.migrations[version - 1]!.migrate(current)
    } catch {
      return "defect"
    }
    if (next instanceof Unmigratable) return next.reason
    current = next
  }
  const checked = Schema.decodeUnknownExit(declared.schema)(current)
  return Exit.isFailure(checked) ? "invalid" : { row: checked.value }
}

const isRow = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length > 0

/** The fields an update changed: those whose values differ from the row before it. */
const changesOf = (original: Record<string, unknown>, modified: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(modified).filter(([field, value]) => JSON.stringify(original[field]) !== JSON.stringify(value))
  )

/**
 * Carries a program's outbox writes across builds: `stamp` is each payload's
 * version, which `Outbox.transact` stores with every write, and `write`
 * upgrades a stored write an older build made, by the versions it was
 * stamped with or, for one stored before stamping, the declared `unstamped`
 * versions. A mutation name in `renamed` takes its new name. A write this
 * build can't send as it means is parked, never changed.
 *
 * @category outbox
 * @since 0.3.0
 */
export const outbox = (registry: Registry): OutboxUpgrade => {
  const declaration = registry.outbox
  const payloads = new Map(declaration.payloads.map((declared) => [declared.key, declared]))
  const stamp = Object.fromEntries(declaration.payloads.map((declared) => [declared.key, declared.schemaVersion]))
  const write = (stored: string): UpgradedWrite => {
    let parsed: StoredWrite
    try {
      parsed = JSON.parse(stored) as StoredWrite
    } catch {
      return parked("unreadable")
    }
    if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.mutations)) return parked("unreadable")
    const name = declaration.renamed?.[parsed.mutationFnName] ?? parsed.mutationFnName
    if (!declaration.mutations.includes(name)) return parked("mutation")
    const versions = parsed.metadata?.versions ?? declaration.unstamped ?? {}
    let changed = name !== parsed.mutationFnName || parsed.metadata?.versions === undefined
    const mutations: Array<StoredMutation> = []
    for (const mutation of parsed.mutations) {
      const declared = payloads.get(mutation.collectionId)
      if (declared === undefined) return parked("collection")
      const from = versions[mutation.collectionId]
      if (from === undefined || !Number.isInteger(from) || from < 1) return parked("unknown")
      if (from > declared.schemaVersion) return parked("newer")
      if (from === declared.schemaVersion) {
        mutations.push(mutation)
        continue
      }
      changed = true
      const modified = upgradeRow(declared, from, mutation.modified)
      if (typeof modified === "string") return parked(modified)
      let original: unknown = mutation.original
      if (isRow(mutation.original)) {
        const upgraded = upgradeRow(declared, from, mutation.original)
        if (typeof upgraded === "string") return parked(upgraded)
        original = upgraded.row
      }
      const changes = mutation.type === "update" && isRow(original)
        ? changesOf(original, modified.row as Record<string, unknown>)
        : mutation.type === "delete"
        ? mutation.changes
        : modified.row
      mutations.push({ ...mutation, modified: modified.row, original, changes })
    }
    if (!changed) return { _tag: "Current" }
    const stamped = Object.fromEntries(
      parsed.mutations.map((mutation) => [mutation.collectionId, stamp[mutation.collectionId]])
    )
    return {
      _tag: "Upgraded",
      value: JSON.stringify({
        ...parsed,
        mutationFnName: name,
        mutations,
        metadata: { ...parsed.metadata, versions: stamped }
      })
    }
  }
  return { stamp, write }
}

// ---------------------------------------------------------------------------
// The lock: a schema change needs a new version
// ---------------------------------------------------------------------------

// Object keys, and the set of required fields, in order, so schemas that differ only in field order print alike.
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => {
      const entry = (value as Record<string, unknown>)[key]
      return [key, key === "required" && Array.isArray(entry) ? [...entry].sort() : canonical(entry)]
    })
  )
}

// FNV-1a, 64 bits: a fingerprint, not a secret.
const fnv1a = (text: string): string => {
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < text.length; index++) {
    hash ^= BigInt(text.charCodeAt(index))
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, "0")
}

/**
 * A schema's fingerprint: a hash of its JSON Schema document with its keys
 * in order. Two schemas that check rows alike have the same one; a check JSON
 * Schema can't state, such as a custom filter, leaves it unchanged.
 *
 * @category lock
 * @since 0.3.0
 */
export const fingerprint = (schema: Schema.Top): string =>
  fnv1a(JSON.stringify(canonical(Schema.toJsonSchemaDocument(schema))))

/**
 * One store in the lock: its kind, whether it is retired, and each version's
 * fingerprint, by version.
 *
 * @category lock
 * @since 0.3.0
 */
export interface LockEntry {
  readonly kind: "local" | "synced" | "payload"
  readonly retired?: true | undefined
  readonly versions: Readonly<Record<string, string>>
}

/**
 * Every store's fingerprints by version, as builds recorded them: the file a
 * program commits beside its registry.
 *
 * @category lock
 * @since 0.3.0
 */
export interface Lock {
  readonly epoch: number
  readonly stores: Readonly<Record<string, LockEntry>>
  readonly payloads: Readonly<Record<string, LockEntry>>
  readonly mutations: ReadonlyArray<string>
}

/**
 * Something the lock says is wrong with a registry:
 * - `changed_without_version`: the schema of a version the lock recorded
 *   changed: the store needs a new version, and a local one a migration;
 * - `history_changed`: an older version's schema differs from the one
 *   recorded: an old shape was edited;
 * - `version_went_back`: the store is at a lower version than recorded;
 * - `kind_changed`: a store changed kind;
 * - `removed`: a store or payload the lock records is no longer declared, nor
 *   retired;
 * - `mutation_removed`: a mutation name the lock records is gone, neither
 *   renamed nor retired;
 * - `unrecorded`: a version the lock doesn't have yet; recording it is
 *   `lock`'s job.
 *
 * @category lock
 * @since 0.3.0
 */
export interface Problem {
  readonly store: string
  readonly problem:
    | "changed_without_version"
    | "history_changed"
    | "version_went_back"
    | "kind_changed"
    | "removed"
    | "mutation_removed"
    | "unrecorded"
  readonly version?: number | undefined
}

interface Entry {
  readonly id: string
  readonly kind: LockEntry["kind"]
  readonly schemaVersion: number
  // The schemas of the versions this build still has, by version.
  readonly schemas: ReadonlyMap<number, Schema.Top>
}

const entries = (registry: Registry) => {
  const stores = registry.stores.map((store): Entry => ({
    id: store.id,
    kind: store._tag === "Local" ? "local" : "synced",
    schemaVersion: store.schemaVersion,
    schemas: store._tag === "Local"
      ? new Map(store.versions.map((schema, index) => [index + store.first, schema]))
      : new Map([[store.schemaVersion, store.schema]])
  }))
  const payloads = registry.outbox.payloads.map((declared): Entry => ({
    id: declared.key,
    kind: "payload",
    schemaVersion: declared.schemaVersion,
    schemas: new Map(declared.versions.map((schema, index) => [index + 1, schema]))
  }))
  return { stores, payloads }
}

const compare = (declared: ReadonlyArray<Entry>, recorded: Readonly<Record<string, LockEntry>>) => {
  const problems: Array<Problem> = []
  for (const entry of declared) {
    const previous = recorded[entry.id]
    if (previous === undefined) {
      problems.push({ store: entry.id, problem: "unrecorded", version: entry.schemaVersion })
      continue
    }
    if (previous.kind !== entry.kind) problems.push({ store: entry.id, problem: "kind_changed" })
    const highest = Math.max(...Object.keys(previous.versions).map(Number))
    if (highest > entry.schemaVersion) {
      problems.push({ store: entry.id, problem: "version_went_back", version: entry.schemaVersion })
    }
    for (const [version, schema] of entry.schemas) {
      const was = previous.versions[String(version)]
      if (was === undefined) {
        problems.push({ store: entry.id, problem: "unrecorded", version })
        continue
      }
      if (was === fingerprint(schema)) continue
      problems.push({
        store: entry.id,
        problem: version === entry.schemaVersion ? "changed_without_version" : "history_changed",
        version
      })
    }
  }
  return problems
}

/**
 * What is wrong with `registry` against the lock it was recorded in, if any:
 * every `Problem`. With no lock, every store is `unrecorded`.
 *
 * @category lock
 * @since 0.3.0
 */
export const check = (registry: Registry, lock: Lock | undefined): ReadonlyArray<Problem> => {
  const declared = entries(registry)
  const recorded = lock ?? { epoch: 0, stores: {}, payloads: {}, mutations: [] }
  const problems = [...compare(declared.stores, recorded.stores), ...compare(declared.payloads, recorded.payloads)]
  const ids = new Set([...registry.stores, ...registry.retired].map((store) => store.id))
  for (const [id, entry] of Object.entries(recorded.stores)) {
    if (!ids.has(id) && entry.retired !== true) problems.push({ store: id, problem: "removed" })
  }
  const keys = new Set(registry.outbox.payloads.map((declared) => declared.key))
  for (const key of Object.keys(recorded.payloads)) {
    if (!keys.has(key)) problems.push({ store: key, problem: "removed" })
  }
  const names = new Set([
    ...registry.outbox.mutations,
    ...Object.keys(registry.outbox.renamed ?? {}),
    ...(registry.outbox.retired ?? [])
  ])
  for (const name of recorded.mutations) {
    if (!names.has(name)) problems.push({ store: name, problem: "mutation_removed" })
  }
  return problems
}

const recordVersions = (declared: ReadonlyArray<Entry>, recorded: Readonly<Record<string, LockEntry>>) =>
  Object.fromEntries(declared.map((entry) => {
    const versions: Record<string, string> = { ...recorded[entry.id]?.versions }
    for (const [version, schema] of entry.schemas) versions[String(version)] ??= fingerprint(schema)
    return [entry.id, { kind: entry.kind, versions }]
  }))

/**
 * The lock with `registry`'s new versions recorded beside `previous`'s, or
 * the problems that stop it: recording never rewrites a version's
 * fingerprint, so a changed schema needs a new version first. Retired stores
 * stay, marked retired.
 *
 * @category lock
 * @since 0.3.0
 */
export const lock = (
  registry: Registry,
  previous: Lock | undefined
): { readonly lock: Lock; readonly refused: ReadonlyArray<Problem> } => {
  const recorded = previous ?? { epoch: 0, stores: {}, payloads: {}, mutations: [] }
  const refused = check(registry, previous).filter((problem) => problem.problem !== "unrecorded")
  const declared = entries(registry)
  const retiredStores = Object.fromEntries(
    registry.retired.map((store) => [store.id, {
      ...(recorded.stores[store.id] ?? { kind: store.kind, versions: {} }),
      retired: true as const
    }])
  )
  return {
    refused,
    lock: {
      epoch: registry.epoch,
      stores: { ...recordVersions(declared.stores, recorded.stores), ...retiredStores },
      payloads: recordVersions(declared.payloads, recorded.payloads),
      mutations: [...new Set(registry.outbox.mutations)]
    }
  }
}
