import { expect, test } from "bun:test"
import { sidebarShortcut } from "./SessionNavigation"
import { createAppStore } from "./state/AppStore"

const key = (fields: Record<string, unknown> = {}) => ({ key: "w", ...fields }) as unknown as KeyboardEvent

test("W toggles navigation without taking typing or command chords", () => {
  expect(sidebarShortcut(key())).toBe(true)
  expect(sidebarShortcut(key({ key: "W" }))).toBe(true)
  for (const field of ["repeat", "isComposing", "metaKey", "ctrlKey", "altKey", "shiftKey"]) expect(sidebarShortcut(key({ [field]: true }))).toBe(false)
  expect(sidebarShortcut(key({ key: "x" }))).toBe(false)
  expect(sidebarShortcut(key({ target: { closest: () => ({}) } }))).toBe(false)
})

test("sidebar state uses persisted transitions but each launch starts closed", async () => {
  const data = new Map<string, string>()
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } }
  const store = await createAppStore({ kind: "localStorage", storage })
  expect(store.session().sidebarOpen).toBe(false)
  await store.dispatch({ type: "sidebar.toggled", actor: "user", open: true }).isPersisted.promise
  expect(store.session().sidebarOpen).toBe(true)
  await store.dispose?.()
  const reloaded = await createAppStore({ kind: "localStorage", storage })
  expect(reloaded.session().sidebarOpen).toBe(false)
  await reloaded.dispatch({ type: "sidebar.toggled", actor: "smithers", open: true }).isPersisted.promise
  expect(reloaded.session().sidebarOpen).toBe(true)
  await reloaded.dispose?.()
})
