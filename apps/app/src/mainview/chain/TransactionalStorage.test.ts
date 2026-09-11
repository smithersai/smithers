import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import {
  ENVELOPE_QUARANTINE_PREFIX,
  ENVELOPE_STORAGE_KEY,
  ENVELOPE_VERSION,
  openTransactionalStorage,
  ROW_QUARANTINE_PREFIX,
  UnsupportedStorageEnvelopeError,
  STAGED_ENVELOPE_STORAGE_KEY
} from "./TransactionalStorage"

/*
 * Crash-injection coverage for the write-ahead commit protocol
 * (docs/persistence.md): every stage of stage → commit → clear gets a crash
 * or a kill, and both recovery directions — complete and roll back — are
 * proven from the stages that can produce them.
 */

/** A StorageApi host whose writes can be made to crash at a chosen stage. */
const scriptableHost = () => {
  const data = new Map<string, string>()
  const host: StorageApi & {
    readonly data: Map<string, string>
    crashOnSet: string | undefined
    crashOnRemove: string | undefined
  } = {
    data,
    crashOnSet: undefined,
    crashOnRemove: undefined,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      if (host.crashOnSet === key) throw new Error(`crash writing ${key}`)
      data.set(key, value)
    },
    removeItem: (key) => {
      if (host.crashOnRemove === key) throw new Error(`crash removing ${key}`)
      data.delete(key)
    }
  }
  return host
}

const open = (host: StorageApi) => openTransactionalStorage(host)

/** The envelope bytes an open store committed, decoded. */
const liveEntries = (host: StorageApi): Record<string, string> => {
  const raw = host.getItem(ENVELOPE_STORAGE_KEY)
  if (raw === null) return {}
  return (JSON.parse(raw) as { entries: Record<string, string> }).entries
}

describe("the write-ahead commit protocol", () => {
  test("a clean commit leaves no staged bytes behind", async () => {
    const host = scriptableHost()
    const store = await open(host)
    store.storage.setItem(
      "smithers-mvp.widgets",
      "{\"w1\":{\"versionKey\":\"v\",\"data\":{\"id\":\"w1\",\"label\":\"a\"}}}"
    )
    expect(host.getItem(STAGED_ENVELOPE_STORAGE_KEY)).toBe(null)
    expect(store.recovery).toBe("clean")
    expect(liveEntries(host)["smithers-mvp.widgets"]).toContain("\"label\":\"a\"")
  })

  test("a batch commits every projection or none", async () => {
    const host = scriptableHost()
    const store = await open(host)
    store.storage.setItem("keep", "before")
    host.crashOnSet = ENVELOPE_STORAGE_KEY
    await expect(
      store.batch(async () => {
        store.storage.setItem("one", "1")
        store.storage.setItem("two", "2")
        store.storage.setItem("keep", "after")
      })
    ).rejects.toThrow("crash writing smithers-mvp.store")
    // None of the batch's projections reached the host — not even the keys
    // whose own write succeeded before the crash.
    expect(liveEntries(host)).toEqual({ keep: "before" })
  })

  test("a failed commit leaves the live store reading the last committed envelope", async () => {
    /*
     * The mirror the session reads from must never run ahead of the host.
     * When the commit write throws (a quota rejection, a revoked host) the
     * facade used to keep the uncommitted value in memory: the session read
     * a projection the host never took, and the NEXT successful commit
     * wrote it out — exactly the half-applied transition this facade exists
     * to prevent.
     */
    const host = scriptableHost()
    const store = await open(host)
    store.storage.setItem("keep", "before")
    host.crashOnSet = ENVELOPE_STORAGE_KEY
    expect(() => store.storage.setItem("keep", "after")).toThrow()
    host.crashOnSet = undefined
    expect(store.storage.getItem("keep")).toBe("before")
    // A later, unrelated commit must not smuggle the failed write out.
    store.storage.setItem("other", "x")
    expect(liveEntries(host)).toEqual({ keep: "before", other: "x" })
  })

  test("an aborted batch leaves neither the host nor the live store holding its writes", async () => {
    const host = scriptableHost()
    const store = await open(host)
    store.storage.setItem("keep", "before")
    host.crashOnSet = ENVELOPE_STORAGE_KEY
    await expect(
      store.batch(async () => {
        store.storage.setItem("keep", "after")
        store.storage.setItem("extra", "1")
      })
    ).rejects.toThrow("crash writing smithers-mvp.store")
    host.crashOnSet = undefined
    expect(store.storage.getItem("keep")).toBe("before")
    expect(store.storage.getItem("extra")).toBe(null)
    store.storage.setItem("other", "x")
    expect(liveEntries(host)).toEqual({ keep: "before", other: "x" })
  })

  test("a crash during the stage write rolls back: the old envelope stays authoritative", async () => {
    const host = scriptableHost()
    const store = await open(host)
    store.storage.setItem("keep", "before")
    host.crashOnSet = STAGED_ENVELOPE_STORAGE_KEY
    expect(() => store.storage.setItem("keep", "after")).toThrow()
    host.crashOnSet = undefined
    const reopened = await open(host)
    expect(reopened.recovery).toBe("clean")
    expect(reopened.storage.getItem("keep")).toBe("before")
  })

  test("a crash at the commit write rolls back: staged bytes are dropped, the old envelope stays", async () => {
    const host = scriptableHost()
    const store = await open(host)
    store.storage.setItem("keep", "before")
    host.crashOnSet = ENVELOPE_STORAGE_KEY
    expect(() => store.storage.setItem("keep", "after")).toThrow()
    host.crashOnSet = undefined
    // The stage landed before the crash, so recovery has something to undo.
    expect(host.getItem(STAGED_ENVELOPE_STORAGE_KEY)).not.toBe(null)
    const reopened = await open(host)
    expect(reopened.recovery).toBe("rollback")
    expect(reopened.storage.getItem("keep")).toBe("before")
    expect(host.getItem(STAGED_ENVELOPE_STORAGE_KEY)).toBe(null)
  })

  test("a kill between stage and commit rolls back the interrupted commit", async () => {
    const host = scriptableHost()
    const store = await open(host)
    store.storage.setItem("keep", "before")
    // Simulate the kill: the stage holds the next envelope, the commit
    // point never ran, and the process simply never came back to it.
    host.setItem(STAGED_ENVELOPE_STORAGE_KEY, JSON.stringify({ version: ENVELOPE_VERSION, entries: { keep: "after" } }))
    const reopened = await open(host)
    expect(reopened.recovery).toBe("rollback")
    expect(reopened.storage.getItem("keep")).toBe("before")
  })

  test("failed stage cleanup still reports the committed write and boot completes recovery", async () => {
    const host = scriptableHost()
    const store = await open(host)
    store.storage.setItem("keep", "before")
    host.crashOnRemove = STAGED_ENVELOPE_STORAGE_KEY
    expect(() => store.storage.setItem("keep", "after")).not.toThrow()
    expect(store.storage.getItem("keep")).toBe("after")
    host.crashOnRemove = undefined
    // The commit point ran and only the clear was interrupted.
    const reopened = await open(host)
    expect(reopened.recovery).toBe("complete")
    expect(reopened.storage.getItem("keep")).toBe("after")
    expect(host.getItem(STAGED_ENVELOPE_STORAGE_KEY)).toBe(null)
  })
})

describe("versioned envelopes and quarantine", () => {
  test("an envelope from an unsupported earlier version is quarantined", async () => {
    const host = scriptableHost()
    host.setItem(ENVELOPE_STORAGE_KEY, JSON.stringify({ version: -1, entries: { earlier: "kept" } }))
    const store = await open(host)
    expect(store.quarantinedKeys).toEqual([`${ENVELOPE_QUARANTINE_PREFIX}unsupported.-1`])
    expect(store.storage.getItem("earlier")).toBe(null)
  })

  test("an envelope from a future version is refused without modifying any host bytes", async () => {
    const host = scriptableHost()
    const future = JSON.stringify({ version: ENVELOPE_VERSION + 41, entries: { "new-shape": "data" } })
    host.setItem(ENVELOPE_STORAGE_KEY, future)
    host.setItem(STAGED_ENVELOPE_STORAGE_KEY, future)
    const before = [...host.data]
    await expect(open(host)).rejects.toBeInstanceOf(UnsupportedStorageEnvelopeError)
    expect([...host.data]).toEqual(before)
  })

  test("every version above this build's refuses open instead of quarantining a copy", async () => {
    // Quarantine only ever labels an older stamp `unsupported`: the version
    // pre-check refuses newer envelopes first, including the one just above.
    for (const version of [ENVELOPE_VERSION + 1, ENVELOPE_VERSION + 2, 99]) {
      const host = scriptableHost()
      host.setItem(ENVELOPE_STORAGE_KEY, JSON.stringify({ version, entries: { newer: "kept" } }))
      const before = [...host.data]
      await expect(open(host)).rejects.toBeInstanceOf(UnsupportedStorageEnvelopeError)
      expect([...host.data]).toEqual(before)
      expect([...host.data.keys()].filter((key) => key.startsWith(ENVELOPE_QUARANTINE_PREFIX))).toEqual([])
    }
  })

  test("a future envelope with a changed payload shape is refused before recovery", async () => {
    const host = scriptableHost()
    host.setItem(ENVELOPE_STORAGE_KEY, JSON.stringify({ version: 1, entries: {} }))
    host.setItem(STAGED_ENVELOPE_STORAGE_KEY, JSON.stringify({ version: 99, nextFormat: ["saved"] }))
    const before = [...host.data]
    await expect(open(host)).rejects.toBeInstanceOf(UnsupportedStorageEnvelopeError)
    expect([...host.data]).toEqual(before)
  })

  test("an unparseable envelope quarantines instead of booting over corrupt bytes", async () => {
    const host = scriptableHost()
    host.setItem(ENVELOPE_STORAGE_KEY, "not an envelope")
    const store = await open(host)
    expect(store.quarantinedKeys).toEqual([`${ENVELOPE_QUARANTINE_PREFIX}corrupt`])
    expect(host.getItem(`${ENVELOPE_QUARANTINE_PREFIX}corrupt`)).toBe("not an envelope")
  })
})

describe("legacy collection adoption", () => {
  const collections = [{ id: "widgets", schema: z.object({ id: z.string(), label: z.string() }) }]
  const key = "smithers-mvp.widgets"
  const valid = { versionKey: "v1", data: { id: "w", label: "saved" } }
  const openLegacy = (host: StorageApi) => openTransactionalStorage(host, { collections })

  test("validates each row and retains original source bytes through adoption and deletion", async () => {
    const host = scriptableHost()
    const raw = JSON.stringify({ "s:w": valid, bad: { versionKey: "v2", data: { id: "bad", label: 42 } }, missingVersion: { data: valid.data } })
    host.setItem(key, raw)
    const store = await openLegacy(host)
    expect(JSON.parse(store.storage.getItem(key)!)).toEqual({ "s:w": valid })
    expect(host.getItem(key)).toBe(raw)
    expect(store.quarantinedKeys).toEqual([`${ROW_QUARANTINE_PREFIX}widgets.bad`, `${ROW_QUARANTINE_PREFIX}widgets.missingVersion`])
    store.storage.removeItem(key)
    expect((await openLegacy(host)).storage.getItem(key)).toBe(null)
    expect(host.getItem(key)).toBe(raw)
  })

  test("a failed migration commit leaves all legacy bytes available for retry", async () => {
    const host = scriptableHost()
    const raw = JSON.stringify({ "s:w": valid })
    host.setItem(key, raw)
    host.crashOnSet = ENVELOPE_STORAGE_KEY
    await expect(openLegacy(host)).rejects.toThrow("crash writing")
    expect(host.getItem(key)).toBe(raw)
    expect(host.getItem(ENVELOPE_STORAGE_KEY)).toBe(null)
    host.crashOnSet = undefined
    const reopened = await openLegacy(host)
    expect(reopened.recovery).toBe("rollback")
    expect(reopened.storage.getItem(key)).toBe(raw)
  })

  test("version zero adopts known keys but a current envelope never resurrects stale keys", async () => {
    const host = scriptableHost()
    host.setItem(key, JSON.stringify({ "s:w": valid }))
    host.setItem(ENVELOPE_STORAGE_KEY, JSON.stringify({ version: 0, entries: { other: "retained" } }))
    const migrated = await openLegacy(host)
    expect(migrated.storage.getItem(key)).toContain("saved")
    expect(migrated.storage.getItem("other")).toBe("retained")
    migrated.storage.removeItem(key)
    expect((await openLegacy(host)).storage.getItem(key)).toBe(null)
  })

  test("validates rows already inside envelopes and rejects malformed entry maps", async () => {
    const host = scriptableHost()
    host.setItem(ENVELOPE_STORAGE_KEY, JSON.stringify({ version: 1, entries: { [key]: JSON.stringify({ invalid: { data: valid.data } }) } }))
    const store = await openLegacy(host)
    expect(store.storage.getItem(key)).toBe("{}")
    expect(store.quarantinedKeys).toContain(`${ROW_QUARANTINE_PREFIX}widgets.invalid`)
    host.setItem(ENVELOPE_STORAGE_KEY, JSON.stringify({ version: 1, entries: { [key]: 42 } }))
    expect((await openLegacy(host)).quarantinedKeys).toContain(`${ENVELOPE_QUARANTINE_PREFIX}corrupt`)
  })

  test("corrupt envelopes remain authoritative if replacement fails", async () => {
    const host = scriptableHost()
    host.setItem(key, JSON.stringify({ "s:w": valid }))
    host.setItem(ENVELOPE_STORAGE_KEY, "corrupt")
    host.crashOnSet = ENVELOPE_STORAGE_KEY
    await expect(openLegacy(host)).rejects.toThrow("crash writing")
    expect(host.getItem(ENVELOPE_STORAGE_KEY)).toBe("corrupt")
    host.crashOnSet = undefined
    expect((await openLegacy(host)).storage.getItem(key)).toBe(null)
  })
})
