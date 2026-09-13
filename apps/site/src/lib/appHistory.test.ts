import { expect, test } from "bun:test"
import { hasSavedApp } from "./appHistory"

test("the homepage auto-enters for either saved backend and legacy store, but not theme-only visitors", () => {
  for (const key of ["smithers-mvp.persistenceBackend", "smithers-mvp.schemaVersion", "smithers-mvp.store"]) {
    expect(hasSavedApp(name => name === key ? "saved" : null)).toBe(true)
  }
  expect(hasSavedApp(name => name === "smithers-mvp.theme" ? "light" : null)).toBe(false)
  expect(hasSavedApp(() => { throw Error("Storage disabled") })).toBe(false)
})
