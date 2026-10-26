import { createBrowserWASQLitePersistence } from "@tanstack/browser-db-sqlite-persistence"
import { Arbitrary, Effect, Exit, Layer, Metric, Option, Schema, Scope } from "effect"
import { describe, expect, test } from "vitest"
import { Collection, Migrations, Persistence } from "../src/index.ts"
import { databaseFile, id, Note, persistenceOn, sqlite, withLogs } from "./fixtures.ts"

// Bringing a device store forward, against TanStack DB's real persistence over a SQLite file in Node: a program at
// one version writes rows and closes, `apply` runs, and a program at the next version opens the same file. Each
// program is its own scope, so closing one and opening the next is a reload into a new build.

const NoteV1 = Note
const NoteV2 = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  n: Schema.Number,
  tags: Schema.Array(Schema.String)
})
type NoteV2 = typeof NoteV2.Type
const NoteV3 = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  n: Schema.Number,
  tags: Schema.Array(Schema.String)
})

const toV2 = Migrations.step(
  NoteV1,
  NoteV2,
  (row) => row.n < 0 ? new Migrations.Unmigratable({ reason: "negative" }) : { ...row, tags: [] }
)
const toV3 = Migrations.step(NoteV2, NoteV3, ({ text, ...row }) => ({ ...row, body: text }))

const notesAt = (collection: string, version: 1 | 2 | 3) =>
  Migrations.local({
    id: collection,
    versions: ([NoteV1, NoteV2, NoteV3] as const).slice(0, version) as never,
    migrations: [toV2, toV3].slice(0, version - 1),
    getKey: (row: { readonly id: string }) => row.id
  }) as Migrations.Local<any, string>

const ownMetrics = () => Layer.succeed(Metric.MetricRegistry, new Map())

const program = <A, E>(
  path: string,
  effect: Effect.Effect<A, E, Persistence.Persistence | Scope.Scope>,
  registry?: Migrations.Registry
) =>
  Effect.runPromise(
    Effect.scoped(effect).pipe(
      Effect.provide(
        registry === undefined ? persistenceOn(path) : Persistence.layer({
          open: () => sqlite(path),
          make: (database) => persistenceFor(database),
          registry
        })
      ),
      Effect.provide(ownMetrics())
    )
  )

// The browser persistence, as `persistenceOn` builds it.
const persistenceFor = (database: ReturnType<typeof sqlite>) => createBrowserWASQLitePersistence({ database })

/** Writes `rows` into local collection `store` and closes. */
const writeLocal = (path: string, store: Migrations.Local<any, string>, rows: ReadonlyArray<unknown>) =>
  program(
    path,
    Effect.gen(function*() {
      const collection = yield* Collection.persisted(store)
      yield* collection.restored
      if (rows.length > 0) yield* (yield* collection.insert(rows as never)).persisted
    })
  )

/** The rows local collection `store` restores. */
const readLocal = (path: string, store: Migrations.Local<any, string>) =>
  program(
    path,
    Effect.gen(function*() {
      const collection = yield* Collection.persisted(store)
      yield* collection.restored
      return [...(yield* collection.toArray)].map(plain).sort((a: any, b: any) => a.id.localeCompare(b.id))
    })
  )

const applyOn = (path: string, registry: Migrations.Registry) => {
  const database = sqlite(path)
  return Effect.runPromise(
    Migrations.apply(registry, Migrations.promiseSql(database)).pipe(
      Effect.ensuring(Effect.sync(() => database.close())),
      Effect.provide(ownMetrics())
    )
  )
}

const keptRows = async (path: string) => {
  const database = sqlite(path)
  try {
    return await database.execute<{ collection_id: string; key: string; version: number; reason: string }>(
      "SELECT collection_id, key, version, reason FROM device_kept ORDER BY key"
    )
  } finally {
    database.close()
  }
}

const v1 = (key: string, n: number, text = key) => ({ id: key, text, n })

// A row as stored: TanStack DB's virtual `$` fields left out.
const plain = (row: object) => Object.fromEntries(Object.entries(row).filter(([field]) => !field.startsWith("$")))

// A sync source that writes `rows` once started and is ready: a network that answers.
const source = (rows: ReadonlyArray<object>) => ({
  sync: ({ begin, write, commit, markReady }: {
    readonly begin: () => void
    readonly write: (message: { readonly type: "insert"; readonly value: object }) => void
    readonly commit: () => void
    readonly markReady: () => void
  }) => {
    if (rows.length > 0) {
      begin()
      for (const row of rows) write({ type: "insert", value: row })
      commit()
    }
    markReady()
  }
})

const syncedAt = <A extends object>(store: Migrations.Synced<A>, collection: string, rows: ReadonlyArray<A>) =>
  Collection.make(store.schema, { id: collection, getKey: (row: any) => row.id, sync: source(rows) } as never, {
    persist: { schemaVersion: store.schemaVersion }
  }) as Effect.Effect<Collection.Collection<any, string>, never, Scope.Scope | Persistence.Persistence>

describe("declarations", () => {
  test("a local store's version is its number of versions, its schema the last, and its key the declared one", () => {
    const store = notesAt("notes", 3)
    expect(store.schemaVersion).toBe(3)
    expect(store.schema).toBe(NoteV3)
    expect(store.getKey({ id: "a" })).toBe("a")
    expect(store.discard).toBe(false)
  })

  test("a history with no versions, a missing migration or one between the wrong versions can't be declared", () => {
    const refusal = (declare: () => unknown) => {
      try {
        declare()
      } catch (error) {
        return (error as Migrations.InvalidDeclaration).message
      }
      return "declared"
    }
    expect(refusal(() => Migrations.local({ id: "a", versions: [] as never, getKey: () => "" }))).toBe(
      "a store needs at least one version"
    )
    expect(refusal(() => Migrations.local({ id: "a", versions: [NoteV1, NoteV2], getKey: (row) => row.id }))).toBe(
      "2 versions need 1 migrations, not 0"
    )
    expect(
      refusal(() =>
        Migrations.local({
          id: "a",
          versions: [NoteV1, NoteV2, NoteV3],
          migrations: [toV3, toV2],
          getKey: (row) => row.id
        })
      )
    ).toBe("migration 1 must take version 1's schema to version 2's")
    expect(refusal(() => Migrations.payload({ key: "p", versions: [NoteV1, NoteV2] }))).toBe(
      "2 versions need 1 migrations, not 0"
    )
    expect(refusal(() => Migrations.synced({ id: "s", version: 0, schema: Note }))).toBe(
      "a version is a whole number from 1"
    )
    expect(refusal(() => Migrations.synced({ id: "s", version: 1.5, schema: Note }))).toBe(
      "a version is a whole number from 1"
    )
    expect(refusal(() => Migrations.local({ id: "l", versions: [NoteV1], getKey: (row) => row.id, first: 0 }))).toBe(
      "a version is a whole number from 1"
    )
  })

  test("a store that discards may skip its migrations", () => {
    const cache = Migrations.local({ id: "cache", versions: [NoteV1, NoteV2], getKey: (row) => row.id, discard: true })
    expect(cache.migrations).toEqual([])
    expect(cache.discard).toBe(true)
  })

  test("a registry refuses two stores or payloads with one id, and unstamped versions no payload has", () => {
    const message = (declare: () => unknown) => {
      try {
        declare()
        return "declared"
      } catch (error) {
        return `${(error as Migrations.InvalidDeclaration).store}: ${(error as Migrations.InvalidDeclaration).message}`
      }
    }
    const note = Migrations.synced({ id: "n", version: 1, schema: Note })
    expect(
      message(() =>
        Migrations.registry({ stores: [note], retired: [Migrations.retired({ id: "n", kind: "local", version: 1 })] })
      )
    )
      .toBe("n: declared twice")
    const payload = Migrations.payload({ key: "p", versions: [NoteV1] })
    expect(message(() => Migrations.registry({ stores: [], outbox: { payloads: [payload, payload], mutations: [] } })))
      .toBe("p: declared twice")
    expect(
      message(() =>
        Migrations.registry({ stores: [], outbox: { payloads: [payload], mutations: [], unstamped: { p: 2 } } })
      )
    ).toBe("p: no payload version 2 for unstamped writes")
    expect(
      message(() =>
        Migrations.registry({ stores: [], outbox: { payloads: [payload], mutations: [], unstamped: { q: 1 } } })
      )
    ).toBe("q: no payload version 1 for unstamped writes")
    expect(
      message(() =>
        Migrations.registry({ stores: [], outbox: { payloads: [payload], mutations: [], unstamped: { p: 0 } } })
      )
    ).toBe("p: no payload version 0 for unstamped writes")
  })

  test("the epoch sums every version, plus one for each retired store, so it grows with each change", () => {
    const stores = [notesAt("a", 2), Migrations.synced({ id: "s", version: 3, schema: Note })]
    const outbox = { payloads: [Migrations.payload({ key: "p", versions: [NoteV1] })], mutations: ["save"] }
    const before = Migrations.registry({ stores, outbox })
    const retiring = Migrations.registry({
      stores: [stores[1]!],
      retired: [Migrations.retired({ id: "a", kind: "local", version: 2 })],
      outbox
    })
    expect(before.epoch).toBe(6)
    expect(retiring.epoch).toBe(7)
    expect(Migrations.registry({ stores: [] }).epoch).toBe(0)
  })

  test("a family names its members, and a declaration is found by id, by family or among the retired", () => {
    const messages = Migrations.synced({ id: "messages", version: 2, schema: Note, family: true })
    const local = notesAt("drafts", 1)
    const gone = Migrations.retired({ id: "views", kind: "synced", version: 1, family: true })
    const registry = Migrations.registry({ stores: [messages, local], retired: [gone] })
    expect(Migrations.member(messages, "c1")).toBe("messages:c1")
    expect(Migrations.declarationOf(registry, "messages")).toBe(messages)
    expect(Migrations.declarationOf(registry, "messages:c1")).toBe(messages)
    expect(Migrations.declarationOf(registry, "drafts")).toBe(local)
    expect(Migrations.declarationOf(registry, "drafts:x")).toBeUndefined()
    expect(Migrations.declarationOf(registry, "views:c2")).toBe(gone)
    expect(Migrations.declarationOf(registry, "other")).toBeUndefined()
    expect(Migrations.declared(registry, "messages:c1", "synced", 2)).toBeUndefined()
    expect(Migrations.declared(registry, "drafts", "local", 1)).toBeUndefined()
    expect(Migrations.declared(registry, "messages", "synced", 1)?._tag).toBe("Undeclared")
    expect(Migrations.declared(registry, "drafts", "synced", 1)?._tag).toBe("Undeclared")
    expect(Migrations.declared(registry, "views:c2", "synced", 1)?._tag).toBe("Undeclared")
    expect(Migrations.declared(registry, "other", "local", 1)).toMatchObject({ collection: "other", kind: "local" })
  })
})

describe("a registry given to the persistence", () => {
  test("opens a declared collection, and refuses one it doesn't declare, at another version or of another kind", async () => {
    const path = databaseFile()
    const collection = id("notes")
    const store = notesAt(collection, 1)
    const synced = Migrations.synced({ id: id("synced"), version: 2, schema: Note })
    const registry = Migrations.registry({ stores: [store, synced] })
    await program(
      path,
      Effect.gen(function*() {
        yield* (yield* Collection.persisted(store)).restored
        yield* (yield* syncedAt(synced, synced.id, [])).restored
      }),
      registry
    )
    const refused = (effect: Effect.Effect<unknown, unknown, Persistence.Persistence | Scope.Scope>) =>
      Effect.runPromiseExit(
        Effect.scoped(effect).pipe(
          Effect.provide(Persistence.layer({ open: () => sqlite(path), make: persistenceFor, registry }))
        )
      ).then((exit) => (Exit.isFailure(exit) ? String(exit.cause) : "opened"))
    expect(await refused(Collection.persisted({ ...store, schemaVersion: 2 }))).toContain("Undeclared")
    expect(await refused(Collection.persisted({ ...store, id: "other" }))).toContain("Undeclared")
    expect(await refused(syncedAt(synced, store.id, []))).toContain("Undeclared")
    expect(await refused(syncedAt({ ...synced, schemaVersion: 1 }, synced.id, []))).toContain("Undeclared")
  })

  test("refuses a synced collection made without an id", async () => {
    const registry = Migrations.registry({ stores: [] })
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Collection.make(Note, { getKey: (row: { readonly id: string }) => row.id, sync: source([]) } as never, {
          persist: { schemaVersion: 1 }
        })
      ).pipe(Effect.provide(Persistence.layer({ open: () => sqlite(databaseFile()), make: persistenceFor, registry })))
    )
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain("Undeclared")
  })

  test("is checked when the database couldn't open too, so an undeclared collection fails in memory as on disk", async () => {
    const registry = Migrations.registry({ stores: [] })
    const exit = await Effect.runPromiseExit(
      Effect.scoped(Collection.persisted(notesAt(id("notes"), 1))).pipe(
        Effect.provide(
          Persistence.layer({ open: () => Promise.reject(new Error("no OPFS")), make: persistenceFor, registry })
        ),
        Effect.provide(ownMetrics())
      )
    )
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain("Undeclared")
  })
})

describe("apply", () => {
  test("finds nothing to bring forward in a database the persistence never wrote", async () => {
    const report = await applyOn(databaseFile(), Migrations.registry({ stores: [notesAt("notes", 2)] }))
    expect(report).toEqual({ epoch: 2, collections: [] })
  })

  test("migrates a local collection's rows in place, and the next build opens them at its version", async () => {
    const path = databaseFile()
    const collection = id("notes")
    await writeLocal(path, notesAt(collection, 1), [v1("a", 1), v1("b", 2, "bee")])
    const report = await applyOn(path, Migrations.registry({ stores: [notesAt(collection, 3)] }))
    expect(report.collections).toEqual([
      { collection, store: collection, outcome: "migrated", from: 1, to: 3, migrated: 2, kept: 0, dropped: 0 }
    ])
    expect(await readLocal(path, notesAt(collection, 3))).toEqual([
      { id: "a", body: "a", n: 1, tags: [] },
      { id: "b", body: "bee", n: 2, tags: [] }
    ])
  })

  test("runs again, or from a second program, without doing anything more", async () => {
    const path = databaseFile()
    const collection = id("notes")
    await writeLocal(path, notesAt(collection, 1), [v1("a", 1)])
    const registry = Migrations.registry({ stores: [notesAt(collection, 2)] })
    await applyOn(path, registry)
    const again = await applyOn(path, registry)
    expect(again.collections).toEqual([
      { collection, store: collection, outcome: "current", from: 2, to: 2, migrated: 0, kept: 0, dropped: 0 }
    ])
    expect(await readLocal(path, notesAt(collection, 2))).toEqual([{ id: "a", text: "a", n: 1, tags: [] }])
  })

  test("re-reads the version inside its transaction, so a program that lost the race does nothing", async () => {
    const path = databaseFile()
    const collection = id("notes")
    await writeLocal(path, notesAt(collection, 1), [v1("a", 1)])
    const registry = Migrations.registry({ stores: [notesAt(collection, 2)] })
    // The other program migrates between this one's first read of the registry and its transaction.
    const database = sqlite(path)
    let raced = false
    const racing: Migrations.Sql = {
      execute: (sql, params) =>
        Effect.gen(function*() {
          if (sql === "BEGIN IMMEDIATE" && !raced) {
            raced = true
            yield* Effect.promise(() => applyOn(path, registry))
          }
          return yield* Effect.tryPromise(() => database.execute(sql, params ?? []))
        })
    }
    const report = await Effect.runPromise(
      Migrations.apply(registry, racing).pipe(Effect.ensuring(Effect.sync(() => database.close())))
    )
    expect(report.collections[0]?.outcome).toBe("current")
    expect(await readLocal(path, notesAt(collection, 2))).toEqual([{ id: "a", text: "a", n: 1, tags: [] }])
  })

  test("keeps each row it can't bring forward in device_kept, with why, and migrates the rest", async () => {
    const path = databaseFile()
    const collection = id("notes")
    await writeLocal(path, notesAt(collection, 1), [v1("a", 1), v1("b", -1), v1("c", 3), v1("d", 4), v1("e", 5)])
    // `c`'s text won't decode as version 1's, `d`'s migration throws, `e`'s changes its key.
    const database = sqlite(path)
    const [table] = await database.execute<{ table_name: string }>(
      "SELECT table_name FROM collection_registry WHERE collection_id = ?",
      [collection]
    )
    await database.execute(`UPDATE "${table!.table_name}" SET value = ? WHERE key = ?`, [
      "{\"id\":\"c\",\"n\":3}",
      "s:c"
    ])
    database.close()
    const Throwing = Migrations.step(NoteV1, NoteV2, (row) => {
      if (row.id === "d") throw new Error("boom")
      if (row.id === "e") return { ...row, id: "moved", tags: [] }
      return toV2.migrate(row)
    })
    const store = Migrations.local({
      id: collection,
      versions: [NoteV1, NoteV2],
      migrations: [Throwing],
      getKey: (row) => row.id
    })
    const { logs, result } = await withLogs(
      Migrations.apply(Migrations.registry({ stores: [store] }), Migrations.promiseSql(sqlite(path))).pipe(
        Effect.flatMap((report) =>
          Effect.map(
            Metric.value(Metric.withAttributes(Migrations.rowsKept, { store: collection, reason: "negative" })),
            ({ count }) => ({ report, negative: count })
          )
        ),
        Effect.provide(ownMetrics())
      )
    )
    expect(result.report.collections[0]).toMatchObject({ outcome: "migrated", migrated: 1, kept: 4, dropped: 0 })
    expect(result.negative).toBe(1)
    expect((await keptRows(path)).map(({ key, reason, version }) => [key, reason, version])).toEqual([
      ["s:b", "negative", 1],
      ["s:c", "decode", 1],
      ["s:d", "defect", 1],
      ["s:e", "key", 1]
    ])
    expect(await readLocal(path, store)).toEqual([{ id: "a", text: "a", n: 1, tags: [] }])
    const line = logs.find((log) => (log.message as Array<unknown>)[0] === "device.migrate")!
    expect(line.annotations).toMatchObject({ collection, outcome: "migrated", from: 1, to: 2, migrated: 1, kept: 4 })
    // Rows that no longer show are a failure the device records.
    expect(line.level).toBe("Warn")
    // Never a row's content.
    expect(JSON.stringify(logs)).not.toContain("bee")
  })

  test("keeps a row whose stored value isn't JSON, or whose migration answers a row this build's schema refuses", async () => {
    const path = databaseFile()
    const collection = id("notes")
    await writeLocal(path, notesAt(collection, 1), [v1("a", 1), v1("b", 2)])
    const database = sqlite(path)
    const [table] = await database.execute<{ table_name: string }>(
      "SELECT table_name FROM collection_registry WHERE collection_id = ?",
      [collection]
    )
    await database.execute(`UPDATE "${table!.table_name}" SET value = ? WHERE key = ?`, ["{not json", "s:a"])
    database.close()
    const Invalid = Migrations.step(NoteV1, NoteV2, (row) => ({ ...row }) as never)
    const store = Migrations.local({
      id: collection,
      versions: [NoteV1, NoteV2],
      migrations: [Invalid],
      getKey: (row) => row.id
    })
    const report = await applyOn(path, Migrations.registry({ stores: [store] }))
    expect(report.collections[0]).toMatchObject({ outcome: "migrated", migrated: 0, kept: 2 })
    expect((await keptRows(path)).map(({ reason }) => reason)).toEqual(["unreadable", "invalid"])
    expect(await readLocal(path, store)).toEqual([])
  })

  test("a store that discards deletes and counts the rows that don't migrate instead of keeping them", async () => {
    const path = databaseFile()
    const collection = id("cache")
    await writeLocal(path, notesAt(collection, 1), [v1("a", 1), v1("b", -1)])
    const store = Migrations.local({
      id: collection,
      versions: [NoteV1, NoteV2],
      migrations: [toV2],
      getKey: (row) => row.id,
      discard: true
    })
    const report = await applyOn(path, Migrations.registry({ stores: [store] }))
    expect(report.collections[0]).toMatchObject({ outcome: "migrated", migrated: 1, kept: 0, dropped: 1 })
    expect(await keptRows(path)).toEqual([])
    expect(await readLocal(path, store)).toEqual([{ id: "a", text: "a", n: 1, tags: [] }])
  })

  test("a discarding store without migrations drops every older row", async () => {
    const path = databaseFile()
    const collection = id("cache")
    await writeLocal(path, notesAt(collection, 1), [v1("a", 1)])
    const store = Migrations.local({
      id: collection,
      versions: [NoteV1, NoteV2],
      getKey: (row) => row.id,
      discard: true
    })
    const report = await applyOn(path, Migrations.registry({ stores: [store] }))
    expect(report.collections[0]).toMatchObject({ outcome: "reset", migrated: 0, dropped: 1 })
    expect(await readLocal(path, store)).toEqual([])
  })

  test("a store whose history starts after version 1 migrates from its first declared version and keeps older rows", async () => {
    const path = databaseFile()
    const older = id("homes")
    const declared = id("homes")
    await writeLocal(path, notesAt(older, 1), [v1("a", 1)])
    await writeLocal(path, notesAt(declared, 2), [{ ...v1("b", 2), tags: ["t"] }])
    const later = (collection: string) =>
      Migrations.local({
        id: collection,
        versions: [NoteV2, NoteV3],
        migrations: [toV3],
        getKey: (row) => row.id,
        first: 2
      })
    expect(later(older).schemaVersion).toBe(3)
    const report = await applyOn(path, Migrations.registry({ stores: [later(older), later(declared)] }))
    const outcomes = Object.fromEntries(report.collections.map((entry) => [entry.collection, entry]))
    expect(outcomes[older]).toMatchObject({ outcome: "reset", from: 1, to: 3, kept: 1 })
    expect(outcomes[declared]).toMatchObject({ outcome: "migrated", from: 2, to: 3, migrated: 1 })
    expect((await keptRows(path)).map(({ reason }) => reason)).toEqual(["unknown"])
    expect(await readLocal(path, later(declared))).toEqual([{ id: "b", body: "b", n: 2, tags: ["t"] }])
    const lock = Migrations.lock(Migrations.registry({ stores: [later(declared)] }), undefined).lock
    expect(Object.keys(lock.stores[declared]!.versions)).toEqual(["2", "3"])
  })

  test("sets aside every row of a collection a newer build wrote, and the older build starts it empty", async () => {
    const path = databaseFile()
    const collection = id("notes")
    await writeLocal(path, notesAt(collection, 1), [v1("a", 1)])
    await applyOn(path, Migrations.registry({ stores: [notesAt(collection, 3)] }))
    // A rollback: the build at version 2 opens a store version 3 wrote.
    const report = await applyOn(path, Migrations.registry({ stores: [notesAt(collection, 2)] }))
    expect(report.collections[0]).toMatchObject({ outcome: "reset", from: 3, to: 2, kept: 1, migrated: 0 })
    expect((await keptRows(path)).map(({ reason, version }) => [reason, version])).toEqual([["newer", 3]])
    expect(await readLocal(path, notesAt(collection, 2))).toEqual([])
  })

  test("sets aside the rows of a version with no history, as stored at 0", async () => {
    const path = databaseFile()
    const collection = id("notes")
    await writeLocal(path, notesAt(collection, 1), [v1("a", 1)])
    const database = sqlite(path)
    await database.execute("UPDATE collection_registry SET schema_version = 0 WHERE collection_id = ?", [collection])
    database.close()
    const report = await applyOn(path, Migrations.registry({ stores: [notesAt(collection, 2)] }))
    expect(report.collections[0]).toMatchObject({ outcome: "reset", from: 0, kept: 1 })
    expect((await keptRows(path)).map(({ reason }) => reason)).toEqual(["unknown"])
  })

  test("writes back every value the persistence stores, as it stored it: bigints, dates, non-finite numbers, tags", async () => {
    const Rich = Schema.Struct({
      id: Schema.String,
      big: Schema.BigInt,
      at: Schema.Date,
      lost: Schema.NullOr(Schema.Date),
      nan: Schema.Number,
      inf: Schema.Number,
      ninf: Schema.Number,
      list: Schema.Array(Schema.Number),
      nested: Schema.Struct({ __tanstack_db_persisted_type__: Schema.String, value: Schema.String })
    })
    const RichV2 = Schema.Struct({ ...Rich.fields, seen: Schema.Boolean, gone: Schema.optional(Schema.String) })
    const path = databaseFile()
    const collection = id("rich")
    const v1Store = Migrations.local({ id: collection, versions: [Rich], getKey: (row) => row.id })
    const v2Store = Migrations.local({
      id: collection,
      versions: [Rich, RichV2],
      migrations: [Migrations.step(Rich, RichV2, (row) => ({ ...row, seen: false, gone: undefined }))],
      getKey: (row) => row.id
    })
    const row = {
      id: "r",
      big: 9007199254740993n,
      at: new Date("2026-10-20T12:00:00.000Z"),
      lost: new Date("2026-10-20T12:00:00.000Z"),
      nan: Number.NaN,
      inf: Number.POSITIVE_INFINITY,
      ninf: Number.NEGATIVE_INFINITY,
      list: [1, -0.5],
      nested: { __tanstack_db_persisted_type__: "a row's own field", value: "kept" }
    }
    await writeLocal(path, v1Store as never, [row])
    // A date the persistence can't parse reads as null, as the persistence reads it.
    const database = sqlite(path)
    const [table] = await database.execute<{ table_name: string }>(
      "SELECT table_name FROM collection_registry WHERE collection_id = ?",
      [collection]
    )
    const [stored] = await database.execute<{ value: string }>(`SELECT value FROM "${table!.table_name}"`)
    const value = JSON.parse(stored!.value)
    value.lost = { __tanstack_db_persisted_type__: "date", value: "not a date" }
    await database.execute(`UPDATE "${table!.table_name}" SET value = ?`, [JSON.stringify(value)])
    database.close()
    expect((await applyOn(path, Migrations.registry({ stores: [v2Store] }))).collections[0]).toMatchObject({
      outcome: "migrated",
      migrated: 1
    })
    expect(await readLocal(path, v2Store as never)).toEqual([{ ...row, lost: null, seen: false }])
  })

  test("keeps a numeric key as the persistence wrote it", async () => {
    const path = databaseFile()
    const collection = id("numbered")
    const byNumber = (version: 1 | 2) =>
      version === 1
        ? Migrations.local({ id: collection, versions: [NoteV1], getKey: (row) => row.n })
        : Migrations.local({ id: collection, versions: [NoteV1, NoteV2], migrations: [toV2], getKey: (row) => row.n })
    await writeLocal(path, byNumber(1) as never, [v1("a", 1), v1("b", 2.5)])
    expect((await applyOn(path, Migrations.registry({ stores: [byNumber(2)] }))).collections[0]).toMatchObject({
      migrated: 2,
      kept: 0
    })
    expect(await readLocal(path, byNumber(2) as never)).toEqual([
      { id: "a", text: "a", n: 1, tags: [] },
      { id: "b", text: "b", n: 2.5, tags: [] }
    ])
  })

  test("keeps a row holding a value tagged with a type this build can't write back", async () => {
    const path = databaseFile()
    const collection = id("notes")
    await writeLocal(path, notesAt(collection, 1), [v1("a", 1)])
    const database = sqlite(path)
    const [table] = await database.execute<{ table_name: string }>(
      "SELECT table_name FROM collection_registry WHERE collection_id = ?",
      [collection]
    )
    await database.execute(`UPDATE "${table!.table_name}" SET value = ?`, [
      JSON.stringify({ id: "a", text: { __tanstack_db_persisted_type__: "Temporal.Instant", value: "x" }, n: 1 })
    ])
    database.close()
    const report = await applyOn(path, Migrations.registry({ stores: [notesAt(collection, 2)] }))
    expect(report.collections[0]).toMatchObject({ migrated: 0, kept: 1 })
    expect((await keptRows(path)).map(({ reason }) => reason)).toEqual(["unreadable"])
  })

  test("migrates a collection whose row versions the persistence never recorded", async () => {
    const path = databaseFile()
    const collection = id("notes")
    await writeLocal(path, notesAt(collection, 1), [v1("a", 1)])
    const database = sqlite(path)
    await database.execute("DELETE FROM collection_version WHERE collection_id = ?", [collection])
    database.close()
    expect((await applyOn(path, Migrations.registry({ stores: [notesAt(collection, 2)] }))).collections[0])
      .toMatchObject({ outcome: "migrated", migrated: 1 })
  })

  test("migrates an empty collection by recording its version alone", async () => {
    const path = databaseFile()
    const collection = id("notes")
    await writeLocal(path, notesAt(collection, 1), [])
    const report = await applyOn(path, Migrations.registry({ stores: [notesAt(collection, 2)] }))
    expect(report.collections[0]).toMatchObject({ outcome: "migrated", migrated: 0 })
    expect(await readLocal(path, notesAt(collection, 2))).toEqual([])
  })

  test("leaves a synced collection at another version to the persistence, which drops its rows and syncs again", async () => {
    const path = databaseFile()
    const collection = id("synced")
    const old = Migrations.synced({ id: collection, version: 1, schema: NoteV1 })
    const next = Migrations.synced({ id: collection, version: 2, schema: NoteV2 })
    await program(
      path,
      Effect.gen(function*() {
        yield* (yield* syncedAt(old, collection, [v1("a", 1), v1("b", 2)])).preload
      })
    )
    const report = await applyOn(path, Migrations.registry({ stores: [next] }))
    expect(report.collections).toEqual([
      { collection, store: collection, outcome: "resync", from: 1, to: 2, migrated: 0, kept: 0, dropped: 0 }
    ])
    const rows = await program(
      path,
      Effect.gen(function*() {
        const synced = yield* syncedAt(next, collection, [{ id: "c", text: "c", n: 3, tags: ["x"] }])
        yield* synced.preload
        return (yield* synced.toArray).map(plain)
      })
    )
    expect(rows).toEqual([{ id: "c", text: "c", n: 3, tags: ["x"] }])
  })

  test("sets aside a retired local collection's rows, and leaves a retired synced one and an undeclared one as they are", async () => {
    const path = databaseFile()
    const local = id("drafts")
    const syncedId = id("views")
    const other = id("newer")
    await writeLocal(path, notesAt(local, 1), [v1("a", 1), v1("b", 2)])
    await writeLocal(path, notesAt(other, 1), [v1("z", 1)])
    await program(
      path,
      Effect.gen(function*() {
        yield* (yield* syncedAt(Migrations.synced({ id: syncedId, version: 1, schema: NoteV1 }), syncedId, [
          v1("v", 1)
        ]))
          .preload
      })
    )
    const registry = Migrations.registry({
      stores: [],
      retired: [
        Migrations.retired({ id: local, kind: "local", version: 1 }),
        Migrations.retired({ id: syncedId, kind: "synced", version: 1 })
      ]
    })
    const report = await applyOn(path, registry)
    const byCollection = Object.fromEntries(report.collections.map((entry) => [entry.collection, entry]))
    expect(byCollection[local]).toMatchObject({ outcome: "retired", store: local, to: null, kept: 2 })
    expect(byCollection[syncedId]).toMatchObject({ outcome: "retired", kept: 0 })
    expect(byCollection[other]).toMatchObject({ outcome: "skipped", store: null, to: null })
    expect((await keptRows(path)).map(({ collection_id, reason }) => [collection_id, reason])).toEqual([
      [local, "retired"],
      [local, "retired"]
    ])
    expect(await readLocal(path, notesAt(other, 1))).toEqual([v1("z", 1)])
    // Retiring again finds nothing more.
    const again = await applyOn(path, registry)
    expect(again.collections.find((entry) => entry.collection === local)).toMatchObject({ kept: 0 })
  })

  test("counts each collection's outcome by store and records the run's time", async () => {
    const path = databaseFile()
    const collection = id("notes")
    await writeLocal(path, notesAt(collection, 1), [v1("a", 1)])
    const { counted, timed } = await Effect.runPromise(
      Effect.gen(function*() {
        const database = sqlite(path)
        yield* Migrations.apply(
          Migrations.registry({ stores: [notesAt(collection, 2)] }),
          Migrations.promiseSql(database)
        )
        database.close()
        return {
          counted: (yield* Metric.value(
            Metric.withAttributes(Migrations.migrations, { store: collection, outcome: "migrated" })
          )).count,
          timed: (yield* Metric.value(Migrations.applyMs)).count
        }
      }).pipe(Effect.provide(ownMetrics()))
    )
    expect(counted).toBe(1)
    expect(timed).toBe(1)
  })

  test("a statement that fails mid-migration rolls the collection back, and the next run brings it forward", async () => {
    const path = databaseFile()
    const collection = id("notes")
    await writeLocal(path, notesAt(collection, 1), [v1("a", 1), v1("b", 2), v1("c", 3)])
    const registry = Migrations.registry({ stores: [notesAt(collection, 2)] })
    const database = sqlite(path)
    let updates = 0
    const failing: Migrations.Sql = {
      execute: (sql, params) =>
        sql.startsWith("UPDATE") && ++updates === 2
          ? Effect.fail(new Error("disk full"))
          : Effect.tryPromise(() => database.execute(sql, params ?? []))
    }
    const exit = await Effect.runPromiseExit(Migrations.apply(registry, failing).pipe(Effect.provide(ownMetrics())))
    database.close()
    expect(Exit.isFailure(exit) && Option.getOrUndefined(Exit.findErrorOption(exit))).toMatchObject({
      _tag: "MigrationFailed",
      collection
    })
    // Nothing of the failed run stood: the collection is still version 1's.
    expect(await readLocal(path, notesAt(collection, 1))).toEqual([v1("a", 1), v1("b", 2), v1("c", 3)])
    expect((await applyOn(path, registry)).collections[0]).toMatchObject({ outcome: "migrated", migrated: 3 })
    expect(await readLocal(path, notesAt(collection, 2))).toEqual([
      { id: "a", text: "a", n: 1, tags: [] },
      { id: "b", text: "b", n: 2, tags: [] },
      { id: "c", text: "c", n: 3, tags: [] }
    ])
  })

  test("a program that dies mid-migration leaves the collection as it was, and the next one resumes", async () => {
    const path = databaseFile()
    const collection = id("notes")
    await writeLocal(path, notesAt(collection, 1), [v1("a", 1), v1("b", 2)])
    const registry = Migrations.registry({ stores: [notesAt(collection, 2)] })
    // The program's connection closes after the first row's update, inside the transaction, as a tab that closes does.
    const database = sqlite(path)
    const dying: Migrations.Sql = {
      execute: (sql, params) =>
        Effect.gen(function*() {
          const rows = yield* Effect.tryPromise(() => database.execute(sql, params ?? []))
          if (sql.startsWith("UPDATE")) {
            database.close()
            return yield* Effect.die(new Error("the tab closed"))
          }
          return rows
        })
    }
    const exit = await Effect.runPromiseExit(Migrations.apply(registry, dying).pipe(Effect.provide(ownMetrics())))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(await readLocal(path, notesAt(collection, 1))).toEqual([v1("a", 1), v1("b", 2)])
    expect((await applyOn(path, registry)).collections[0]).toMatchObject({ outcome: "migrated", migrated: 2 })
  })

  test("a registry that can't be read fails with MigrationFailed", async () => {
    const exit = await Effect.runPromiseExit(
      Migrations.apply(Migrations.registry({ stores: [] }), { execute: () => Effect.fail(new Error("locked")) })
    )
    expect(Option.getOrUndefined(Exit.findErrorOption(exit))).toMatchObject({
      _tag: "MigrationFailed",
      collection: "collection_registry"
    })
  })

  test("prepare is apply over a host's database, with the registry's epoch and the report's schema", async () => {
    const path = databaseFile()
    const collection = id("notes")
    await writeLocal(path, notesAt(collection, 1), [v1("a", 1)])
    const prepared = Migrations.prepare(Migrations.registry({ stores: [notesAt(collection, 2)] }))
    expect(prepared.epoch).toBe(2)
    expect(prepared.success).toBe(Migrations.Report)
    const database = sqlite(path)
    const report = await Effect.runPromise(
      prepared.run(Migrations.promiseSql(database)).pipe(Effect.provide(ownMetrics()))
    )
    database.close()
    expect(Schema.is(Migrations.Report)(report)).toBe(true)
    expect(report.collections[0]?.outcome).toBe("migrated")
  })
})

describe("migrating then syncing again", () => {
  // Rows with ids unique within each list.
  const unique = <A extends { readonly id: string }>(rows: ReadonlyArray<A>) => [
    ...new Map(rows.map((row) => [row.id, row])).values()
  ]
  // SQLite keeps text as UTF-8, which has no lone surrogate: a device never stores one, so rows are well formed.
  const wellFormed = (row: object) =>
    Object.values(row).every((value) => typeof value !== "string" || !/[\uD800-\uDFFF]/.test(value))
  const rows = <A extends { readonly id: string }>(schema: Schema.Codec<A, A>) =>
    Arbitrary.map(Arbitrary.array(Arbitrary.filter(Arbitrary.schema(schema), wellFormed), { maxLength: 6 }), unique)
  const Device = Arbitrary.all({ local: rows(NoteV1), cached: rows(NoteV1), server: rows(NoteV2) })
  const byId = (rows: ReadonlyArray<object>) =>
    rows.map(plain).sort((a: any, b: any) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  test("leaves a device equal to a new one that synced fresh, with its own local rows migrated", async () => {
    const result = await Effect.runPromise(
      Arbitrary.checkEffect(
        Device,
        ({ cached, local, server }) =>
          Effect.promise(async () => {
            const notes = id("notes")
            const synced = id("synced")
            const old = Migrations.synced({ id: synced, version: 1, schema: NoteV1 })
            const next = Migrations.synced({ id: synced, version: 2, schema: NoteV2 })
            const registry = Migrations.registry({ stores: [notesAt(notes, 2), next] })
            const open = (path: string) =>
              program(
                path,
                Effect.gen(function*() {
                  const rows = yield* syncedAt(next, synced, server as ReadonlyArray<NoteV2>)
                  yield* rows.preload
                  const kept = yield* Collection.persisted(notesAt(notes, 2))
                  yield* kept.restored
                  return { synced: byId(yield* rows.toArray), local: byId(yield* kept.toArray) }
                }),
                registry
              )
            // The device the old build left: its local rows, and the server's rows as they were then.
            const upgraded = databaseFile()
            await writeLocal(upgraded, notesAt(notes, 1), local)
            await program(
              upgraded,
              Effect.gen(function*() {
                yield* (yield* syncedAt(old, synced, cached)).preload
              })
            )
            await applyOn(upgraded, registry)
            const after = await open(upgraded)
            const fresh = await open(databaseFile())
            const migrated = byId(
              local.flatMap((row) => {
                const next = toV2.migrate(row)
                return next instanceof Migrations.Unmigratable ? [] : [next]
              })
            )
            return JSON.stringify(after.synced) === JSON.stringify(fresh.synced) &&
              JSON.stringify(after.synced) === JSON.stringify(byId(server)) &&
              JSON.stringify(after.local) === JSON.stringify(migrated) &&
              fresh.local.length === 0
          }),
        { runs: 20, seed: 20261020 }
      )
    )
    expect(Arbitrary.formatCheckFailure(result)).toBeUndefined()
  }, 120_000)
})
