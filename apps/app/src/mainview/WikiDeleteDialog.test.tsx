import { expect, test } from "bun:test"
import { createAppStore } from "./state/AppStore"
import { initialGuide } from "./state/AppState"
import { scopedControllers } from "./state/ControllerTestScope"
import { memoryStorage, silentAgent } from "./state/TestFixtures"
import { pendingWikiDeleteDocument } from "./WikiDeleteDialog"

const createAppController = scopedControllers()

test("the delete question keeps its exact target through cancel and confirm", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, { available: false, pickLocalRepository: async () => ({ status: "cancelled" }) }, silentAgent)
  const note = store.collections.worldDocuments.get("world-home")!
  await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), conversationOpen: true } }).isPersisted.promise
  await controller.commands.run("wiki.delete", note.id)
  expect(pendingWikiDeleteDocument(store.session(), [...store.collections.worldDocuments.values()])?.id).toBe(note.id)
  expect(store.session().guide?.conversationOpen).toBe(false)
  await controller.commands.run("wiki.delete.cancel")
  expect(store.session().pendingWorldDeleteId).toBeNull()
  expect(store.collections.worldDocuments.get(note.id)).toBeDefined()

  await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...store.session().guide!, conversationOpen: true } }).isPersisted.promise
  await controller.commands.runForAgent("wiki.delete", note.id)
  expect(store.session().pendingWorldDeleteId).toBe(note.id)
  expect(store.session().guide?.conversationOpen).toBe(true)
  await controller.commands.run("wiki.delete.cancel")

  await controller.commands.run("wiki.delete", note.id)
  await controller.commands.run("wiki.delete.confirm")
  expect(store.session().pendingWorldDeleteId).toBeNull()
  expect(store.collections.worldDocuments.get(note.id)).toBeUndefined()
})
