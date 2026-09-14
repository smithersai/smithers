import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { initialGuide } from "../AppState"
import { scopedControllers } from "../ControllerTestScope"
import { memoryStorage, silentAgent, unavailableRepositories } from "../TestFixtures"

const createController = scopedControllers()

test("Connect from tutorial Chat exposes repository actions in the visible transcript and survives reload", async () => {
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  await store.dispatch({ type: "guide.changed", actor: "user", guide: {
    ...initialGuide(), step: 12, conversationOpen: true
  } }).isPersisted.promise
  const controller = createController(store, unavailableRepositories, silentAgent)

  expect((await controller.commands.run("connect")).status).toBe("executed")
  expect(store.session().surface).toBe("chat")
  expect(store.session().guide).toMatchObject({ step: 12, conversationOpen: false })
  expect(store.collections.cards.get("connect-embedded")).toMatchObject({
    kind: "connect", payload: { nativeAvailable: false }
  })
  // Repeating the action refreshes its existing card, without switching to
  // the inaccessible pane or accumulating duplicate repository controls.
  await controller.commands.run("connect")
  expect([...store.collections.cards.values()].filter(card => card.kind === "connect")).toHaveLength(1)
  await store.dispatch({ type: "guide.changed", actor: "user", guide: store.session().guide! }).isPersisted.promise
  const restored = await createAppStore({ kind: "localStorage", storage })
  expect(restored.collections.cards.get("connect-embedded")?.kind).toBe("connect")
  expect(restored.session().guide?.conversationOpen).toBe(false)
})
