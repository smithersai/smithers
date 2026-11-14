// Stays .ts: Playwright collects browser tests by JS/TS extension only.
// Wiki answers that arrive after the person moved on. The faulty Factory (test/support/FaultyFactory.vibe) holds the
// editor's page read or the save until the page releases it; `faulted` in the page's snapshot turns true as it ends.
import { expect, test, type Page } from "./coverage"

const port = Number(process.env.E2E_PORT ?? 4173)
const wiki = (page: Page) => page.getByRole("region", { name: "Wiki", exact: true })

async function open(page: Page, fault: string) {
  await page.goto(`http://127.0.0.1:${port}/e2e/runtime/index.html?fault=${fault}`)
  await page.getByRole("combobox", { name: "Visit as" }).selectOption("maintainer")
  await expect(page.locator(".vl-nav-role")).toHaveText("Maintainer")
  await page.getByRole("button", { name: "Wiki", exact: true }).click()
}

async function released(page: Page) {
  await page.evaluate(() => (window as unknown as { recovery: { release(): Promise<void> } }).recovery.release())
  await expect.poll(() => page.evaluate(() => (window as unknown as { recovery: { snapshot(): { faulted: boolean } } }).recovery.snapshot().faulted)).toBe(true)
  // The held answer's message is dispatched within a task of `faulted`; two frames later the page has rendered it.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
}

for (const fault of ["held-wiki-read", "held-wiki-read-failed"]) {
  test(`an editor read that ends after Cancel (${fault === "held-wiki-read" ? "with the page" : "failed"}) leaves the editor closed`, async ({ page }) => {
    await open(page, fault)
    await wiki(page).getByRole("button", { name: "Edit", exact: true }).click()
    const editor = wiki(page).getByRole("textbox", { name: "Edit Home" })
    await expect(editor).toBeVisible()
    await wiki(page).getByRole("button", { name: "Cancel", exact: true }).click()
    await expect(editor).toHaveCount(0)
    await released(page)
    await expect(editor).toHaveCount(0)
    await expect(wiki(page).getByRole("alert")).toHaveCount(0)
    await wiki(page).getByRole("button", { name: "Edit", exact: true }).click()
    await expect(editor).toBeFocused()
  })
}

test("a failed editor read says so in the editor", async ({ page }) => {
  await open(page, "held-wiki-read-failed")
  await wiki(page).getByRole("button", { name: "Edit", exact: true }).click()
  const editor = wiki(page).getByRole("textbox", { name: "Edit Home" })
  await expect(editor).toBeVisible()
  await released(page)
  await expect(wiki(page).getByRole("alert")).toBeVisible()
})

test("Edit elsewhere during a save returns to the saving page; a save that lands after a role change leaves no editor", async ({ page }) => {
  await open(page, "held-wiki-save")
  await wiki(page).getByRole("link", { name: "Roadmap", exact: true }).first().click()
  await wiki(page).getByRole("button", { name: "Edit", exact: true }).click()
  const editor = wiki(page).getByRole("textbox", { name: "Edit Roadmap" })
  await expect(editor).toBeFocused()
  await editor.fill(`${await editor.inputValue()}\nHeld save.\n`)
  await wiki(page).getByRole("button", { name: "Save", exact: true }).click()
  await expect(editor).toBeDisabled()
  // Back leaves the saving page; the editor waits for its save.
  await page.goBack()
  await expect(editor).toHaveCount(0)
  await wiki(page).getByRole("button", { name: "Edit", exact: true }).click()
  await expect(editor).toHaveValue(/Held save\./)
  await page.getByRole("combobox", { name: "Visit as" }).selectOption("contributor")
  await expect(page.locator(".vl-nav-role")).toHaveText("Contributor")
  await expect(editor).toHaveCount(0)
  await released(page)
  await expect(editor).toHaveCount(0)
  await expect(wiki(page).getByRole("link", { name: "Review", exact: true })).toHaveCount(0)
})
