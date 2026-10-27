import { expect, test } from "./fixtures"
import { requires, signedOut } from "./target"

test.use(signedOut)

test("chat command reference: core and plugin commands show arguments and roles", async ({ page }) => {
  requires("docsSite")
  await page.goto("/docs/commands/")
  await expect(page.getByRole("heading", { level: 1, name: "Chat commands" })).toBeVisible()
  for (const command of ["branch.new", "branch.update", "branch.resync", "flow.new", "flow.run", "issue.commitment", "todo.drop", "todo.issue", "triage", "triage.run", "triage.enable", "triage.pause", "navigate", "queue", "bug", "bugs"]) {
    await expect(page.getByRole("cell", { name: `/${command}`, exact: true })).toHaveCount(1)
  }
  await expect(page.getByRole("row").filter({ has: page.getByRole("cell", { name: "/issue.commitment", exact: true }) })).toContainText("Maintainer")
})
