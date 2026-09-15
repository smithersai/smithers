import { expect, test } from "bun:test"
import { createAppStore } from "./AppStore"
import { memoryStorage } from "./TestFixtures"

test("boot closes a persisted palette through a system-owned transition", async () => {
  const storage = memoryStorage()
  const first = await createAppStore({ kind: "localStorage", storage })
  await first.dispatch({ type: "palette.toggled", actor: "user", open: true }).isPersisted.promise
  expect(first.session().paletteOpen).toBe(true)

  const reloaded = await createAppStore({ kind: "localStorage", storage })
  expect(reloaded.session().paletteOpen).toBe(false)
  expect([...reloaded.collections.transitions.values()].at(-1)).toMatchObject({
    actor: "system",
    type: "palette.toggled"
  })
})
