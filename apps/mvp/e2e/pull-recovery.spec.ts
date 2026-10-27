import { expect, test } from "./fixtures"
import { requires } from "./target"

requires("githubSignIn")

test("pull detail: readable GitHub PRs recover without a false Not found", async ({ page }) => {
  for (const path of ["/smithersai/smithers/pull/3723", "/roninjin10/smithers-github-tests/pull/23"]) {
    await page.addInitScript(() => {
      const seen: string[] = []
      Object.assign(window, { __falseMissing: seen })
      addEventListener("DOMContentLoaded", () => new MutationObserver(() => {
        if ([...document.querySelectorAll("main h1,main h2,main h3")].some((el) => el.textContent === "Not found")) seen.push(location.pathname)
      }).observe(document.body, { childList: true, subtree: true }))
    })
    await page.goto(path)
    await expect(page.getByRole("navigation", { name: "Pull request", exact: true })).toBeVisible({ timeout: 90_000 })
    expect(await page.evaluate(() => (window as unknown as { __falseMissing: string[] }).__falseMissing)).toEqual([])
    await expect(page.getByText("Not found", { exact: true })).toHaveCount(0)
  }
})
