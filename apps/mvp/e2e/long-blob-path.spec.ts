import { expect, test } from "./fixtures"
import { requires } from "./target"
import { expectServerError } from "./watch"

requires("codeStorage")
test("an overlong file path is absent and stays inside the header", async ({ page }) => {
  expectServerError(404, "/api/repos/smithersai/smithers/blob/*")
  const response = page.waitForResponse(response => new URL(response.url()).pathname.includes("/blob/") && new URL(response.url()).pathname.length > 2400)
  await page.goto(`/smithersai/smithers/blob/main/${"a".repeat(2500)}`)
  expect((await response).status()).toBe(404)
  await expect(page.getByText("File not found at main", { exact: true })).toBeVisible({ timeout: 60_000 })
  const trail = page.locator('.sui-repo-head [data-slot="breadcrumbs"]')
  if (await trail.count() !== 0) {
    const header = await page.locator(".sui-repo-head").boundingBox()
    const box = await trail.boundingBox()
    expect(box!.x + box!.width).toBeLessThanOrEqual(header!.x + header!.width + 1)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})
