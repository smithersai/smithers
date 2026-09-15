import { expect, test } from "bun:test"
import { createAppStore } from "./AppStore"
import { memoryStorage } from "./TestFixtures"
import { createIssuesSeam } from "./seams/IssuesSeam"
import { createLandingsSeam } from "./seams/LandingsSeam"
import { PRACTICE_CARD, PRACTICE_REPO } from "./practice/PracticeRepository"
import type { SeamContext } from "./seams/SeamContext"

test("issue navigation stays in one durable frame, supports back/forward, and forks forward history", async () => {
  const storage = memoryStorage()
  let store = await createAppStore({ kind: "localStorage", storage })
  let ordinal = 0
  let ctx: SeamContext = { store, dispatch: store.dispatch, actor: () => "user", nextOrdinal: () => ++ordinal, baseUrl: "", http: async () => { throw new Error("practice must stay offline") } }
  let issues = createIssuesSeam(ctx)
  await issues.listIssues("open", PRACTICE_REPO)
  const before = store.collections.cards.get(PRACTICE_CARD.issues)!
  await issues.viewIssue(3, PRACTICE_REPO)
  const after = store.collections.cards.get(before.id)!
  expect(after.kind).toBe("issue")
  expect(after.ordinal).toBe(before.ordinal)
  expect(after.createdAt).toBe(before.createdAt)
  expect(store.collections.cards.size).toBe(1)
  expect(after.navigation).toEqual({ index: 1, length: 2 })
  await issues.viewIssue(3, PRACTICE_REPO)
  expect(store.collections.cardHistories.get(before.id)?.entries).toHaveLength(2)
  await store.dispatch({ type: "card.history.moved", actor: "user", id: before.id, delta: -1 }).isPersisted.promise
  expect(store.collections.cards.get(before.id)?.kind).toBe("issue-list")
  await store.dispose?.()
  const restored = await createAppStore({ kind: "localStorage", storage })
  expect(restored.collections.cards.get(before.id)?.kind).toBe("issue-list")
  await restored.dispatch({ type: "card.history.moved", actor: "user", id: before.id, delta: 1 }).isPersisted.promise
  expect(restored.collections.cards.get(before.id)?.kind).toBe("issue")
  store = restored
  ctx = { ...ctx, store, dispatch: store.dispatch }
  issues = createIssuesSeam(ctx)
  await store.dispatch({ type: "card.history.moved", actor: "user", id: before.id, delta: -1 }).isPersisted.promise
  await issues.viewIssue(2, PRACTICE_REPO)
  expect(store.collections.cardHistories.get(before.id)?.entries).toHaveLength(2)
  const fork = store.collections.cards.get(before.id)
  expect(fork?.kind === "issue" && fork.payload.number).toBe(2)
  const prior = JSON.stringify(fork)
  expect(await issues.viewIssue(999, PRACTICE_REPO)).toContain("No issue")
  expect(JSON.stringify(store.collections.cards.get(before.id))).toBe(prior)
  /* One web pane per repository: a PR detail navigates the same frame, it does not append a card. */
  await createLandingsSeam(ctx).viewLanding(4, PRACTICE_REPO)
  expect(store.collections.cards.size).toBe(1)
  expect(store.collections.cards.get(before.id)?.kind).toBe("pr")
  await store.dispose?.()
})
