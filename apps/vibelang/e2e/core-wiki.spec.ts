// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
// Saves through the mock's real fixture repository (src/core/WikiFactory.vibe, fixtureVerdict in wikiPageDecision.vibe),
// with no fault: what the repository itself refuses, a no-op save the page stops first, and a second change.
import { expect, test } from "./coverage"
import type { Page } from "./coverage"

const wiki = (page: Page) => page.getByRole("region", { name: "Wiki", exact: true })

async function editHome(page: Page) {
  await page.goto("/?agent=mock")
  await page.getByRole("combobox", { name: "Visit as" }).selectOption("maintainer")
  await page.getByRole("button", { name: "Wiki", exact: true }).click()
  await wiki(page).getByRole("button", { name: "Edit", exact: true }).click()
  const editor = wiki(page).getByRole("textbox", { name: "Edit Home" })
  await expect(editor).toBeFocused()
  return editor
}

test("the repository refuses a blank page and the page names it", async ({ page }) => {
  const editor = await editHome(page)
  await editor.fill("   \n")
  await wiki(page).getByRole("button", { name: "Save", exact: true }).click()
  await expect(wiki(page).locator(".vl-wiki-edit-error")).toContainText("Couldn't save. Retry.")
  await expect(editor).toBeVisible()
  await expect(wiki(page).getByRole("link", { name: "Review", exact: true })).toHaveCount(0)
})

test("a save that changes nothing stops on the page", async ({ page }) => {
  const editor = await editHome(page)
  const source = await editor.inputValue()
  await wiki(page).getByRole("button", { name: "Save", exact: true }).click()
  await expect(wiki(page).locator(".vl-wiki-edit-error")).toHaveText("No changes.")
  await expect(editor).toHaveValue(source)
  await expect(wiki(page).getByRole("link", { name: "Review", exact: true })).toHaveCount(0)
})

test("a second change opens its own review", async ({ page }) => {
  const editor = await editHome(page)
  const source = await editor.inputValue()
  await editor.fill(source + "\nFirst change.\n")
  await wiki(page).getByRole("button", { name: "Save", exact: true }).click()
  const review = wiki(page).getByRole("link", { name: "Review", exact: true })
  await expect(review).toHaveAttribute("href", /\/pull\/1001$/)
  await wiki(page).getByRole("button", { name: "Edit", exact: true }).click()
  await expect(editor).toHaveValue(source)
  await editor.fill(source + "\nSecond change.\n")
  await wiki(page).getByRole("button", { name: "Save", exact: true }).click()
  await expect(review).toHaveAttribute("href", /\/pull\/1002$/)
})
