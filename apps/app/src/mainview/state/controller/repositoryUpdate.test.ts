import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { memoryStorage } from "../TestFixtures"
import { createRepositoryUpdate } from "./repositoryUpdate"
import type { SeamContext } from "../seams/SeamContext"
import { PRACTICE_REPO } from "../practice/PracticeRepository"
async function setup(storage = memoryStorage(), http: SeamContext["http"] = async () => { throw new Error("offline") }) {
  const store = await createAppStore({ kind: "localStorage", storage })
  const ctx: SeamContext = { store, dispatch: store.dispatch, actor: () => "user", nextOrdinal: () => 1, baseUrl: "", http }
  return { store, actions: createRepositoryUpdate(ctx), storage }
}
test("repository update receipts survive reload; refresh preserves unread items and read is version-specific", async () => {
  const { store, actions, storage } = await setup()
  expect(await actions.showRepoOverview(PRACTICE_REPO)).toEqual({ value: expect.stringContaining("2 issue updates, 1 PR update") })
  const first = [...store.collections.cards.values()].find(card => card.kind === "repo-update")!
  if (first.kind !== "repo-update") throw Error("missing update")
  expect(first.payload.items).toHaveLength(3)
  const restored = await setup(storage)
  expect(await restored.actions.showRepoOverview(PRACTICE_REPO)).toEqual({ value: expect.stringContaining("No new issue or PR updates") })
  let card = restored.store.collections.cards.get(first.id)!
  if (card.kind !== "repo-update") throw Error("missing update")
  expect(card.payload.items).toHaveLength(3)
  await restored.actions.tagNotification(card.payload.items[0]!.id, "follow-up")
  expect(restored.store.collections.repositoryNotifications.get(card.payload.items[0]!.id)?.tags).toContain("follow-up")
  await restored.actions.markUpdateRead(card.id)
  await restored.actions.showRepoOverview(PRACTICE_REPO)
  card = restored.store.collections.cards.get(first.id)!
  expect(card.kind === "repo-update" && card.payload.items).toEqual([])
  const row = [...restored.store.collections.repositoryNotifications.values()][0]!
  await restored.store.dispatch({ type: "notifications.read", actor: "user", receipts: [{ id: row.id, version: "stale-version" }] }).isPersisted.promise
  expect(restored.store.collections.repositoryNotifications.get(row.id)?.readVersion).not.toBe("stale-version")
})
test("failed sources are a partial update, never an empty successful check", async () => {
  const { store, actions } = await setup(memoryStorage(), async () => Response.json({ message: "Unavailable" }, { status: 503 }))
  const result = await actions.showRepoOverview("org/repo")
  expect(result).toEqual({ value: expect.stringContaining("could not be checked") })
  const card = [...store.collections.cards.values()].find(card => card.kind === "repo-update")!
  expect(card.kind === "repo-update" && card.payload.openIssues).toBeNull()
  expect(store.collections.repositoryNotifications.size).toBe(0)
})


test("background reads persist observations without announcing or displaying them", async () => {
  const { store, actions, storage } = await setup()
  const result = await actions.updateRepo(PRACTICE_REPO)
  expect(typeof result).toBe("object")
  const data = JSON.parse((result as { value: string }).value)
  expect(data).toMatchObject({ repo: PRACTICE_REPO, openIssues: 2, openPrs: 1, problems: [] })
  expect(data.items.some((item: { number: number; kind: string }) => item.kind === "issue" && item.number === 3)).toBe(true)
  expect(store.collections.cards.size).toBe(0)
  expect(store.collections.messages.size).toBe(0)
  expect([...store.collections.repositoryNotifications.values()].every(row => row.announcedVersion === undefined)).toBe(true)
  const restored = await setup(storage)
  expect([...restored.store.collections.repositoryContexts.values()][0]?.data).toEqual(data)
  await restored.actions.showRepoOverview(PRACTICE_REPO)
  const overview = [...restored.store.collections.cards.values()][0]
  expect(overview?.kind === "repo-update" && overview.payload.items).toHaveLength(3)
  await restored.actions.updateRepo(PRACTICE_REPO)
  expect([...restored.store.collections.cards.values()]).toEqual([overview])
})
