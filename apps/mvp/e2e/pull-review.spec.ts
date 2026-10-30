import { expect, step, test } from "./fixtures"
import type { Page } from "@playwright/test"
import { requires } from "./target"
import { as, REPO, requiresContributor, requiresMaintainer } from "./vibelang"

// Review on request (decision 0126, docs/features/pulls.md#review-on-request): a Maintainer of smithersai/vibelang opens
// one of its open pull requests, someone else's, and presses Review; the page says Review requested (or that the head's
// review already runs or ran, which answers the same), and the head's review shows on the Checks tab. A Contributor
// sees no Review. Against a deployment the test account must be a Maintainer there (decision 0079); until it is, the
// Maintainer's test skips, blocked. Locally it needs the GitHub App, which local development runs without.

/** Opens the first open pull request on VibeLang's list, and answers its path. */
const openPull = async (page: Page) => {
  await page.goto(`${REPO}/pulls`)
  const list = page.locator('[data-slot="issues-view"]')
  await expect(list).not.toHaveAttribute("aria-busy", "true", { timeout: 60_000 })
  const open = list.locator("a[href*='/pull/']").first()
  await expect(open, "smithersai/vibelang has an open pull request").toBeVisible({ timeout: 60_000 })
  const href = (await open.getAttribute("href"))!
  await page.goto(href)
  await expect(page.getByRole("main")).toBeVisible()
  return href
}

test.describe("Review on request", () => {
  test(
    "a Maintainer asks Smithers to review an open pull request; its review shows on the Checks tab",
    { annotation: { type: "summary", description: "A Maintainer presses Review on someone's pull request and its review runs on the head." } },
    async ({ page }) => {
      requires("githubApp")
      await requiresMaintainer(page)
      test.setTimeout(180_000)
      await as(page, "maintainer")
      const href = await step("Open an open pull request of smithersai/vibelang", () => openPull(page))
      await step("Review: requested, or the head's review already asked for", async () => {
        const review = page.getByRole("button", { name: "Review", exact: true })
        await expect(review).toBeEnabled({ timeout: 60_000 })
        await review.click()
        await expect(page.getByRole("status").filter({ hasText: /^(Review requested|Checks running)$/ }))
          .toBeVisible({ timeout: 60_000 })
      })
      await step("The Checks tab shows the head's review", async () => {
        await page.goto(`${href}/checks`)
        await expect(page.getByRole("main")).toContainText("review", { timeout: 60_000 })
      })
    },
  )

  test(
    "a Contributor sees no Review",
    { annotation: { type: "summary", description: "Below Maintainer, the pull request page offers no Review." } },
    async ({ page }) => {
      requires("githubApp")
      await as(page, "contributor")
      await requiresContributor(page)
      await openPull(page)
      await expect(page.getByRole("button", { name: "Squash and merge" })).toHaveCount(0)
      await expect(page.getByRole("button", { name: "Review", exact: true })).toHaveCount(0)
    },
  )
})
