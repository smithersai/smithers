import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { initialGuide } from "../AppState"
import { memoryStorage } from "../TestFixtures"
import { isPracticeContext, practiceContextMessage } from "./PracticeContext"
import { PRACTICE_REPO } from "./PracticeRepository"

test("a repository boot never primes chat with a seeded or previously started tutorial", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  expect(store.session().guide).toBeDefined()
  expect(isPracticeContext(store)).toBe(false)
  expect(practiceContextMessage(store)).toBeUndefined()
  await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), completed: ["tutorial.started"] } }).isPersisted.promise
  expect(isPracticeContext(store)).toBe(false)
  // A stale practice selection also cannot override the visible repository page.
  store.collections.sessions.update(store.session().id, draft => { draft.activeRepoKey = PRACTICE_REPO })
  expect(practiceContextMessage(store)).toBeUndefined()
})

test("only a mounted, started, unfinished practice beat primes chat", async () => {
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  await store.dispatch({ type: "guide.visibility.changed", actor: "system", visible: true }).isPersisted.promise
  expect(isPracticeContext(store)).toBe(false)
  await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), completed: ["tutorial.started"] } }).isPersisted.promise
  expect(practiceContextMessage(store)).toContain("The repository on screen is practice:")
  const reloaded = await createAppStore({ kind: "localStorage", storage })
  expect(isPracticeContext(reloaded)).toBe(false)
  for (const guide of [
    { ...store.session().guide!, step: 10 },
    { ...store.session().guide!, finished: true },
  ]) {
    await store.dispatch({ type: "guide.changed", actor: "user", guide }).isPersisted.promise
    expect(practiceContextMessage(store)).toBeUndefined()
  }
  await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), completed: ["tutorial.started"] } }).isPersisted.promise
  await store.dispatch({ type: "guide.visibility.changed", actor: "system", visible: false }).isPersisted.promise
  expect(practiceContextMessage(store)).toBeUndefined()
})
