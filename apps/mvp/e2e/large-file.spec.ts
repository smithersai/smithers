import { expect, test } from "./fixtures"
import { requires } from "./target"

requires("codeStorage")

test("large file: show preview limits without a failed HTTP read", async ({ page }) => {
  const preview = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/pnpm-lock.yaml"))
  await page.goto("/smithersai/smithers/blob/main/pnpm-lock.yaml")
  expect((await preview).status()).toBe(200)
  await expect(page.getByText("Too large to show", { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole("link", { name: "Raw", exact: true })).toHaveAttribute("href", /github/)
})
