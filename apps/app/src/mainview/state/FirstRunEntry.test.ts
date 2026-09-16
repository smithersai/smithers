import { selectFirstRunRepository } from "./FirstRunRepository"
import { expect,test } from "bun:test"
import { createAppStore } from "./AppStore"
import { PRACTICE_REPO } from "./practice/PracticeRepository"
import { resolveTargetRepo } from "./RepoContext"

test("signed-out entry selects the practice repository for bare flows", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: (() => { const data = new Map<string, string>(); return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } } })() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, allowlisted: false, admin: false, scopesPlain: null }).isPersisted.promise
  selectFirstRunRepository(store)
  expect(store.session().activeRepoKey).toBe(PRACTICE_REPO)
  expect(resolveTargetRepo(store, undefined)).toEqual({ repo: PRACTICE_REPO })
  await store.dispose?.()
})

test("signed-in entry keeps the existing selection", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: (() => { const data = new Map<string, string>(); return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } } })() })
  const before = store.session().activeRepoKey
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  selectFirstRunRepository(store)
  expect(store.session().activeRepoKey).toBe(before)
  await store.dispose?.()
})

test("a legacy v3 guide session loads with unknown lesson fields stripped", async () => {
  const { SessionSchema, initialSession } = await import("./AppState")
  const legacy = { ...initialSession("dark"), guide: { version: 3, step: 7, completed: ["tutorial.started"], conversationOpen: false }, guideVisible: true }
  const session = SessionSchema.parse(legacy)
  expect(session.theme).toBe("dark")
  expect("guide" in session).toBe(false)
  expect("guideVisible" in session).toBe(false)
  expect(session.firstRunDismissed).toBeUndefined()
})

test("the persisted legacy session loads without replaying lessons", async () => {
  const { memoryStorage, writeLegacyCollection } = await import("./TestFixtures")
  const { initialSession } = await import("./AppState")
  const storage = memoryStorage()
  const legacy = { ...initialSession("dark"), guide: { version: 3, step: 7, finished: false } }
  writeLegacyCollection(storage, "app-sessions", [legacy])
  const store = await createAppStore({ kind: "localStorage", storage })
  expect(store.session().theme).toBe("dark")
  expect("guide" in store.session()).toBe(false)
  expect(store.collections.cards.size).toBe(0)
  await store.dispose?.()
})
