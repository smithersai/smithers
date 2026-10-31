import { expect, step, test } from "./fixtures"
import { requires } from "./target"
import { as, REPO } from "./vibelang"

// VibeLang's issues and pull requests on Smithers (decision 0079 slice 1b, docs/features/issues.md): the deployment
// syncs smithersai/vibelang through its GitHub App, so a signed-in person reads its list, opens an issue as GitHub has
// it, and is offered the comment box (any signed-in role, a Guest included, may comment). It reads only: a comment on
// VibeLang would reach its real GitHub issue, so the write itself is proven on the scratch repository
// (issues-another-repository.spec.ts, issues.spec.ts).
requires("githubApp")

test(
  "VibeLang's issues: the synced list, an issue opened from it, and the comment box",
  { annotation: { type: "summary", description: "Signed in, VibeLang's issues list opens an issue as GitHub has it, with the comment box." } },
  async ({ page }) => {
    test.setTimeout(180_000)
    await as(page, "contributor")
    await page.goto(`${REPO}/issues`)
    const row = await step("The list has VibeLang's open issues", async () => {
      const link = page.getByRole("main", { name: "Issues" }).locator(`a[href^="${REPO}/issues/"]:not([href$="/new"])`).first()
      await expect(link).toBeVisible({ timeout: 60_000 })
      await expect(page.getByText("Issues not synced")).toHaveCount(0)
      return { href: (await link.getAttribute("href"))!, title: (await link.innerText()).trim() }
    })
    await step("Open it: its title, its body and GitHub's link", async () => {
      await page.goto(row.href)
      const number = row.href.split("/").at(-1)!
      await expect(page.getByRole("heading", { level: 1 }).filter({ hasText: `#${number}` })).toBeVisible({ timeout: 60_000 })
      await expect(page.getByRole("link", { name: "Open on GitHub ↗" }))
        .toHaveAttribute("href", `https://github.com/smithersai/vibelang/issues/${number}`)
    })
    await step("The comment box, for a signed-in person", async () => {
      await expect(page.getByRole("textbox", { name: "Comment" })).toBeVisible()
      await expect(page.getByRole("button", { name: "Comment", exact: true })).toBeVisible()
    })
  },
)

test(
  "VibeLang's pull requests: the synced list says how many are open and closed",
  { annotation: { type: "summary", description: "VibeLang's pull request list is synced from GitHub and counts open and closed." } },
  async ({ page }) => {
    test.setTimeout(120_000)
    await as(page, "contributor")
    await page.goto(`${REPO}/pulls`)
    await expect(page.getByText(/^\d+ open · \d+ closed$/)).toBeVisible({ timeout: 60_000 })
  },
)
