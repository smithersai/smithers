import { Event, Journal } from "@smthrs/chain"
import type { StorageApi } from "@tanstack/db"
import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAppStore } from "../state/AppStore"
import { makeCollectionJournal } from "./CollectionJournal"
import { retiredLineageKey } from "./LineageRetirement"
import { APP_SCHEMA_VERSION } from "./SchemaVersion"
import { openSqliteRowStorage } from "./SqliteRowStorage"
import { ENVELOPE_STORAGE_KEY } from "./TransactionalStorage"

const memoryStorage = (): StorageApi => {
  const rows = new Map<string, string>()
  return {
    getItem: (key) => rows.get(key) ?? null,
    setItem: (key, value) => {
      rows.set(key, value)
    },
    removeItem: (key) => {
      rows.delete(key)
    }
  }
}
const started: Event.Event = { _tag: "ChainStarted", goal: "commit proof", envelope: null }

const blockedStore = async (path = ":memory:") => {
  const template = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const collections = Object.values(template.collections).map((collection) => ({
    id: collection.id,
    schema: collection.config.schema!
  }))
  const sqlite = new Database(path)
  let block = false
  let fails = false
  let entered!: () => void
  let release!: () => void
  const insideCommit = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const adapter = await openSqliteRowStorage({
    execute: async <TRow>(sql: string, params: ReadonlyArray<unknown> = []): Promise<ReadonlyArray<TRow>> => {
      if (block && sql === "COMMIT") {
        block = false
        entered()
        await gate
        if (fails) throw new Error("injected commit failure")
      }
      const statement = sqlite.query(sql)
      if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return statement.all(...params as []) as ReadonlyArray<TRow>
      statement.run(...params as [])
      return []
    },
    close: () => sqlite.close()
  }, { collections, schemaVersion: APP_SCHEMA_VERSION })
  const store = await createAppStore({
    kind: "opfs",
    ...adapter,
    storageEventApi: { addEventListener: () => {}, removeEventListener: () => {} }
  })
  return {
    store,
    insideCommit,
    release,
    arm: (failure: boolean) => {
      block = true
      fails = failure
    },
    close: () => adapter.close()
  }
}

describe("CollectionJournal commit and position contract", () => {
  test("retirement survives a fresh SQLite connection and cannot be replayed after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "smithers-journal-retirement-"))
    const stores: Awaited<ReturnType<typeof blockedStore>>[] = []
    try {
      const path = join(directory, "store.sqlite")
      const first = await blockedStore(path)
      stores.push(first)
      await Effect.runPromise(makeCollectionJournal({ store: first.store, lineageId: "retired" }).append(started, 0))
      await first.store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
      await first.close()
      const second = await blockedStore(path)
      stores.push(second)
      expect(second.store.collections.chainEvents.size).toBe(0)
      expect(second.store.collections.retiredChainLineages.has(retiredLineageKey("retired"))).toBe(true)
      const retired = makeCollectionJournal({ store: second.store, lineageId: "retired" })
      expect((await Effect.runPromise(Effect.flip(retired.read))).message).toContain("retired")
      expect((await Effect.runPromise(Effect.flip(retired.append(started, 0)))).message).toContain("retired")
    } finally {
      try {
        for (const store of stores) await store.close()
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  })

  test("account scrubbing commits replay refusal and private-event deletion atomically", async () => {
    const inner = memoryStorage()
    let fail = false
    const storage: StorageApi = {
      ...inner,
      setItem: (key, value) => {
        if (fail && key === ENVELOPE_STORAGE_KEY) throw new Error("sign-out commit refused")
        inner.setItem(key, value)
      }
    }
    const store = await createAppStore({ kind: "localStorage", storage })
    const journal = makeCollectionJournal({ store, lineageId: "private-account-label" })
    await Effect.runPromise(journal.append(started, 0))
    fail = true
    await expect(store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise).rejects
      .toThrow("sign-out commit refused")
    expect(await Effect.runPromise(journal.read)).toEqual([started])
    expect(store.collections.retiredChainLineages.size).toBe(0)
    fail = false
    await store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
    expect(store.collections.chainEvents.size).toBe(0)
    expect([...store.collections.retiredChainLineages.values()].map(({ id }) => ({ id }))).toEqual([
      { id: retiredLineageKey("private-account-label") }
    ])
    expect(retiredLineageKey("private-account-label")).toMatch(/^[a-f0-9]{64}$/)
    expect(await Effect.runPromise(Effect.flip(journal.append(started, 0)))).toBeInstanceOf(Journal.JournalError)
    const reopened = await createAppStore({ kind: "localStorage", storage })
    await reopened.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
    const retired = makeCollectionJournal({ store: reopened, lineageId: "private-account-label" })
    expect((await Effect.runPromise(Effect.flip(retired.read))).message).toContain("retired")
    expect(reopened.collections.retiredChainLineages.size).toBe(1)
  })

  test("two adapters over one store cannot both append at the same position", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const first = makeCollectionJournal({ store, lineageId: "same" })
    const second = makeCollectionJournal({ store, lineageId: "same" })
    const results = await Promise.all([
      Effect.runPromise(Effect.exit(first.append(started, 0))),
      Effect.runPromise(Effect.exit(second.append(started, 0)))
    ])
    expect(results.filter(Exit.isSuccess)).toHaveLength(1)
    expect(results.filter(Exit.isFailure)).toHaveLength(1)
    expect(await Effect.runPromise(first.read)).toEqual([started])
    const conflict = await Effect.runPromise(Effect.flip(second.append(started, 0)))
    expect(conflict).toBeInstanceOf(Journal.JournalError)
    expect(conflict.code).toBe("journal_conflict")
  })

  for (const failure of [false, true]) {
    test(`reads wait for ${failure ? "rollback" : "commit"}, never return optimistic evidence`, async () => {
      const host = await blockedStore()
      const writer = makeCollectionJournal({ store: host.store, lineageId: "pending" })
      const reader = makeCollectionJournal({ store: host.store, lineageId: "pending" })
      host.arm(failure)
      const append = Effect.runPromise(Effect.exit(writer.append(started, 0)))
      let readDone = false
      let read: Promise<ReadonlyArray<Event.Event>> | undefined
      try {
        await host.insideCommit
        expect(host.store.collections.chainEvents.size).toBe(1)
        read = Effect.runPromise(reader.read).then((events) => {
          readDone = true
          return events
        })
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(readDone).toBe(false)
        host.release()
        expect(Exit.isFailure(await append)).toBe(failure)
        expect(await read).toEqual(failure ? [] : [started])
        if (failure) {
          // The SQLite adapter refuses further writes after a failed commit
          // until reopened; the journal must not turn that refusal into a hit.
          expect(await Effect.runPromise(Effect.flip(writer.append(started, 0)))).toBeInstanceOf(Journal.JournalError)
          expect(await Effect.runPromise(reader.read)).toEqual([])
        }
      } finally {
        host.release()
        await append
        await read
        if (failure) await expect(host.close()).rejects.toThrow("injected commit failure")
        else await host.close()
      }
    })
  }

  test("interrupting a writer cannot release readers before its non-cancellable commit settles", async () => {
    const host = await blockedStore()
    const writer = makeCollectionJournal({ store: host.store, lineageId: "interrupted" })
    const reader = makeCollectionJournal({ store: host.store, lineageId: "interrupted" })
    host.arm(false)
    const fiber = Effect.runFork(writer.append(started, 0))
    let interruption: Promise<unknown> | undefined
    let read: Promise<ReadonlyArray<Event.Event>> | undefined
    try {
      await host.insideCommit
      interruption = Effect.runPromise(Fiber.interrupt(fiber))
      let readDone = false
      read = Effect.runPromise(reader.read).then((events) => {
        readDone = true
        return events
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(readDone).toBe(false)
      host.release()
      await interruption
      expect(await read).toEqual([started])
    } finally {
      host.release()
      await interruption
      await read
      await host.close()
    }
  })

  test("a localStorage quota refusal preserves committed evidence and a healed retry appends once", async () => {
    const inner = memoryStorage()
    let full = false
    const storage: StorageApi = {
      ...inner,
      setItem: (key, value) => {
        if (full && key === ENVELOPE_STORAGE_KEY) throw new DOMException("storage is full", "QuotaExceededError")
        inner.setItem(key, value)
      }
    }
    const store = await createAppStore({ kind: "localStorage", storage })
    const journal = makeCollectionJournal({ store, lineageId: "quota" })
    await Effect.runPromise(journal.append(started, 0))
    full = true
    const next = { _tag: "SteeringDrained", link: 0, ordinal: 0, messages: ["keep going"] } as Event.Event
    expect(await Effect.runPromise(Effect.flip(journal.append(next, 1)))).toBeInstanceOf(Journal.JournalError)
    expect(await Effect.runPromise(journal.read)).toEqual([started])
    full = false
    const reopened = await createAppStore({ kind: "localStorage", storage })
    const recovered = makeCollectionJournal({ store: reopened, lineageId: "quota" })
    expect(await Effect.runPromise(recovered.read)).toEqual([started])
    await Effect.runPromise(recovered.append(next, 1))
    expect(await Effect.runPromise(recovered.read)).toEqual([started, next])
  })

  for (const sequences of [[1], [0, 2], [0, 0]]) {
    test(`refuses a missing prefix/gap/duplicate sequence ${JSON.stringify(sequences)}`, async () => {
      const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
      await store.collections.chainEvents.insert(sequences.map((seq, index) => ({
        id: `raw-${index}`,
        lineageId: "corrupt",
        seq,
        event: started,
        createdAt: index
      }))).isPersisted.promise
      const journal = makeCollectionJournal({ store, lineageId: "corrupt" })
      expect(await Effect.runPromise(Effect.flip(journal.read))).toBeInstanceOf(Journal.JournalError)
      expect(await Effect.runPromise(Effect.flip(journal.append(started, sequences.length)))).toBeInstanceOf(
        Journal.JournalError
      )
      expect(store.collections.chainEvents.size).toBe(sequences.length)
    })
  }
})
