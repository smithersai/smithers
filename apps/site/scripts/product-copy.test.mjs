import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
const source = (path) => readFileSync(new URL(`../../mvp/${path}`, import.meta.url), "utf8")
test("model settings names each tier's job beside its field", () => {
  const view = source("src/features/personal-model/components/PersonalModelSettings.tsx")
  assert.match(view, /TIER_PURPOSE\[tier\]/)
  const copy = source("src/features/personal-model/copy.ts")
  assert.match(copy, /fast: "Chat"/)
  assert.match(copy, /implement: "Coding"/)
  assert.match(copy, /hard: "Plans and reviews"/)
})
test("issue scheduling filters use product words with a visible group label", () => {
  const view = source("src/screens/issues/IssuesScreen.tsx")
  assert.match(view, /aria-label="Schedule"/)
  assert.match(view, />Schedule<\/span>/)
  const copy = source("src/features/issues/lifecycle.ts")
  assert.match(copy, /none: "Unscheduled"/)
})
