import { expect, test } from "./fixtures"
import { expectServerError } from "./watch"

test.use({ storageState: { cookies: [], origins: [] } })
for (const path of ["/smithersai/smithers-infra", "/smithersai/vibelang/pulls"]) {
  test(`visitor reads never mint session credentials: ${path}`, async ({ page }) => {
    if (path.endsWith("smithers-infra")) expectServerError(404, "/api/repos/smithersai/smithers-infra/about")
    const minted: string[] = []
    page.on("request", request => {
      if (request.method() === "POST" && /\/api\/runs\/[^/]+\/credential$/.test(new URL(request.url()).pathname)) minted.push(request.url())
    })
    await page.goto(path)
    await expect(page.getByRole("link", { name: "Back to chat", exact: true })).toBeVisible()
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0, { timeout: 150_000 })
    if (path.endsWith("smithers-infra")) await expect(page.getByRole("link", { name: "Sign in with GitHub", exact: true })).toBeVisible()
    expect(minted).toEqual([])
  })
}
