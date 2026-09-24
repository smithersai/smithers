import { expect, test } from "bun:test"
import { CardSchema } from "@smthrs/rpc/Cards"
import { createAppController } from "../AppController"
import { createAppStore } from "../AppStore"

test("PR tabs use the shared flow and survive reload without a network request", async () => {
  const data = new Map<string, string>()
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
    removeItem: (key: string) => { data.delete(key) }
  }
  const store = await createAppStore({ kind: "localStorage", storage })
  const controller = createAppController(store, {
    available: false, startTurn: async () => ({ status: "error", message: "Unavailable" }),
    cancelTurn: async () => {}, subscribe: () => () => {}
  }, { fetchImpl: async () => { throw new Error("Changing a PR tab must not fetch") } })
  const card = CardSchema.parse({ id: "pr-tab", kind: "pr", title: "Fix", status: "active", ordinal: 0, createdAt: 1,
    payload: { repo: "owner/repo", number: 2, title: "Fix", state: "open", author: "owner", prBody: "Fix details", reviews: [], checks: [] } })
  await store.dispatch({ type: "card.upsert", actor: "user", card }).isPersisted.promise
  expect(await controller.commands.run("prs.tab", "pr-tab files")).toMatchObject({ status: "executed" })
  const selected = store.collections.cards.get(card.id)
  expect(selected?.kind === "pr" && selected.payload.tab).toBe("files")
  expect((await controller.commands.run("prs.tab", "pr-tab nonexistent")).status).not.toBe("executed")
  await controller.dispose()
  await store.settled?.()
  await store.dispose?.()
  const restored = await createAppStore({ kind: "localStorage", storage })
  const persisted = restored.collections.cards.get(card.id)
  expect(persisted?.kind === "pr" && persisted.payload.tab).toBe("files")
  await restored.dispose?.()
})
