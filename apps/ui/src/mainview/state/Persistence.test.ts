import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { APP_SCHEMA_VERSION } from "../chain/SchemaVersion"
import { openSqliteRowStorage, ROW_TABLE_NAME } from "../chain/SqliteRowStorage"
import { ENVELOPE_STORAGE_KEY } from "../chain/TransactionalStorage"
import type { ChainEventRecord, ToolCallRecord, TransitionRecord } from "./AppState"
import { createAppStore, MAX_TOOL_CALL_RECORDS, MAX_TRANSITION_RECORDS } from "./AppStore"

/*
 * Ruling A, store level (docs/persistence.md): a dispatch is one atomic
 * commit — every projection changes or none does — and the log collections
 * compact to their documented retention bounds inside the committing
 * transaction.
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

/** A host whose envelope commit write can be made to crash mid-dispatch. */
const crashableStorage = (): StorageApi & { crashCommit: () => void; heal: () => void } => {
  const inner = memoryStorage()
  let armed = false
  return {
    crashCommit: () => {
      armed = true
    },
    heal: () => {
      armed = false
    },
    getItem: (key) => inner.getItem(key),
    setItem: (key, value) => {
      if (armed && key === ENVELOPE_STORAGE_KEY) throw new Error("crash at the commit point")
      inner.setItem(key, value)
    },
    removeItem: (key) => inner.removeItem(key)
  }
}

describe("an atomic commit point per logical transition", () => {
  test("reopening releases an interrupted form submission and preserves its inputs", async () => {
    const host = memoryStorage()
    const store = await createAppStore({ kind: "localStorage", storage: host })
    await store.dispatch({
      type: "card.upsert", actor: "user",
      card: {
        id: "form-tab.harness", kind: "flow-form", title: "/tab.harness", status: "active", createdAt: 1, ordinal: 1,
        payload: { flow: "tab.harness", via: "user", fields: [], draft: { harnessId: "codex" }, given: {}, submitting: true }
      }
    }).isPersisted.promise
    const reopened = await createAppStore({ kind: "localStorage", storage: host })
    const card = reopened.collections.cards.get("form-tab.harness")
    expect(card?.status).toBe("error")
    expect(card?.payload).toMatchObject({ submitting: false, draft: { harnessId: "codex" }, error: expect.stringContaining("Check the result") })
    expect([...reopened.collections.transitions.values()].some((row) => row.type === "card.updated" && row.actor === "system")).toBe(true)
    const again = await createAppStore({ kind: "localStorage", storage: host })
    expect(again.collections.cards.get("form-tab.harness")?.payload).toMatchObject({ submitting: false })
  })

  test("a dispatch commits every projection or none", async () => {
    const host = crashableStorage()
    const store = await createAppStore({ kind: "localStorage", storage: host })
    const transitionsBefore = store.collections.transitions.size
    const draftBefore = store.session().draft

    host.crashCommit()
    await expect(
      store.dispatch({ type: "composer.changed", actor: "user", draft: "half-written" }).isPersisted
        .promise
    ).rejects.toThrow()
    expect(store.session().draft).toBe(draftBefore)
    expect(store.collections.transitions.size).toBe(transitionsBefore)
    host.heal()

    // Reopening recovers by rolling the interrupted commit back: neither
    // the session projection (the draft) nor the transition record survived.
    const reopened = await createAppStore({ kind: "localStorage", storage: host })
    expect(reopened.session().draft).toBe(draftBefore)
    expect(reopened.collections.transitions.size).toBe(transitionsBefore)
  })

  test("a later successful dispatch cannot persist a failed transition from live state or an adapter cache", async () => {
    const host = crashableStorage()
    const store = await createAppStore({ kind: "localStorage", storage: host })
    host.crashCommit()
    await expect(store.dispatch({ type: "composer.changed", actor: "user", draft: "failed draft" }).isPersisted.promise).rejects.toThrow()
    expect(store.session().draft).toBe("")
    expect(store.session().revision).toBe(0)
    expect(store.collections.transitions.size).toBe(0)
    host.heal()
    await store.dispatch({ type: "theme.changed", actor: "user", theme: "dark" }).isPersisted.promise
    const reopened = await createAppStore({ kind: "localStorage", storage: host })
    expect(reopened.session().draft).toBe("")
    expect(reopened.session().theme).toBe("dark")
    expect([...reopened.collections.transitions.values()].map((row) => row.type)).toEqual(["theme.changed"])
  })

  test("a dispatch inside a failure handler cannot adopt a queued transaction still rolling back", async () => {
    const host = crashableStorage()
    const store = await createAppStore({ kind: "localStorage", storage: host })
    host.crashCommit()
    const first = store.dispatch({ type: "composer.changed", actor: "user", draft: "failed first" }).isPersisted.promise
    // A second keystroke would join the first draft's commit; a different transition queues its own.
    const second = store.dispatch({ type: "theme.changed", actor: "user", theme: "dark" }).isPersisted.promise
    const secondResult = second.catch(() => "rejected")
    const reentrant = first.catch(async () => {
      // The second optimistic projection has not rolled back yet.
      expect(store.session().theme).toBe("dark")
      host.heal()
      return store.dispatch({ type: "theme.changed", actor: "user", theme: "dark" }).isPersisted.promise
    })
    await expect(reentrant).rejects.toThrow("state that did not persist")
    await secondResult
    expect(store.session().draft).toBe("")
    expect(store.session().revision).toBe(0)
    await store.dispatch({ type: "theme.changed", actor: "user", theme: "dark" }).isPersisted.promise
    const reopened = await createAppStore({ kind: "localStorage", storage: host })
    expect(reopened.session().draft).toBe("")
    expect([...reopened.collections.transitions.values()].map((row) => row.type)).toEqual(["theme.changed"])
  })

  test("a dispatch whose commit lands persists every projection", async () => {
    const host = memoryStorage()
    const store = await createAppStore({ kind: "localStorage", storage: host })
    await store.dispatch({ type: "composer.changed", actor: "user", draft: "kept" }).isPersisted.promise
    const reopened = await createAppStore({ kind: "localStorage", storage: host })
    expect(reopened.session().draft).toBe("kept")
    expect(
      [...reopened.collections.transitions.values()].some((record) => record.type === "composer.changed")
    ).toBe(true)
  })
})

/** Counts localStorage commits: the backend writes the whole envelope once per durable transaction. */
const countingStorage = (): StorageApi & { readonly commits: () => number } => {
  const inner = memoryStorage()
  let commits = 0
  return {
    commits: () => commits,
    getItem: (key) => inner.getItem(key),
    setItem: (key, value) => {
      if (key === ENVELOPE_STORAGE_KEY) commits += 1
      inner.setItem(key, value)
    },
    removeItem: (key) => inner.removeItem(key)
  }
}

describe("composer drafts", () => {
  test("a burst of keystrokes commits one envelope and journals only the final draft", async () => {
    const host = countingStorage()
    const store = await createAppStore({ kind: "localStorage", storage: host })
    const before = host.commits()
    const text = "hello from a burst of keystrokes"
    const receipts = [...text].map((_, index) => {
      const receipt = store.dispatch({ type: "composer.changed", actor: "user", draft: text.slice(0, index + 1) }).isPersisted.promise
      // The draft is live at once; only its durable write waits.
      expect(store.session().draft).toBe(text.slice(0, index + 1))
      return receipt
    })
    await Promise.all(receipts)
    expect(host.commits() - before).toBe(1)
    const journaled = [...store.collections.transitions.values()].filter((record) => record.type === "composer.changed")
    expect(journaled.map((record) => JSON.parse(record.payload))).toEqual([{ draft: text }])
    const reopened = await createAppStore({ kind: "localStorage", storage: host })
    expect(reopened.session().draft).toBe(text)
  })

  test("the next dispatch commits a pending draft first", async () => {
    const host = memoryStorage()
    const store = await createAppStore({ kind: "localStorage", storage: host })
    store.dispatch({ type: "composer.changed", actor: "user", draft: "typed before the next act" })
    await store.dispatch({ type: "theme.changed", actor: "user", theme: "dark" }).isPersisted.promise
    const reopened = await createAppStore({ kind: "localStorage", storage: host })
    expect(reopened.session().draft).toBe("typed before the next act")
    expect(reopened.session().theme).toBe("dark")
    expect([...reopened.collections.transitions.values()].map((record) => record.type)).toEqual(["composer.changed", "theme.changed"])
  })

  test("dispose commits a pending draft before releasing the store", async () => {
    const host = memoryStorage()
    const store = await createAppStore({ kind: "localStorage", storage: host })
    store.dispatch({ type: "composer.changed", actor: "user", draft: "typed just before closing" })
    await store.dispose?.()
    const reopened = await createAppStore({ kind: "localStorage", storage: host })
    expect(reopened.session().draft).toBe("typed just before closing")
  })
})

describe("overlapping OPFS dispatches", () => {
  for (const fails of [false, true]) {
    test(fails ? "a disk failure rejects overlapping dependent transitions and rolls back live state" : "each dispatch waits for its own separate SQLite commit", async () => {
      const template = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
      const specs = Object.values(template.collections).map((collection) => ({ id: collection.id, schema: collection.config.schema! }))
      const sqlite = new Database(":memory:")
      let pause = false
      let entered!: () => void
      let release!: () => void
      const blocked = new Promise<void>((resolve) => { entered = resolve })
      const gate = new Promise<void>((resolve) => { release = resolve })
      const committedRevisions: number[] = []
      const durableSession = () => JSON.parse((sqlite.query(`SELECT value FROM ${ROW_TABLE_NAME} WHERE collection_id = 'app-sessions'`).get() as { value: string }).value) as { revision: number; draft: string }
      const adapter = await openSqliteRowStorage({
        execute: async <TRow>(sql: string, params: ReadonlyArray<unknown> = []): Promise<ReadonlyArray<TRow>> => {
          if (pause && sql === "BEGIN IMMEDIATE") {
            pause = false
            entered()
            await gate
            if (fails) throw new Error("disk unavailable")
          }
          const statement = sqlite.query(sql)
          if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return statement.all(...params as []) as ReadonlyArray<TRow>
          statement.run(...params as [])
          if (sql === "COMMIT" && sqlite.query(`SELECT value FROM ${ROW_TABLE_NAME} WHERE collection_id = 'app-sessions'`).get() !== null) committedRevisions.push(durableSession().revision)
          return []
        },
        close: () => sqlite.close()
      }, { collections: specs, schemaVersion: APP_SCHEMA_VERSION })
      const store = await createAppStore({ kind: "opfs", ...adapter, storageEventApi: { addEventListener: () => {}, removeEventListener: () => {} } })
      committedRevisions.length = 0
      pause = true
      let first = "pending", second = "pending"
      const firstPromise = store.dispatch({ type: "composer.changed", actor: "user", draft: "overlap" }).isPersisted.promise.then(() => { first = "resolved" }, () => { first = "rejected" })
      const secondPromise = store.dispatch({ type: "theme.changed", actor: "user", theme: "dark" }).isPersisted.promise.then(() => { second = "resolved" }, () => { second = "rejected" })
      await blocked
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect([first, second]).toEqual(["pending", "pending"])
      expect(durableSession().revision).toBe(0)
      release()
      await Promise.all([firstPromise, secondPromise])
      expect([first, second]).toEqual(fails ? ["rejected", "rejected"] : ["resolved", "resolved"])
      expect(committedRevisions).toEqual(fails ? [] : [1, 2])
      expect(store.session().revision).toBe(fails ? 0 : 2)
      expect(store.session().draft).toBe(fails ? "" : "overlap")
      expect(durableSession().revision).toBe(fails ? 0 : 2)
      await adapter.close().catch(() => {})
    })
  }
})

describe("retention bounds", () => {
  test("transitions compact to the newest 500 inside the appending transaction", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const seeded: TransitionRecord[] = Array.from({ length: MAX_TRANSITION_RECORDS + 10 }, (_, index) => ({
      id: `transition-seed-${index}`,
      revision: index + 1,
      actor: "user",
      type: "composer.changed",
      payload: "{}",
      createdAt: index + 1
    }))
    await store.collections.transitions.insert(seeded).isPersisted.promise
    await store.dispatch({ type: "composer.changed", actor: "user", draft: "x" }).isPersisted.promise
    const remaining = [...store.collections.transitions.values()]
    expect(remaining.length).toBe(MAX_TRANSITION_RECORDS)
    expect(remaining.some((record) => record.id === "transition-seed-0")).toBe(false)
    expect(remaining.some((record) => record.id === `transition-seed-${MAX_TRANSITION_RECORDS + 9}`)).toBe(true)
  })

  test("tool-call records compact to the newest 250", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const seeded: ToolCallRecord[] = Array.from({ length: MAX_TOOL_CALL_RECORDS + 5 }, (_, index) => ({
      id: `toolcall-seed-${index}`,
      turnId: "turn",
      name: "tool",
      arguments: "{}",
      result: "ok",
      createdAt: index + 1
    }))
    await store.collections.toolCalls.insert(seeded).isPersisted.promise
    await store.dispatch({ type: "composer.changed", actor: "user", draft: "x" }).isPersisted.promise
    const remaining = [...store.collections.toolCalls.values()]
    expect(remaining.length).toBe(MAX_TOOL_CALL_RECORDS)
    expect(remaining.some((record) => record.id === "toolcall-seed-0")).toBe(false)
    expect(remaining.some((record) => record.id === `toolcall-seed-${MAX_TOOL_CALL_RECORDS + 4}`)).toBe(true)
  })

  test("unrelated transitions never trim authoritative chain-event records", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const seeded: ChainEventRecord[] = Array.from({ length: 1_005 }, (_, index) => ({
      id: `chain-seed-${index}`,
      lineageId: "lineage",
      seq: index,
      event: { kind: "tick" },
      createdAt: index + 1
    }))
    await store.collections.chainEvents.insert(seeded).isPersisted.promise
    await store.dispatch({ type: "composer.changed", actor: "user", draft: "x" }).isPersisted.promise
    const remaining = [...store.collections.chainEvents.values()]
    expect(remaining.length).toBe(seeded.length)
    expect(remaining.some((record) => record.id === "chain-seed-0")).toBe(true)
    expect(remaining.some((record) => record.id === "chain-seed-1004")).toBe(true)
  })
})
