import { expect, test } from "./fixtures"
import { faultyApp, faults } from "./faults"
import { requires, signedOut, syncedRepository } from "./target"
import { expectConsoleError, expectServerError } from "./watch"

test.use(signedOut)
test("an unsynced repository offers its issues source instead of indefinite syncing", async ({ page }) => {
  expectServerError(503, "/api/repos/rust-lang/rust/*")
  expectConsoleError("Failed to load resource: the server responded with a status of 503*")
  await page.goto("/rust-lang/rust/issues")
  await expect(page.getByRole("link", { name: /GitHub/ })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText("Syncing issues…", { exact: true })).toHaveCount(0)
})

test("an unavailable issue list explains the failure and recovers through Try again", async ({ page }) => {
  requires("faults", "syncedRepository")
  await page.goto(faultyApp("refuse-503").replace("/app", `/${syncedRepository()}/issues`))
  await expect(page.getByText("Issues unavailable", { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole("link", { name: "Open on GitHub ↗", exact: true })).toBeVisible()
  await expect(page.getByText("Syncing issues…", { exact: true })).toHaveCount(0)
  await faults(page).shapes.heal()
  await page.getByRole("button", { name: "Try again", exact: true }).click()
  await expect(page.locator("[data-list-sync]")).toHaveCount(0, { timeout: 60_000 })
  await expect(page.getByText(/\d+ open · \d+ closed/)).toBeVisible()
})
