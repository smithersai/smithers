import assert from "node:assert/strict"
import test from "node:test"
import { projection, PAGE } from "../gen-cli-reference.mjs"

const page = () => projection().get(PAGE)

test("sd4-missing-5: terminal launch and budgets are published", () => {
  const text = page()
  assert.match(text, /## `tui`/)
  for (const name of ["--budget-tokens", "SMITHERS_TUI_BUDGET_TOKENS", "SMITHERS_TUI_BUDGET_DAILY_TOKENS"]) assert.ok(text.includes(name), name)
})

test("daily token budget guidance names the flag and its precedence", () => {
  const budgets = page().split("### Token budgets\n")[1]?.split("\n## ")[0]
  assert.ok(budgets, "the TUI reference includes token budget guidance")
  assert.match(budgets, /\| `--budget-daily-tokens <n>` or `SMITHERS_TUI_BUDGET_DAILY_TOKENS` \| `2000000000` \| All runs per UTC day on the execution machine \|/)
  assert.match(budgets, /Each flag wins over its corresponding environment variable\./)
})
