import { locks } from "node:worker_threads"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { claimEditorTabId, type EditorTabHost } from "./editorTab"

const KEY = "smithers-flow-editor-tab"
const pages: EventTarget[] = []
const pagehide = (page: EventTarget, persisted = false) => page.dispatchEvent(Object.assign(new Event("pagehide"), { persisted }))
const manager = locks as unknown as LockManager
const host = (storage: EditorTabHost["storage"] = sessionStorage): EditorTabHost => {
  const page = new EventTarget()
  pages.push(page)
  return { storage, locks: manager, page: page as unknown as Window, randomId: () => crypto.randomUUID() }
}

beforeEach(() => sessionStorage.clear())
afterEach(async () => {
  for (const page of pages.splice(0)) pagehide(page)
  await vi.waitFor(async () => expect((await locks.query()).held?.filter((lock) => lock.name?.startsWith(KEY))).toEqual([]))
})

test("reload reclaims the stored identity after the page leaves; back/forward cache keeps the claim", async () => {
  const first = host()
  const claimed = await claimEditorTabId(first)
  expect(claimed.persistent).toBe(true)
  expect(sessionStorage.getItem(KEY)).toBe(claimed.id)
  pagehide(pages[0]!, true)
  expect((await locks.query()).held?.map((lock) => lock.name)).toContain(`${KEY}:${claimed.id}`)
  pagehide(pages[0]!)
  await vi.waitFor(async () => expect((await locks.query()).held).toEqual([]))
  expect(await claimEditorTabId(host())).toEqual(claimed)
})

test("a duplicated live tab receives a distinct persisted identity", async () => {
  const first = await claimEditorTabId(host())
  const second = await claimEditorTabId(host())
  expect(second.persistent).toBe(true)
  expect(second.id).not.toBe(first.id)
  expect(sessionStorage.getItem(KEY)).toBe(second.id)
  expect((await locks.query()).held).toHaveLength(2)
})

test.each(["", "not-a-uuid", "ffffffff-ffff-ffff-ffff-ffffffffffff"])("validates stored identity %j before claiming it", async (stored) => {
  sessionStorage.setItem(KEY, stored)
  const claimed = await claimEditorTabId(host())
  expect(claimed.persistent).toBe(true)
  if (stored === "ffffffff-ffff-ffff-ffff-ffffffffffff") expect(claimed.id).toBe(stored)
  else expect(claimed.id).not.toBe(stored)
  expect(sessionStorage.getItem(KEY)).toBe(claimed.id)
})

test("a generated identity already held by another page refuses persistence", async () => {
  const first = await claimEditorTabId(host())
  sessionStorage.clear()
  expect(await claimEditorTabId({ ...host(), randomId: () => first.id })).toEqual({ id: first.id, persistent: false, reason: "lock_held" })
  expect(sessionStorage.getItem(KEY)).toBeNull()
})

test("missing Web Locks refuses persistence even with a valid stored identity", async () => {
  sessionStorage.setItem(KEY, crypto.randomUUID())
  expect(await claimEditorTabId({ ...host(), locks: undefined })).toMatchObject({ persistent: false, reason: "locks_unavailable" })
})

test("rejected Web Lock requests refuse persistence without rejecting startup", async () => {
  sessionStorage.setItem(KEY, crypto.randomUUID())
  const unavailable: EditorTabHost["locks"] = { request: () => Promise.reject(new Error("locks unavailable")) }
  expect(await claimEditorTabId({ ...host(), locks: unavailable })).toMatchObject({ persistent: false, reason: "lock_refused" })
})

test("unreadable session storage cannot strand edits under a fresh claim", async () => {
  const storage = { getItem: (): string | null => { throw new Error("storage denied") }, setItem: sessionStorage.setItem.bind(sessionStorage) }
  expect(await claimEditorTabId(host(storage))).toMatchObject({ persistent: false, reason: "storage_failed" })
})

test("a refused session-storage write disables persistence", async () => {
  const storage = { getItem: sessionStorage.getItem.bind(sessionStorage), setItem: () => { throw new Error("quota") } }
  expect(await claimEditorTabId(host(storage))).toMatchObject({ persistent: false, reason: "storage_failed" })
  expect(sessionStorage.getItem(KEY)).toBeNull()
})

test("a storage write that cannot be read back disables persistence", async () => {
  const storage = { getItem: () => null, setItem: sessionStorage.setItem.bind(sessionStorage) }
  expect(await claimEditorTabId(host(storage))).toMatchObject({ persistent: false, reason: "storage_unread" })
  expect(sessionStorage.getItem(KEY)).not.toBeNull()
})
