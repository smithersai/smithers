import { createCollection, createLiveQueryCollection, createTransaction } from "@tanstack/db"
import type { StorageApi } from "@tanstack/db"
import { Database } from "bun:sqlite"
import { describe, expect, spyOn, test } from "bun:test"
import { z } from "zod"
import { createCollectionPersistence, durableCollectionOptions } from "./DurableCollection"
import { openSqliteRowStorage, ROW_TABLE_NAME, type SqliteRowDatabase } from "./SqliteRowStorage"
import { ENVELOPE_STORAGE_KEY, openTransactionalStorage } from "./TransactionalStorage"

const Widget = z.object({ id: z.string(), label: z.string() })
const spec = { id: "widgets", schema: Widget, getKey: (row: z.infer<typeof Widget>) => row.id }

const fixture = async () => {
  const values = new Map<string, string>()
  let failing = false
  const host = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failing && key === ENVELOPE_STORAGE_KEY) throw new Error("commit refused")
      values.set(key, value)
    },
    removeItem: (key: string) => { values.delete(key) }
  }
  const storage = await openTransactionalStorage(host, { collections: [spec] })
  const persistence = createCollectionPersistence({ storage: storage.storage, batch: storage })
  const collection = createCollection(durableCollectionOptions(persistence, spec))
  await collection.preload()
  return { collection, storage, persistence, host, fail: () => { failing = true }, heal: () => { failing = false } }
}

const observedFixture = async (initialRows: Array<z.infer<typeof Widget>>) => {
  const app = await fixture()
  await app.collection.insert(initialRows).isPersisted.promise
  const query = createLiveQueryCollection({ query: (q) => q.from({ row: app.collection }).fn.select(({ row }) => row) })
  const subscription = query.subscribeChanges(() => {})
  await query.preload()
  const rows = () => [...query.values()].map(({ id, label }) => ({ id, label })).sort((a, b) => a.id.localeCompare(b.id))
  const durableRows = async () => {
    const reopened = await openTransactionalStorage(app.host, { collections: [spec] })
    const stored = JSON.parse(reopened.storage.getItem("smithers-mvp.widgets")!) as Record<string, { data: z.infer<typeof Widget> }>
    return Object.values(stored).map(({ data }) => data).sort((a, b) => a.id.localeCompare(b.id))
  }
  const pending = (mutate: () => void) => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const transaction = createTransaction({ mutationFn: async ({ transaction }) => {
      await gate
      await app.persistence.persist(transaction)
      app.collection.utils.acceptMutations(transaction)
    } })
    transaction.mutate(mutate)
    return {
      release,
      persisted: transaction.isPersisted.promise,
      confirm: async () => { release(); await transaction.isPersisted.promise }
    }
  }
  return {
    ...app,
    query,
    rows,
    durableRows,
    pending,
    dispose: async () => { subscription.unsubscribe(); await query.cleanup(); await app.collection.cleanup() }
  }
}

const PADDING = "x".repeat(1000)

const normalizedFixture = async () => {
  const sqlite = new Database(":memory:")
  const executed: Array<{ readonly sql: string; readonly params: ReadonlyArray<unknown> }> = []
  const database: SqliteRowDatabase = {
    execute: async <TRow>(sql: string, params: ReadonlyArray<unknown> = []) => {
      executed.push({ sql, params })
      const statement = sqlite.query(sql)
      if (/^\s*(?:SELECT|PRAGMA)/i.test(sql)) return statement.all(...params as []) as ReadonlyArray<TRow>
      statement.run(...params as [])
      return []
    },
    close: () => sqlite.close()
  }
  const host = await openSqliteRowStorage(database, { collections: [{ id: spec.id, schema: Widget }], schemaVersion: 1 })
  return { sqlite, host, executed }
}

// Count both the compatibility envelope traffic and JSON parsing during commits.
const appendToNormalizedHost = async (retained: number) => {
  const { sqlite, host, executed } = await normalizedFixture()
  host.storage.setItem("smithers-mvp.widgets", JSON.stringify(Object.fromEntries(
    Array.from({ length: retained }, (_, index) => [`s:${index}`, { versionKey: `v${index}`, data: { id: String(index), label: PADDING } }])
  )))
  await host.flush()

  let collectionChars = 0
  const measured: StorageApi = {
    getItem: (key) => {
      const value = host.storage.getItem(key)
      if (key === "smithers-mvp.widgets") collectionChars += value?.length ?? 0
      return value
    },
    setItem: (key, value) => {
      if (key === "smithers-mvp.widgets") collectionChars += value.length
      host.storage.setItem(key, value)
    },
    removeItem: (key) => { host.storage.removeItem(key) }
  }
  const persistence = createCollectionPersistence({ storage: measured, batch: host, flush: host.flush, rows: host })
  persistence.register(spec.id)
  collectionChars = 0
  executed.length = 0

  const appended = Array.from({ length: 5 }, (_, index) => ({ id: `appended-${index}`, label: `label-${index}` }))
  const expectedWrites: Array<{ rowKey: string; data: z.infer<typeof Widget> }> = []
  let original = { id: "0", label: PADDING }
  let parseCalls = 0
  let parsedChars = 0
  const parse = JSON.parse
  const probe = spyOn(JSON, "parse").mockImplementation((...args: Parameters<typeof JSON.parse>) => {
    parseCalls += 1
    parsedChars += args[0].length
    return parse(...args)
  })
  try {
    for (const row of appended) {
      const modified = { id: "0", label: row.label }
      await persistence.persist({
        mutations: [
          { collection: { id: spec.id }, key: row.id, type: "insert", original: undefined, modified: row },
          { collection: { id: spec.id }, key: "0", type: "update", original, modified }
        ]
      })
      expectedWrites.push({ rowKey: `s:${row.id}`, data: row }, { rowKey: "s:0", data: modified })
      original = modified
    }
    await host.flush()
  } finally {
    probe.mockRestore()
  }
  const stored = sqlite.query(`SELECT row_key, value FROM ${ROW_TABLE_NAME} ORDER BY row_key`).all() as Array<{ row_key: string; value: string }>
  await host.close()
  return {
    appended,
    collectionChars,
    parseCalls,
    parsedChars,
    expectedWrites,
    statements: executed.length,
    rowWrites: executed
      .filter((entry) => entry.sql.includes(`INSERT INTO ${ROW_TABLE_NAME}`))
      .map((entry) => ({ rowKey: entry.params[1], data: JSON.parse(String(entry.params[3])) as unknown })),
    storedCount: stored.length,
    appendedRows: stored.filter((row) => row.row_key.startsWith("s:appended-")).map((row) => JSON.parse(row.value) as unknown)
  }
}

describe("durable persistence against a normalized row host", () => {
  test("an append writes only its own row, and its cost does not grow with retained history", async () => {
    const small = await appendToNormalizedHost(40)
    const large = await appendToNormalizedHost(400)

    // No collection envelope is read or rewritten, at either retained size.
    expect(small.collectionChars).toBe(0)
    expect(large.collectionChars).toBe(0)
    // Parsing is bounded by changed rows, regardless of retained history.
    expect(large.parseCalls).toBe(small.parseCalls)
    expect(large.parsedChars).toBe(small.parsedChars)
    expect(large.parsedChars).toBeLessThan(10_000)
    // One BEGIN, two row upserts and one COMMIT per append, at either size.
    expect(small.statements).toBe(20)
    expect(large.statements).toBe(small.statements)

    expect(small.rowWrites).toEqual(small.expectedWrites)
    expect(large.rowWrites).toEqual(large.expectedWrites)
    expect(small.storedCount).toBe(45)
    expect(large.storedCount).toBe(405)
    expect(large.appendedRows).toEqual(large.appended)
  })
  test("row deltas update and delete historical unprefixed SQLite keys", async () => {
    const { sqlite, host } = await normalizedFixture()
    host.storage.setItem("smithers-mvp.widgets", JSON.stringify({
      one: { versionKey: "legacy", data: { id: "one", label: "old" } },
      two: { versionKey: "legacy", data: { id: "two", label: "removed" } }
    }))
    await host.flush()
    const persistence = createCollectionPersistence({ storage: host.storage, batch: host, flush: host.flush, rows: host })
    const collection = createCollection(durableCollectionOptions(persistence, spec))
    await collection.preload()
    await collection.update("one", (draft) => { draft.label = "updated" }).isPersisted.promise
    await collection.delete("two").isPersisted.promise
    expect(sqlite.query(`SELECT row_key, value FROM ${ROW_TABLE_NAME}`).all()).toEqual([
      { row_key: "s:one", value: JSON.stringify({ id: "one", label: "updated" }) }
    ])
    await collection.cleanup()
    await host.close()
  })

  test("SQLite rollback rejects queued deltas and restores optimistic rows", async () => {
    const { sqlite, host, executed } = await normalizedFixture()
    const persistence = createCollectionPersistence({ storage: host.storage, batch: host, flush: host.flush, rows: host })
    const collection = createCollection(durableCollectionOptions(persistence, spec))
    await collection.preload()
    await collection.insert({ id: "one", label: "before" }).isPersisted.promise
    sqlite.run(`CREATE TRIGGER refuse_insert BEFORE INSERT ON ${ROW_TABLE_NAME}
      WHEN NEW.row_key = 's:refused' BEGIN SELECT RAISE(ABORT, 'refused'); END`)
    const first = createTransaction({ mutationFn: async ({ transaction }) => {
      await persistence.persist(transaction)
      collection.utils.acceptMutations(transaction)
    } })
    first.mutate(() => {
      collection.delete("one")
      collection.insert({ id: "refused", label: "bad" })
    })
    const second = collection.insert({ id: "queued", label: "never written" })
    const results = await Promise.allSettled([first.isPersisted.promise, second.isPersisted.promise])
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"])
    expect([...collection.values()].map(({ id, label }) => ({ id, label }))).toEqual([{ id: "one", label: "before" }])
    expect(sqlite.query(`SELECT row_key, value FROM ${ROW_TABLE_NAME}`).all()).toEqual([
      { row_key: "s:one", value: JSON.stringify({ id: "one", label: "before" }) }
    ])
    expect(executed.some(({ params }) => params[1] === "s:queued")).toBe(false)
    await collection.cleanup()
    await expect(host.close()).rejects.toThrow("refused")
  })

  test("a rejected row batch rewinds the coordinator before a fresh retry", async () => {
    const { sqlite, host } = await normalizedFixture()
    let refuse = false
    const persistence = createCollectionPersistence({
      storage: host.storage, batch: host, flush: host.flush,
      rows: { applyRows: (id, deltas) => {
        host.applyRows(id, deltas)
        if (refuse) throw new Error("batch refused")
      } }
    })
    persistence.register(spec.id)
    const original = { id: "one", label: "before" }
    await persistence.persist({ mutations: [{ collection: spec, key: original.id, type: "insert", original: undefined, modified: original }] })
    refuse = true
    await expect(persistence.persist({ mutations: [
      { collection: spec, key: original.id, type: "delete", original, modified: undefined },
      { collection: spec, key: "two", type: "insert", original: undefined, modified: { id: "two", label: "new" } }
    ] })).rejects.toThrow("batch refused")
    refuse = false
    await persistence.persist({ mutations: [{ collection: spec, key: original.id, type: "update", original, modified: { ...original, label: "fresh" } }] })
    expect(sqlite.query(`SELECT row_key, value FROM ${ROW_TABLE_NAME}`).all()).toEqual([
      { row_key: "s:one", value: JSON.stringify({ id: "one", label: "fresh" }) }
    ])
    await persistence.persist({ mutations: [{ collection: spec, key: original.id, type: "delete", original: { ...original, label: "fresh" }, modified: undefined }] })
    expect(sqlite.query(`SELECT row_key FROM ${ROW_TABLE_NAME}`).all()).toEqual([])
    await host.close()
  })
})

describe("durable local-only collection adapter", () => {
  test("rows adopted from the historical unprefixed-key layout remain editable", async () => {
    const app = await fixture()
    app.storage.storage.setItem("smithers-mvp.widgets", JSON.stringify({ one: { versionKey: "legacy", data: { id: "one", label: "old" } } }))
    const collection = createCollection(durableCollectionOptions(app.persistence, spec))
    await collection.preload()
    await collection.update("one", (draft) => { draft.label = "updated" }).isPersisted.promise
    expect(JSON.parse(app.storage.storage.getItem("smithers-mvp.widgets")!)).toMatchObject({ "s:one": { data: { id: "one", label: "updated" } } })
  })
  test("direct inserts, updates and deletes confirm only after successful persistence", async () => {
    const app = await fixture()
    await app.collection.insert({ id: "one", label: "before" }).isPersisted.promise
    app.fail()
    await expect(app.collection.update("one", (draft) => { draft.label = "failed" }).isPersisted.promise).rejects.toThrow("commit refused")
    expect(app.collection.get("one")?.label).toBe("before")
    await expect(app.collection.delete("one").isPersisted.promise).rejects.toThrow("commit refused")
    expect(app.collection.get("one")?.label).toBe("before")
    app.heal()
    await app.collection.insert({ id: "two", label: "kept" }).isPersisted.promise
    const reopened = await openTransactionalStorage(app.host, { collections: [spec] })
    const rows = JSON.parse(reopened.storage.getItem("smithers-mvp.widgets")!)
    expect(rows["s:one"].data.label).toBe("before")
    expect(rows["s:two"].data.label).toBe("kept")
    await app.collection.delete("one").isPersisted.promise
    expect(JSON.parse(app.storage.storage.getItem("smithers-mvp.widgets")!)["s:one"]).toBeUndefined()
  })

  test("a query subscribed during pending persistence retains stable local metadata through settlement and another update", async () => {
    const app = await fixture()
    await app.collection.insert({ id: "one", label: "before" }).isPersisted.promise
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const blocked = new Promise<void>((resolve) => { entered = resolve })
    let pause = true
    const persistence = createCollectionPersistence({
      storage: app.storage.storage,
      batch: app.storage,
      flush: async () => {
        if (pause) { pause = false; entered(); await gate }
      }
    })
    const widgets = createCollection(durableCollectionOptions(persistence, spec))
    await widgets.preload()
    const first = widgets.update("one", (draft) => { draft.label = "pending" })
    await blocked
    const query = createLiveQueryCollection({
      query: (q) => q.from({ widgets }).select(({ widgets }) => ({ id: widgets.id, label: widgets.label, synced: widgets.$synced, origin: widgets.$origin }))
    })
    const subscription = query.subscribeChanges(() => {})
    await query.preload()
    const projection = () => [...query.values()].map(({ id, label, synced, origin }) => ({ id, label, synced, origin }))
    expect(projection()).toEqual([{ id: "one", label: "pending", synced: true, origin: "local" }])
    release()
    await first.isPersisted.promise
    await widgets.update("one", (draft) => { draft.label = "next" }).isPersisted.promise
    expect(projection()).toEqual([{ id: "one", label: "next", synced: true, origin: "local" }])
    subscription.unsubscribe()
    await query.cleanup()
  })

  test("queued transitions derived from a failed optimistic state reject before writing", async () => {
    const app = await fixture()
    await app.collection.insert({ id: "one", label: "before" }).isPersisted.promise
    const mutate = (label: string) => {
      const transaction = createTransaction({ mutationFn: async ({ transaction }) => {
        await app.persistence.persist(transaction)
        app.collection.utils.acceptMutations(transaction)
      } })
      transaction.mutate(() => app.collection.update("one", (draft) => { draft.label = label }))
      return transaction.isPersisted.promise
    }
    app.fail()
    const results = await Promise.allSettled([mutate("failed-first"), mutate("failed-dependent")])
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"])
    expect(app.collection.get("one")?.label).toBe("before")
    app.heal()
    await mutate("fresh")
    expect(app.collection.get("one")?.label).toBe("fresh")
    expect(JSON.parse(app.storage.storage.getItem("smithers-mvp.widgets")!)["s:one"].data.label).toBe("fresh")
  })

  test("overlapping confirmations preserve the latest query row after an unrelated transaction settles", async () => {
    const app = await fixture()
    await app.collection.insert([{ id: "one", label: "A" }, { id: "aux", label: "A" }]).isPersisted.promise
    const query = createLiveQueryCollection({
      query: (q) => q.from({ row: app.collection }).fn.select(({ row }) => row)
    })
    const subscription = query.subscribeChanges(() => {})
    await query.preload()
    const update = (label: string, key = "one") => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      const transaction = createTransaction({ mutationFn: async ({ transaction }) => {
        await gate
        await app.persistence.persist(transaction)
        app.collection.utils.acceptMutations(transaction)
      } })
      transaction.mutate(() => app.collection.update(key, (draft) => { draft.label = label }))
      return async () => { release(); await transaction.isPersisted.promise }
    }
    const labels = () => [...query.values()].map(({ id, label }) => ({ id, label })).sort((a, b) => a.id.localeCompare(b.id))
    try {
      const b = update("B")
      const c = update("C")
      await b()
      const d = update("D")
      const auxiliary = update("Z", "aux")
      await c()
      await d()
      await auxiliary()
      expect(labels()).toEqual([{ id: "aux", label: "Z" }, { id: "one", label: "D" }])
      await update("E")()
      expect(labels()).toEqual([{ id: "aux", label: "Z" }, { id: "one", label: "E" }])
      const reopened = await openTransactionalStorage(app.host, { collections: [spec] })
      const rows = JSON.parse(reopened.storage.getItem("smithers-mvp.widgets")!)
      expect(rows["s:one"].data.label).toBe("E")
      expect(rows["s:aux"].data.label).toBe("Z")
    } finally {
      subscription.unsubscribe()
      await query.cleanup()
    }
  })

  test("confirmed inserts, updates and deletes preserve a newer optimistic replacement", async () => {
    const app = await observedFixture([{ id: "aux", label: "A" }])
    try {
      const inserted = app.pending(() => app.collection.insert({ id: "one", label: "B" }))
      const updated = app.pending(() => app.collection.update("one", (draft) => { draft.label = "C" }))
      await inserted.confirm()
      expect(app.query.get("one")?.label).toBe("C")
      const deleted = app.pending(() => app.collection.delete("one"))
      await updated.confirm()
      expect(app.query.has("one")).toBe(false)
      const replaced = app.pending(() => app.collection.insert({ id: "one", label: "D" }))
      const auxiliary = app.pending(() => app.collection.update("aux", (draft) => { draft.label = "Z" }))
      await deleted.confirm()
      expect(app.query.get("one")?.label).toBe("D")
      await replaced.confirm()
      await auxiliary.confirm()
      await app.pending(() => app.collection.update("one", (draft) => { draft.label = "E" })).confirm()
      expect(app.rows()).toEqual([{ id: "aux", label: "Z" }, { id: "one", label: "E" }])
      expect(await app.durableRows()).toEqual(app.rows())
    } finally {
      await app.dispose()
    }
  })

  test("a failed deletion rejects its replacement and restores the last confirmed row", async () => {
    const app = await observedFixture([{ id: "one", label: "A" }, { id: "aux", label: "A" }])
    try {
      const durable = app.pending(() => app.collection.update("one", (draft) => { draft.label = "B" }))
      const deleted = app.pending(() => app.collection.delete("one"))
      await durable.confirm()
      expect(app.query.has("one")).toBe(false)
      const replacement = app.pending(() => app.collection.insert({ id: "one", label: "D" }))
      const auxiliary = app.pending(() => app.collection.update("aux", (draft) => { draft.label = "Z" }))
      app.fail()
      const settled = Promise.allSettled([deleted.persisted, replacement.persisted, auxiliary.persisted])
      deleted.release()
      replacement.release()
      auxiliary.release()
      expect((await settled).map((result) => result.status)).toEqual(["rejected", "rejected", "rejected"])
      expect(app.rows()).toEqual([{ id: "aux", label: "A" }, { id: "one", label: "B" }])
      app.heal()
      expect(await app.durableRows()).toEqual(app.rows())
      await app.pending(() => app.collection.update("one", (draft) => { draft.label = "E" })).confirm()
      expect(app.rows()).toEqual([{ id: "aux", label: "A" }, { id: "one", label: "E" }])
      expect(await app.durableRows()).toEqual(app.rows())
    } finally {
      await app.dispose()
    }
  })

  test("a failed insertion and its queued update and delete restore absence before a fresh insert", async () => {
    const app = await observedFixture([{ id: "aux", label: "A" }])
    try {
      const inserted = app.pending(() => app.collection.insert({ id: "one", label: "B" }))
      const updated = app.pending(() => app.collection.update("one", (draft) => { draft.label = "C" }))
      const deleted = app.pending(() => app.collection.delete("one"))
      app.fail()
      const settled = Promise.allSettled([inserted.persisted, updated.persisted, deleted.persisted])
      inserted.release()
      updated.release()
      deleted.release()
      expect((await settled).map((result) => result.status)).toEqual(["rejected", "rejected", "rejected"])
      expect(app.rows()).toEqual([{ id: "aux", label: "A" }])
      app.heal()
      expect(await app.durableRows()).toEqual(app.rows())
      await app.pending(() => app.collection.insert({ id: "one", label: "E" })).confirm()
      expect(app.rows()).toEqual([{ id: "aux", label: "A" }, { id: "one", label: "E" }])
      expect(await app.durableRows()).toEqual(app.rows())
    } finally {
      await app.dispose()
    }
  })
})
