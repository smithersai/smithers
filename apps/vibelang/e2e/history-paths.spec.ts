// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
import { expect, test } from "./coverage"
import type { Page } from "./coverage"

// The history page's refusals and its epic page, on the real mock history (wiki/decisions/0020-mythical-history.md).

async function open(page: Page, hash = "") {
  await page.goto(`/history?agent=mock${hash}`)
  await expect(page.getByRole("button", { name: /The compiler/ })).toBeVisible({ timeout: 20_000 })
}

test.describe("the history page's refusals and epic page", () => {
  test("refuses a plan without a title in the page's words, then plans it", async ({ page }) => {
    await open(page)
    await page.getByRole("button", { name: "Plan work" }).click()
    const dialog = page.getByRole("dialog", { name: "Plan work" })
    await dialog.getByLabel("Task").fill("issue 7")
    await dialog.getByRole("button", { name: "Plan work" }).click()
    await expect(dialog.getByRole("alert")).toHaveText("Needs a title.")
    await expect(page).not.toHaveURL(/#m\d+$/)
    await dialog.getByLabel("Commit").fill("fix(compiler): name the refused plan")
    await dialog.getByRole("button", { name: "Plan work" }).click()
    await expect(page.getByRole("heading", { level: 1, name: "fix(compiler): name the refused plan" })).toBeVisible()
    await expect(page.getByRole("alert")).toHaveCount(0)
  })

  test("plans the first commit of a new epic", async ({ page }) => {
    await open(page)
    await page.getByRole("button", { name: "Plan work" }).click()
    const dialog = page.getByRole("dialog", { name: "Plan work" })
    await dialog.getByLabel("Epic").selectOption({ label: "New epic…" })
    await dialog.getByLabel("New epic").fill("Coverage")
    await dialog.getByLabel("Commit").fill("test(coverage): a first journey")
    await dialog.getByRole("button", { name: "Plan work" }).click()
    await expect(page.getByRole("heading", { level: 1, name: "test(coverage): a first journey" })).toBeVisible()
    await page.getByRole("link", { name: "Coverage", exact: true }).click()
    await expect(page.getByRole("heading", { level: 1, name: "Coverage" })).toBeVisible()
    await expect(page.getByRole("list", { name: "Coverage" }).getByRole("link")).toHaveText([/test\(coverage\): a first journey/])
  })

  test("a maintainer exports, files evidence and a superseded note, and plans before a commit", async ({ page }) => {
    await open(page, "&role=maintainer")
    const epic = page.getByRole("button", { name: /The compiler/ })
    await expect(epic).toHaveAttribute("aria-expanded", "false")
    await epic.focus()
    await epic.press("a")
    await expect(epic).toHaveAttribute("aria-expanded", "false")
    await epic.press(" ")
    await expect(epic).toHaveAttribute("aria-expanded", "true")
    await page.getByRole("button", { name: "Export", exact: true }).click()
    await expect(page.getByTitle("Exported")).toHaveText(/^mythical \S{1,7}$/)
    await page.getByRole("list", { name: "The compiler" }).getByRole("link").first().click()
    for (const [section, text] of [["evidence", "A bench run held it."], ["superseded", "A later fold replaced it."]] as const) {
      await page.getByLabel("Section").selectOption(section)
      await page.getByLabel("Note", { exact: true }).fill(text)
      await page.getByRole("button", { name: "Add note" }).click()
      await expect(page.getByText(text)).toBeVisible()
    }
    await page.getByRole("button", { name: "Insert before…" }).click()
    await expect(page.getByRole("dialog").getByText("Before", { exact: true })).toBeVisible()
  })

  test("an open plan keeps naming its commit after the page goes back", async ({ page }) => {
    await open(page, "&role=maintainer")
    await page.getByRole("button", { name: /The compiler/ }).click()
    await page.getByRole("list", { name: "The compiler" }).getByRole("link").first().click()
    await expect(page).toHaveURL(/#m\d+$/)
    const id = new URL(page.url()).hash.slice(1)
    await page.getByRole("button", { name: "Insert before…" }).click()
    const target = page.getByRole("dialog").locator(".mh-mono")
    await expect(target).toHaveText(new RegExp(`^${id} \\S`))
    // The dialog stays open over the list; the commit it plans before is still named, by its id.
    await page.goBack()
    await expect(page).not.toHaveURL(/#m\d+$/)
    await expect(target).toHaveText(id)
  })

  test("opens an epic's page from a commit's crumb, and from its address", async ({ page }) => {
    await open(page)
    await page.getByRole("button", { name: /The compiler/ }).click()
    await page.getByRole("list", { name: "The compiler" }).getByRole("link").first().click()
    await page.getByRole("link", { name: "The compiler", exact: true }).click()
    await expect(page).toHaveURL(/#e\d+$/)
    const epic = new URL(page.url()).hash
    await expect(page.getByRole("heading", { level: 1, name: "The compiler" })).toBeVisible()
    await expect(page.locator(".mh-meta .sui-badge").first()).toHaveText(/^\d+ commits$/)
    await expect(page.getByRole("list", { name: "The compiler" }).getByRole("link")).toHaveCount(50)

    await page.goto(`/history?agent=mock${epic}`)
    await expect(page.getByRole("heading", { level: 1, name: "The compiler" })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole("list", { name: "The compiler" }).getByRole("link")).toHaveCount(50)
  })
})
