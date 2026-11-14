// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
import { expect, test } from "./coverage"
import type { Page } from "./coverage"

// History page inputs that reach the history's own decisions in the browser (wiki/decisions/0016-coverage.md,
// "Actions and history arms in the browser"), on the real mock history.

async function open(page: Page) {
  await page.goto("/history?agent=mock")
  await expect(page.getByRole("button", { name: /The compiler/ })).toBeVisible({ timeout: 20_000 })
}

test.describe("history arms", () => {
  test("a search longer than the history reads is cut between characters, and answers", async ({ page }) => {
    await open(page)
    const filter = page.getByRole("searchbox", { name: "Filter commits" })
    const matches = page.getByRole("list", { name: "Matching commits" })
    // 201 units: cut at 200, where no surrogate pair straddles the cut.
    const plain = "x".repeat(201)
    await filter.fill(plain)
    await expect(matches).toHaveAttribute("aria-busy", "false")
    await expect(matches.getByRole("link")).toHaveCount(0)
    await expect(filter).toHaveValue(plain)
    // 199 units and an emoji: the pair at units 199 and 200 straddles the cut, so the history reads the first 199.
    const paired = "x".repeat(199) + "😀"
    await filter.fill(paired)
    await expect(matches).toHaveAttribute("aria-busy", "false")
    await expect(matches.getByRole("link")).toHaveCount(0)
    await expect(filter).toHaveValue(paired)
  })

  test("an epic opened from the history closes again", async ({ page }) => {
    await open(page)
    const epic = page.getByRole("button", { name: /The compiler/ })
    await epic.click()
    await expect(epic).toHaveAttribute("aria-expanded", "true")
    await expect(page.getByRole("link", { name: "Open epic" })).toBeVisible()
    await epic.click()
    await expect(epic).toHaveAttribute("aria-expanded", "false")
    await expect(page.getByRole("link", { name: "Open epic" })).toHaveCount(0)
  })
})

// The mock history with a fault among the services its own Export runs on (test/support/FaultyMockHistory.vibe), once.
async function openFaulty(page: Page, fault: string) {
  await page.goto(`/e2e/history-runtime/index.html?role=maintainer&fault=${fault}`)
  await expect(page.getByRole("button", { name: /The compiler/ })).toBeVisible({ timeout: 20_000 })
}

test.describe("an export its own check or pace stops", () => {
  const stopped = [
    ["export-reads", "Publishing in the background."],
    ["export-header", "The export failed its check."],
    ["export-ends", "The export failed its check."],
    ["export-notes", "The export failed its check."],
    ["export-manifest", "The export failed its check."],
  ] as const
  for (const [fault, text] of stopped) test(`${fault}: the export says why, and exporting again publishes`, async ({ page }) => {
    await openFaulty(page, fault)
    await page.getByRole("button", { name: "Export", exact: true }).click()
    // One Export holds the page 2 to 5 s unloaded (0016, "Export waits under load").
    await expect(page.getByRole("alert")).toHaveText(text, { timeout: 20_000 })
    await page.getByRole("button", { name: "Export", exact: true }).click()
    await expect(page.getByTitle("Exported")).toHaveText(/^mythical \S{7}$/, { timeout: 20_000 })
    await expect(page.getByRole("alert")).toHaveCount(0)
  })
})
