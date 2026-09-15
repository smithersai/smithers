import type { StorageApi } from "@tanstack/db"
import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { APP_SCHEMA_VERSION } from "../chain/SchemaVersion"
import { openSqliteRowStorage, type SqliteRowDatabase } from "../chain/SqliteRowStorage"
import { ENVELOPE_STORAGE_KEY, openTransactionalStorage, parseStorageEnvelope,
  type LegacyCollectionSpec } from "../chain/TransactionalStorage"
import { retiredLineageKey } from "../chain/LineageRetirement"
import { AppEventHeadSchema, retiredAppStreamKey } from "./AppEventStream"
import { ChainEventRecordSchema, RetiredChainLineageSchema } from "./AppState"
import { createAppStore, PERSISTED_COLLECTION_SPECS, type AppStore } from "./AppStore"

const prefix = "smithers-mvp."
const caches = ["app-chain-events", "app-retired-chain-lineages"] as const
const authorities = ["app-events", "app-event-heads", "app-event-checkpoints", "app-event-retirements"] as const
type Row = { versionKey: string; data: Record<string, unknown> }
type Entries = Record<string, string>
const rows = (entries: Entries, id: string): Record<string, Row> => JSON.parse(entries[`${prefix}${id}`] ?? "{}")
const changeRows = (entries: Entries, id: string, change: (rows: Record<string, Row>) => void) => {
  const values = rows(entries, id); change(values); entries[`${prefix}${id}`] = JSON.stringify(values)
}
const memory = () => {
  const bytes = new Map<string, string>()
  const storage: StorageApi = { getItem: key => bytes.get(key) ?? null,
    setItem: (key, value) => { bytes.set(key, value) }, removeItem: key => { bytes.delete(key) } }
  return { bytes, storage }
}
const hostFor = (db: Database): SqliteRowDatabase => ({ execute: async <T>(sql: string, params: ReadonlyArray<unknown> = []) => {
  const statement = db.query(sql)
  if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return statement.all(...params as []) as ReadonlyArray<T>
  statement.run(...params as []); return []
} })
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
const own = (store: AppStore) => { cleanups.push(async () => { await store.dispose?.() }); return store }
let accepted: Entries
beforeAll(async () => {
  const { storage } = memory()
  const store = await createAppStore({ kind: "localStorage", storage }, { seedWiki: false })
  await store.dispatch({ type: "chain.lineage.retired", actor: "system", lineageId: "retired-before-cache-loss" }).isPersisted.promise
  await store.dispatch({ type: "chain.event.appended", actor: "system", lineageId: "kept", seq: 0,
    event: { _tag: "ChainStarted", goal: "retained execution evidence" } }).isPersisted.promise
  await store.compactEvents()
  await store.dispatch({ type: "chain.event.appended", actor: "system", lineageId: "kept", seq: 1,
    event: { _tag: "LinkEnded", outcome: "done" } }).isPersisted.promise
  await store.dispose?.()
  accepted = parseStorageEnvelope(storage.getItem(ENVELOPE_STORAGE_KEY)!)!.entries
})

const fixture = async (backend: "localStorage" | "sqlite", entries = structuredClone(accepted)) => {
  if (backend === "localStorage") {
    const { storage, bytes } = memory()
    storage.setItem(ENVELOPE_STORAGE_KEY, JSON.stringify({ version: 1, entries }))
    return {
      damage: () => {
        const envelope = parseStorageEnvelope(storage.getItem(ENVELOPE_STORAGE_KEY)!)!
        for (const id of caches) envelope.entries[`${prefix}${id}`] = "unreadable cache bytes"
        storage.setItem(ENVELOPE_STORAGE_KEY, JSON.stringify(envelope))
      },
      snapshot: () => JSON.stringify([...bytes].sort()),
      open: async () => own(await createAppStore({ kind: "localStorage", storage }, { seedWiki: false })),
      repairOnly: async () => { await openTransactionalStorage(storage, { collections: PERSISTED_COLLECTION_SPECS }) },
      authority: () => {
        const source = parseStorageEnvelope(storage.getItem(ENVELOPE_STORAGE_KEY)!)!.entries
        return authorities.map(id => source[`${prefix}${id}`])
      }
    }
  }
  const db = new Database(":memory:"), host = hostFor(db)
  cleanups.push(() => db.close())
  await (await openSqliteRowStorage(host, { collections: PERSISTED_COLLECTION_SPECS, schemaVersion: APP_SCHEMA_VERSION })).close()
  const insert = db.query("INSERT INTO smithers_collection_rows VALUES (?, ?, ?, ?)")
  for (const [key, raw] of Object.entries(entries)) {
    if (!key.startsWith(prefix)) continue
    for (const [rowKey, row] of Object.entries(JSON.parse(raw) as Record<string, Row>)) {
      insert.run(key.slice(prefix.length), rowKey, row.versionKey, JSON.stringify(row.data))
    }
  }
  return {
    damage: () => { for (const id of caches) db.query("UPDATE smithers_collection_rows SET value = ? WHERE collection_id = ?").run("unreadable cache bytes", id) },
    snapshot: () => JSON.stringify([db.query("SELECT * FROM smithers_collection_rows ORDER BY collection_id, row_key").all(),
      db.query("SELECT * FROM smithers_metadata ORDER BY key").all(), db.query("SELECT * FROM smithers_row_quarantine ORDER BY id").all()]),
    open: async () => {
      const adapter = await openSqliteRowStorage(host, { collections: PERSISTED_COLLECTION_SPECS, schemaVersion: APP_SCHEMA_VERSION })
      return own(await createAppStore({ kind: "opfs", ...adapter,
        storageEventApi: { addEventListener: () => {}, removeEventListener: () => {} } }, { seedWiki: false }))
    },
    repairOnly: async () => { await (await openSqliteRowStorage(host, { collections: PERSISTED_COLLECTION_SPECS, schemaVersion: APP_SCHEMA_VERSION })).close() },
    authority: () => authorities.map(id => JSON.stringify(db.query("SELECT * FROM smithers_collection_rows WHERE collection_id = ? ORDER BY row_key").all(id)))
  }
}

describe("authority-first recovery of projected chain caches", () => {
  for (const backend of ["localStorage", "sqlite"] as const) {
    test(`${backend}: rebuilds both malformed caches from an actual checkpoint and complete suffix`, async () => {
      const source = await fixture(backend)
      source.damage()
      const store = await source.open()
      expect([...store.collections.chainEvents.values()].map(row => ChainEventRecordSchema.parse(row))).toEqual(Object.values(rows(accepted, caches[0])).map(row => ChainEventRecordSchema.parse(row.data)))
      expect([...store.collections.retiredChainLineages.values()].map(row => RetiredChainLineageSchema.parse(row))).toEqual([{ id: retiredLineageKey("retired-before-cache-loss") }])
      expect((await store.verifyState()).valid).toBe(true)
      expect((await store.eventHistory()).head.streamId).toBe(AppEventHeadSchema.parse(Object.values(rows(accepted, "app-event-heads"))[0]!.data).streamId)
    })

    test(`${backend}: interruption after cache removal retains exact authority and a later boot rebuilds`, async () => {
      const source = await fixture(backend)
      source.damage()
      const authority = source.authority()
      await source.repairOnly() // Simulated process exit before AppStore's boot repair.
      expect(source.authority()).toEqual(authority)
      const store = await source.open()
      expect(store.collections.chainEvents.size).toBe(2)
      expect(store.collections.retiredChainLineages.size).toBe(1)
      expect((await store.verifyState()).valid).toBe(true)
    })

    const refused: ReadonlyArray<readonly [string, (entries: Entries) => void]> = [
      ["legacy with no application authority", entries => { for (const id of authorities) delete entries[`${prefix}${id}`] }],
      ["head without checkpoint", entries => { delete entries[`${prefix}app-event-checkpoints`] }],
      ["checkpoint without head", entries => { delete entries[`${prefix}app-event-heads`] }],
      ["missing committed suffix", entries => { entries[`${prefix}app-events`] = "{}" }],
      ["checkpoint digest mismatch", entries => changeRows(entries, "app-event-checkpoints", rows => { Object.values(rows)[0]!.data.stateHash = "0".repeat(64) })],
      ["head state mismatch", entries => changeRows(entries, "app-event-heads", rows => { Object.values(rows)[0]!.data.stateHash = "0".repeat(64) })],
      ["duplicate current head alias", entries => changeRows(entries, "app-event-heads", rows => { rows.current = structuredClone(Object.values(rows)[0]!) })],
      ["retired current stream", entries => {
        const streamId = Object.values(rows(entries, "app-event-heads"))[0]!.data.streamId as string
        const id = retiredAppStreamKey(streamId)
        changeRows(entries, "app-event-retirements", rows => { rows[`s:${id}`] = { versionKey: "v", data: { id } } })
      }],
      ["future event format", entries => changeRows(entries, "app-events", rows => { Object.values(rows)[0]!.data.formatVersion = 100 })],
      ...authorities.map(id => [`malformed ${id}`, (entries: Entries) => {
        changeRows(entries, id, rows => { rows["s:broken"] = { versionKey: "v", data: { id: "broken" } } })
      }] as const)
    ]
    for (const [reason, edit] of refused) test(`${backend}: ${reason} refuses before any repair`, async () => {
      const entries = structuredClone(accepted); edit(entries)
      const source = await fixture(backend, entries)
      source.damage()
      const original = source.snapshot()
      await expect(source.open()).rejects.toThrow()
      expect(source.snapshot()).toBe(original)
    })
  }

  for (const verified of [false, true]) test(`SQLite legacy envelope: only complete verified authority permits cache import repair (${verified})`, async () => {
    const db = new Database(":memory:"), host = hostFor(db)
    cleanups.push(() => db.close())
    const entries = structuredClone(accepted)
    if (!verified) for (const id of authorities) delete entries[`${prefix}${id}`]
    for (const id of caches) entries[`${prefix}${id}`] = "damaged legacy cache"
    const original = JSON.stringify({ version: 1, entries })
    db.run("CREATE TABLE smithers_kv(key TEXT PRIMARY KEY, value TEXT)")
    db.query("INSERT INTO smithers_kv VALUES (?, ?)").run(ENVELOPE_STORAGE_KEY, original)
    const opening = openSqliteRowStorage(host, { collections: PERSISTED_COLLECTION_SPECS, schemaVersion: APP_SCHEMA_VERSION })
    if (verified) {
      const adapter = await opening
      const store = own(await createAppStore({ kind: "opfs", ...adapter,
        storageEventApi: { addEventListener: () => {}, removeEventListener: () => {} } }, { seedWiki: false }))
      expect(store.collections.chainEvents.size).toBe(2)
      expect(store.collections.retiredChainLineages.size).toBe(1)
      expect((await store.verifyState()).valid).toBe(true)
    } else {
      await expect(opening).rejects.toThrow("authoritative")
      expect(db.query("SELECT COUNT(*) AS count FROM smithers_collection_rows").get()).toEqual({ count: 0 })
      expect(db.query("SELECT COUNT(*) AS count FROM smithers_row_quarantine").get()).toEqual({ count: 0 })
    }
    expect(db.query("SELECT value FROM smithers_kv WHERE key = ?").get(ENVELOPE_STORAGE_KEY)).toEqual({ value: original })
  })

  test("localStorage: replacing authority while an async cache decoder waits refuses without repairing the new source", async () => {
    const { storage } = memory()
    const entries = structuredClone(accepted)
    changeRows(entries, caches[0], rows => { Object.values(rows)[0]!.data.seq = -1 })
    storage.setItem(ENVELOPE_STORAGE_KEY, JSON.stringify({ version: 1, entries }))
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const collections = PERSISTED_COLLECTION_SPECS.map(spec => spec.id !== caches[0] ? spec : {
      ...spec, schema: { "~standard": { version: 1 as const, vendor: "snapshot-test", validate: async () => {
        entered.resolve(); await release.promise; return { issues: [{ message: "damaged cache" }] }
      } } }
    })
    const opening = openTransactionalStorage(storage, { collections })
    await entered.promise
    const replacement = JSON.stringify({ version: 1, entries: { ...accepted, changed: "new owner bytes" } })
    storage.setItem(ENVELOPE_STORAGE_KEY, replacement)
    release.resolve()
    await expect(opening).rejects.toThrow("changed while opening")
    expect(storage.getItem(ENVELOPE_STORAGE_KEY)).toBe(replacement)
  })

  test("SQLite: the authority proof and cache repair hold the same real database write lock", async () => {
    const directory = mkdtempSync(join(tmpdir(), "smithers-cache-proof-")), path = join(directory, "state.sqlite")
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
    const db = new Database(path), other = new Database(path), host = hostFor(db)
    cleanups.push(() => { db.close(); other.close() })
    other.run("PRAGMA busy_timeout = 0")
    await (await openSqliteRowStorage(host, { collections: PERSISTED_COLLECTION_SPECS, schemaVersion: APP_SCHEMA_VERSION })).close()
    for (const [key, raw] of Object.entries(accepted)) for (const [rowKey, row] of Object.entries(JSON.parse(raw) as Record<string, Row>)) {
      db.query("INSERT INTO smithers_collection_rows VALUES (?, ?, ?, ?)").run(key.slice(prefix.length), rowKey, row.versionKey, JSON.stringify(row.data))
    }
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const collections: ReadonlyArray<LegacyCollectionSpec> = PERSISTED_COLLECTION_SPECS.map(spec => spec.id !== caches[0] ? spec : {
      ...spec, schema: { "~standard": { version: 1 as const, vendor: "snapshot-test", validate: async () => {
        entered.resolve(); await release.promise; return { issues: [{ message: "damaged cache" }] }
      } } }
    })
    const opening = openSqliteRowStorage(host, { collections, schemaVersion: APP_SCHEMA_VERSION })
    await entered.promise
    try {
      expect(() => other.query("UPDATE smithers_collection_rows SET value = '{}' WHERE collection_id = 'app-event-heads'").run()).toThrow("locked")
    } finally { release.resolve() }
    const repaired = await opening
    await repaired.close()
    expect(db.query("SELECT COUNT(*) AS count FROM smithers_collection_rows WHERE collection_id = 'app-chain-events'").get()).toEqual({ count: 0 })
    expect(db.query("SELECT COUNT(*) AS count FROM smithers_row_quarantine WHERE collection_id = 'app-chain-events'").get()).toEqual({ count: 2 })
  })
})
