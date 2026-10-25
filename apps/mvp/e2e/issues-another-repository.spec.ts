import { expect, test } from "./devices"
import { github, pollGitHub } from "./github"
import { requires, scratchRepository } from "./target"

// Local limitation: this journey verifies a real GitHub OAuth write and App-resolved repository permission. Run a locally hosted stack with those credentials using E2E_TARGET=deployment; synthetic local-development identities have no GitHub user token.
//
// Opening an issue on a repository other than the deployment's own (decision 0079, docs/features/issues.md#routes): the
// real app, ChatApi, its role read from GitHub with the App, the `github/Write` flow and GitHub itself. It writes to
// GitHub as the test account, so it runs only against a deployment signed in as that account
// (e2e/deployment/sign-in.setup.ts), on the scratch repository E2E_ISSUES_REPOSITORY, which must not be the
// deployment's own GITHUB_REPOSITORY (E2E_SYNCED_REPOSITORY, smithersai/smithers unless set): on smithers.sh,
// roninjin10/smithers-github-tests (`requires("secondRepository")`, e2e/target.ts), which the App is installed on. The
// deployment syncs that repository's issues too (decision 0079, slice 1b): its webhook applies GitHub's issue, and the
// list and the issue's page show it as GitHub numbered it.

test("another repository: an issue reaches GitHub, then syncs into that repository's list and page", {
  annotation: { type: "summary", description: "An issue opened on a second repository reaches GitHub and shows in Smithers with its number." },
}, async ({ devices }) => {
  requires("secondRepository", "member")
  test.setTimeout(240_000)
  const repo = scratchRepository()
  const [maya] = await devices.open("Maya")
  const page = maya.page
  const title = `Smithers e2e second repository ${new Date().toISOString()}`

  await test.step("Maya opens an issue on the second repository", async () => {
    await page.goto(`/${repo}/issues/new`)
    await page.getByLabel("Title").fill(title)
    await page.getByLabel("Description").fill("Opened by the second-repository e2e test.")
    await page.getByRole("button", { name: "Create issue" }).click()
    await expect(page).toHaveURL(new RegExp(`/${repo}/issues$`))
  })

  const row = page.getByRole("listitem").filter({ hasText: title })
  await test.step("the deployment takes it: Requested, never Not sent", async () => {
    await expect(row).toBeVisible({ timeout: 30_000 })
    await expect(row).not.toContainText("Not sent", { timeout: 15_000 })
    await expect(page.getByRole("region", { name: `${repo} issues` })).not.toHaveAttribute("aria-busy", "true")
  })

  const url = await test.step("GitHub has it on that repository, opened by Maya", async () => {
    const issues = await pollGitHub(
      () => github<ReadonlyArray<{ readonly title: string; readonly html_url: string }>>(
        page, `/repos/${repo}/issues?state=all&sort=created&direction=desc&per_page=20`,
      ),
      (issues) => issues.some((issue) => issue.title === title),
    )
    return issues.find((issue) => issue.title === title)!.html_url
  })

  const number = Number(new URL(url).pathname.split("/").at(-1))
  await test.step("Smithers syncs it: the list's row carries GitHub's number, no longer Requested", async () => {
    expect(Number.isSafeInteger(number) && number > 0).toBe(true)
    await expect(row).toContainText(`#${number}`, { timeout: 120_000 })
    await expect(row).not.toContainText("Requested")
  })

  await test.step("the issue's Smithers page shows it, with its link to GitHub", async () => {
    await page.goto(`/${repo}/issues/${number}`)
    await expect(page.getByRole("heading", { name: title })).toBeVisible({ timeout: 60_000 })
    const link = page.getByRole("link", { name: "Open on GitHub ↗" })
    const target = new URL((await link.getAttribute("href")) ?? "")
    const created = new URL(url)
    expect(target.origin).toBe(created.origin)
    expect(target.pathname.toLowerCase()).toBe(created.pathname.toLowerCase())
  })

  await test.step("the issue on GitHub", async () => {
    await page.goto(url)
    await expect(page.getByRole("heading", { name: title })).toBeVisible({ timeout: 30_000 })
  })
})
