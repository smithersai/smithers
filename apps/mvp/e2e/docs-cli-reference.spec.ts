import { expect, test } from "./fixtures"
import { requires, signedOut } from "./target"

test.use(signedOut)

test("CLI reference: discovery scope and callable local commands agree", async ({ page }) => {
  requires("docsSite")
  await page.goto("/docs/reference/cli/")
  const content = page.locator(".sl-markdown-content")
  await expect(content).toContainText("Install discovery")
  await expect(content).not.toContainText("Every command in")
  await expect(page.getByRole("heading", { name: "agents", exact: true })).toHaveCount(0)
  for (const name of ["change list", "change status", "change files", "change show", "change conflicts", "generate ci", "generate package"]) await expect(page.getByRole("heading", { name, exact: true })).toBeVisible()
})

test("CLI reference: copying a global option description preserves its flag", async ({ page }) => {
  requires("docsSite")
  await page.goto("/docs/reference/cli/")
  const description = page.getByRole("row").filter({ has: page.getByRole("cell", { name: "--ui", exact: true }) })
  await expect(description).toContainText("--silent")
  await expect(description).not.toContainText("–silent")
  await expect(description.locator("code").filter({ hasText: /^--silent$/ })).toHaveCount(1)
})

test("CLI reference: terminal budgets and captured integration help are published", async ({ page }) => {
  requires("docsSite")
  await page.goto("/docs/reference/cli/")
  for (const name of ["tui", "completions", "mcp", "skills"]) await expect(page.getByRole("heading", { name, exact: true })).toBeVisible()
  const content = page.locator(".sl-markdown-content")
  await expect(content).toContainText("SMITHERS_TUI_BUDGET_TOKENS")
  await expect(content).toContainText("SMITHERS_TUI_BUDGET_DAILY_TOKENS")
  await expect(content).toContainText("smthrs completions <bash|fish|nushell|zsh>")
  await expect(content).toContainText("smthrs mcp add")
  await expect(content).toContainText("smthrs skills list")
})
