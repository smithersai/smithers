import { expect, test } from "./fixtures"

test.use({ storageState: { cookies: [], origins: [] } })
for (const path of ["/smithersai/smithers-infra", "/smithersai/vibelang/pulls"]) {
  test(`visitor reads never mint session credentials: ${path}`, async ({ page }) => {
    const minted: string[] = []
    page.on("request", request => {
      if (request.method() === "POST" && /\/api\/runs\/[^/]+\/credential$/.test(new URL(request.url()).pathname)) minted.push(request.url())
    })
    await page.goto(path)
    await expect(page.getByRole("link", { name: "Back to chat", exact: true })).toBeVisible()
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0, { timeout: 150_000 })
    expect(minted).toEqual([])
  })
}
