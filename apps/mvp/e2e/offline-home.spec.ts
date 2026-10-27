import { expect, test } from "./fixtures"
import { requires, syncedRepository } from "./target"
import { expectOfflineErrors } from "./watch"

requires("syncedRepository")
test("repository home: an unreadable offline home says Offline", async ({ page, context }) => {
  await page.goto(`/${syncedRepository()}`)
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined))
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null)
  expectOfflineErrors()
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByText("Offline", { exact: true }).first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText("Couldn't read home", { exact: true })).toHaveCount(0)
  await context.setOffline(false)
})
