import { expect, test } from "./fixtures"
import { requires } from "./target"
import { expectOfflineErrors } from "./watch"

requires("member")
test("queue: cached contents stay qualified while offline and recover online", async ({ page, context }) => {
  await page.goto("/app/queue")
  await expect(page.getByRole("heading", { name: "Queue", exact: true })).toBeVisible()
  expectOfflineErrors()
  await context.setOffline(true)
  await expect(page.getByRole("status", { name: "Connection" })).toContainText("Offline")
  await context.setOffline(false)
  await expect(page.getByRole("status", { name: "Connection" })).not.toContainText("Offline", { timeout: 30_000 })
})
