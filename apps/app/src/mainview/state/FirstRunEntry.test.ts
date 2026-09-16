import { expect, test } from "bun:test"
import { createAppStore } from "./AppStore"
import { PRACTICE_REPO } from "./practice/PracticeRepository"
import { resolveTargetRepo } from "./RepoContext"

test("signed-out entry selects the practice repository for bare flows", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: (() => { const data = new Map<string, string>(); return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } } })() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, allowlisted: false, admin: false, scopesPlain: null }).isPersisted.promise
  expect(store.session().activeRepoKey).toBe(PRACTICE_REPO)
  expect(resolveTargetRepo(store, undefined)).toEqual({ repo: PRACTICE_REPO })
  await store.dispose?.()
})

test("signed-in entry keeps the existing selection", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: (() => { const data = new Map<string, string>(); return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } } })() })
  const before = store.session().activeRepoKey
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "alice", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  expect(store.session().activeRepoKey).toBe(before)
  await store.dispose?.()
})
