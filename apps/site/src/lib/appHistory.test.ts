import assert from "node:assert/strict"
import { test } from "node:test"
import { shouldResumeApp } from "./appHistory"

test("the landing keeps Start Here on ordinary return visits, including finished profiles", () => {
  assert.equal(shouldResumeApp(""), false)
  assert.equal(shouldResumeApp("?tutorial"), true)
})

test("authentication returns still resume the app immediately", () => {
  for (const search of ["?signed-in=github", "?auth=failed", "?auth=error"]) assert.equal(shouldResumeApp(search), true)
})
