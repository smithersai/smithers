import { expect, test } from "bun:test"
import { modeShortcut, sidebarShortcut } from "./SessionNavigation"
import { createAppStore } from "./state/AppStore"

const key = (fields: Record<string, unknown> = {}) => ({ key: "w", ...fields }) as unknown as KeyboardEvent

test("W toggles navigation without taking typing or command chords", () => {
  expect(sidebarShortcut(key())).toBe(true)
  expect(sidebarShortcut(key({ key: "W" }))).toBe(true)
  for (const field of ["repeat", "isComposing", "metaKey", "ctrlKey", "altKey", "shiftKey"]) expect(sidebarShortcut(key({ [field]: true }))).toBe(false)
  expect(sidebarShortcut(key({ key: "x" }))).toBe(false)
  expect(sidebarShortcut(key({ target: { closest: () => ({}) } }))).toBe(false)
})

test("Mode uses bare M, preserves editing, and never uses the old direct dictation chord", () => {
  expect(modeShortcut(key({ key: "m" }))).toBe(true)
  expect(modeShortcut(key({ key: "M" }))).toBe(true)
  expect(modeShortcut(key({ key: "d", metaKey: true }))).toBe(false)
  for (const field of ["repeat", "isComposing", "metaKey", "ctrlKey", "altKey", "shiftKey"]) expect(modeShortcut(key({ key: "m", [field]: true }))).toBe(false)
  expect(modeShortcut(key({ key: "m", target: { closest: () => ({}) } }))).toBe(false)
})

test("sidebar state uses persisted transitions but each launch starts closed", async () => {
  const data = new Map<string, string>()
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } }
  const store = await createAppStore({ kind: "localStorage", storage })
  expect(store.session().sidebarOpen).not.toBe(true)
  await store.dispatch({ type: "sidebar.toggled", actor: "user", open: true }).isPersisted.promise
  expect(store.session().sidebarOpen).toBe(true)
  await store.dispose?.()
  const reloaded = await createAppStore({ kind: "localStorage", storage })
  expect(reloaded.session().sidebarOpen).toBe(false)
  await reloaded.dispatch({ type: "sidebar.toggled", actor: "smithers", open: true }).isPersisted.promise
  expect(reloaded.session().sidebarOpen).toBe(true)
  await reloaded.dispose?.()
})
