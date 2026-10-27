import { expect, test } from "./fixtures"
import { requires } from "./target"

requires("codeStorage")

test("missing file: name the revision and return to Code without a failed read", async ({ page }) => {
  const missing = page.waitForResponse((response) => new URL(response.url()).pathname.startsWith("/api/repos/") && new URL(response.url()).pathname.endsWith("/does/not/exist.ts"))
  await page.goto("/smithersai/smithers/blob/main/does/not/exist.ts")
  expect((await missing).status()).toBe(204)
  await expect(page.getByText("File not found at main", { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('a[href="/smithersai/smithers"]').filter({ hasText: /^Code$/ })).toBeVisible()
})
