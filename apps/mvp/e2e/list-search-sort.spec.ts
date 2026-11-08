import { expect, test } from "./fixtures"
import { requires } from "./target"

for (const list of ["issues", "pulls"]) {
  test(`${list}: search and sort are shareable and survive reload`, async ({ page }, testInfo) => {
    requires("githubApp")
    if (list === "pulls") await page.addInitScript(() => {
      // Only readiness flags: no repository, rows, searches or person content.
      let previous = ""
      const record = () => {
        const screen = document.querySelector('main.pulls-screen[data-list-ready]')
        if (screen === null) return
        const receipt = JSON.stringify(Object.fromEntries(
          ["access-status", "access-installed", "pull-status", "pull-installed", "query-ready", "sync-complete", "list-ready"]
            .map(key => [key, screen.getAttribute(`data-${key}`)]),
        ))
        if (receipt !== previous) console.info("pulls.list.readiness", receipt)
        previous = receipt
      }
      addEventListener("DOMContentLoaded", () => {
        record()
        new MutationObserver(record).observe(document.body, { subtree: true, childList: true, attributes: true,
          attributeFilter: ["data-access-status", "data-access-installed", "data-pull-status", "data-pull-installed", "data-query-ready", "data-sync-complete", "data-list-ready"],
        })
      })
    })
    await page.goto(`/smithersai/smithers/${list}`)
    await expect(page.locator('[data-slot="issues-row"]').first()).toBeVisible({ timeout: 60_000 })
    const title = await page.locator('.sui-issues-title').first().innerText()
    await page.getByRole("textbox", { name: `Search ${list}` }).fill(title)
    await page.getByRole("combobox", { name: "Sort", exact: true }).selectOption("oldest")
    await expect(page).toHaveURL(/sort=oldest/)
    await page.reload()
    await expect(page.getByRole("textbox", { name: `Search ${list}` })).toHaveValue(title)
    await expect(page.getByRole("combobox", { name: "Sort", exact: true })).toHaveValue("oldest")
    await expect(page.locator('.sui-issues-title').first()).toHaveText(title)
    await page.getByRole("textbox", { name: `Search ${list}` }).fill("bugbash3-bb2-lists-no-matching-issue")
    await expect(page).toHaveURL(/q=bugbash3-bb2-lists-no-matching-issue/)
    await expect(page.locator('[data-slot="issues-row"]')).toHaveCount(0)
    if (list === "pulls") {
      const screen = page.getByRole("main", { name: "Pull requests", exact: true })
      try {
        // Wait on the unmatched search itself: a cached matching row proves no completion.
        await expect(screen.getByRole("search", { name: "Search pulls", exact: true })).toBeVisible()
        await expect(screen.locator("[data-list-sync]"), "the pull list finished applying its authoritative projection").toHaveCount(0, { timeout: 60_000 })
      } finally {
        const receipt = await screen.evaluate(element => Object.fromEntries(
          ["access-status", "access-installed", "pull-status", "pull-installed", "query-ready", "sync-complete", "list-ready"]
            .map(key => [key, element.getAttribute(`data-${key}`)]),
        )).catch(() => ({ unavailable: true }))
        await testInfo.attach("pull-list-readiness", { body: JSON.stringify(receipt), contentType: "application/json" })
      }
    }
    await expect(page.getByText(list === "issues" ? "No issues" : "No pull requests", { exact: true })).toBeVisible()
  })
}
