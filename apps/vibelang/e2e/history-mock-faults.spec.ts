// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
import { expect, test } from "./coverage"
import type { Page } from "./coverage"

// The history page over the mock history with a fault among the services its own flows run on
// (e2e/history-runtime, test/support/FaultyMockHistory.vibe): a faulty main, repository or export target, once, then
// the real one. Fold's and Export's failure paths run in the mock's flows, where FaultyMythical's faults never reach.

const UNREACHABLE = "The history can't be reached."

async function open(page: Page, fault: string) {
  await page.goto(`/e2e/history-runtime/index.html?role=maintainer&fault=${fault}`)
  await expect(page.getByRole("button", { name: /The compiler/ })).toBeVisible({ timeout: 20_000 })
}

test.describe("the history page when what the mock history runs on fails", () => {
  test("a failed read of main says so, and Fold then folds main", async ({ page }) => {
    await open(page, "main-read")
    await page.getByRole("button", { name: "Fold" }).click()
    await expect(page.getByRole("alert")).toHaveText(UNREACHABLE)
    await page.getByRole("button", { name: "Fold" }).click()
    await expect(page.locator(".sui-badge[title='Folded through']")).toContainText("47422f47d257")
    await expect(page.getByRole("alert")).toHaveCount(0)
  })

  const refused = [
    ["export-empty", "Nothing to export."],
    ["export-paced", "Publishing in the background."],
    ["export-prepare", UNREACHABLE],
    ["export-check", UNREACHABLE],
    ["export-publish", UNREACHABLE],
    ["export-confirm", UNREACHABLE],
    ["export-linear", "The export failed its check."],
    ["export-tree", "The export failed its check."],
    ["export-lost", UNREACHABLE],
    ["export-conflict", "The refs moved. Export again."],
  ] as const
  // One Export holds the page's main thread 2.3 s to 5.1 s on an unloaded box (0016), past expect's 5 s default under
  // load: all ten of these failed in a gate that ran 1.6 h, and passed alone (0016 session 39).
  const exporting = { timeout: 20_000 }
  for (const [fault, text] of refused) test(`${fault}: the export says why, and exporting again publishes`, async ({ page }) => {
    await open(page, fault)
    const exported = page.getByTitle("Exported")
    await page.getByRole("button", { name: "Export", exact: true }).click()
    await expect(page.getByRole("alert")).toHaveText(text, exporting)
    await page.getByRole("button", { name: "Export", exact: true }).click()
    await expect(exported).toHaveText(/^mythical \S{7}$/, exporting)
    await expect(page.getByRole("alert")).toHaveCount(0)
  })
})
