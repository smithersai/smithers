import { expect, test } from "./fixtures"
import { requires, signedOut, syncedRepository } from "./target"

test.use(signedOut)
test("visitor issue counts settle without requesting private write history", async ({ page }) => {
  requires("syncedRepository")
  const requests: string[] = []
  page.on("request", (request) => requests.push(new URL(request.url()).pathname))
  await page.goto(`/${syncedRepository()}/issues`)
  await expect(page.locator("[data-list-sync]")).toHaveCount(0, { timeout: 60_000 })
  await expect(page.getByText(/\d+ open · \d+ closed/)).toBeVisible()
  expect(requests).not.toContain("/api/shapes/github-writes")
})
