import { expect, test } from "./fixtures"
import { expectServerError } from "./watch"
import { repositoryAbout } from "./repository-prerequisites"
import { requires, signedOut } from "./target"

test.use(signedOut)
for (const kind of ["absentRepository", "publicPulls"] as const) {
  test(`visitor reads never mint session credentials: ${kind}`, async ({ page }) => {
    if (kind === "absentRepository") requires("absentRepository")
    const repository = kind === "absentRepository" ? await repositoryAbout("absentRepository") : "smithersai/vibelang"
    const path = kind === "absentRepository" ? `/${repository}` : `/${repository}/pulls`
    if (kind === "absentRepository") expectServerError(404, `/api/repos/${repository}/about`)
    const minted: string[] = []
    page.on("request", request => {
      if (request.method() === "POST" && /\/api\/runs\/[^/]+\/credential$/.test(new URL(request.url()).pathname)) minted.push(request.url())
    })
    await page.goto(path)
    await expect(page.getByRole("link", { name: "Back to chat", exact: true })).toBeVisible()
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0, { timeout: 150_000 })
    if (kind === "absentRepository") {
      await expect(page.getByRole("link", { name: "Sign in with GitHub", exact: true })).toBeVisible()
      await expect(page.getByText("Repository not found", { exact: true })).toBeVisible()
    }
    expect(minted).toEqual([])
  })
}
