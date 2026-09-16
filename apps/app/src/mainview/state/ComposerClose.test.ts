import { expect,test } from "bun:test"
import { createAppStore } from "./AppStore"
import { memoryStorage } from "./TestFixtures"

test("an open palette never restores on boot: the composer is summoned (Command-K), never persisted open", async () => {
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  await store.dispatch({ type: "palette.toggled", actor: "user", open: true }).isPersisted.promise
  await store.dispatch({ type: "palette.actions.toggled", actor: "user", ref: "flow:wiki" }).isPersisted.promise
  expect(store.session().paletteOpen).toBe(true)
  expect(store.session().paletteActionsRef).toBe("flow:wiki")
  const reloaded = await createAppStore({ kind: "localStorage", storage })
  expect(reloaded.session().paletteOpen).toBe(false)
  expect(reloaded.session().paletteActionsRef).toBeNull()
})
