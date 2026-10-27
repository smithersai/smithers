import assert from "node:assert/strict"
import test from "node:test"
import { projection, PAGE } from "../gen-cli-reference.mjs"

const page = () => projection().get(PAGE)

test("sd4-missing-5: terminal launch and budgets are published", () => {
  const text = page()
  assert.match(text, /## `tui`/)
  for (const name of ["--budget-tokens", "SMITHERS_TUI_BUDGET_TOKENS", "SMITHERS_TUI_BUDGET_DAILY_TOKENS"]) assert.ok(text.includes(name), name)
})
