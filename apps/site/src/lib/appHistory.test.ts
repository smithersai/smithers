import assert from "node:assert/strict"
import { test } from "node:test"
import { hasSavedApp } from "./appHistory"

test("the homepage auto-enters for either saved backend and legacy store, but not theme-only visitors", () => {
  for (const key of ["smithers-mvp.persistenceBackend", "smithers-mvp.schemaVersion", "smithers-mvp.store"]) {
    assert.equal(hasSavedApp(name => name === key ? "saved" : null), true)
  }
  assert.equal(hasSavedApp(name => name === "smithers-mvp.theme" ? "light" : null), false)
  assert.equal(hasSavedApp(() => { throw Error("Storage disabled") }), false)
})
