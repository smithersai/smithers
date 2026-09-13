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
  expect(await actions.updateRepo(PRACTICE_REPO)).toEqual({ value: expect.stringContaining("2 issue updates, 1 PR update") })
  const first = [...store.collections.cards.values()].find(card => card.kind === "repo-update")!
  if (first.kind !== "repo-update") throw Error("missing update")
  expect(first.payload.items).toHaveLength(3)
  const restored = await setup(storage)
  expect(await restored.actions.updateRepo(PRACTICE_REPO)).toEqual({ value: expect.stringContaining("No new issue or PR updates") })
  let card = restored.store.collections.cards.get(first.id)!
  if (card.kind !== "repo-update") throw Error("missing update")
  expect(card.payload.items).toHaveLength(3)
  await restored.actions.tagNotification(card.payload.items[0]!.id, "follow-up")
  expect(restored.store.collections.repositoryNotifications.get(card.payload.items[0]!.id)?.tags).toContain("follow-up")
  await restored.actions.markUpdateRead(card.id)
  await restored.actions.updateRepo(PRACTICE_REPO)
  card = restored.store.collections.cards.get(first.id)!
  expect(card.kind === "repo-update" && card.payload.items).toEqual([])
  const row = [...restored.store.collections.repositoryNotifications.values()][0]!
  await restored.store.dispatch({ type: "notifications.read", actor: "user", receipts: [{ id: row.id, version: "stale-version" }] }).isPersisted.promise
  expect(restored.store.collections.repositoryNotifications.get(row.id)?.readVersion).not.toBe("stale-version")
})
test("failed sources are a partial update, never an empty successful check", async () => {
  const { store, actions } = await setup(memoryStorage(), async () => Response.json({ message: "Unavailable" }, { status: 503 }))
  const result = await actions.updateRepo("org/repo")
  expect(result).toEqual({ value: expect.stringContaining("could not be checked") })
  const card = [...store.collections.cards.values()].find(card => card.kind === "repo-update")!
  expect(card.kind === "repo-update" && card.payload.openIssues).toBeNull()
  expect(store.collections.repositoryNotifications.size).toBe(0)
})
