import { expect, step, test } from "./fixtures"
import { github, pollGitHub } from "./github"
import { prepareReviewPull } from "./reviewPull"
import { shapeRows } from "./shape"
import { baseURL, me, OWN_BRANCH, requires, scratchRepository, writeHeaders } from "./target"

// Decision 0129: real PRs prepared as the test account. Its own scratch repository gives it Admin;
// the existing shared scratch repository gives that same account a Contributor's real permission.
// No development identity overrides, approvals or merges.

test.describe("Review on request", () => {
  test(
    "a Maintainer requests review; the exact head passes Checks and receives a comment review on GitHub",
    { annotation: { type: "summary", description: "Review finishes on the open scratch pull request's head and posts one comment review, never an approval." } },
    async ({ page }) => {
      requires("githubApp", "syncedScratch")
      test.setTimeout(600_000)
      const session = await page.request.get("/api/auth/session")
      expect(session.status()).toBe(200)
      expect(await session.json()).toMatchObject({ signedIn: true, login: me().login })
      const repository = scratchRepository()
      expect(repository.split("/")[0]?.toLowerCase(), "the review fixture belongs to the test account").toBe(me().login.toLowerCase())
      const role = await page.request.get(`/api/repos/${repository}/role`)
      expect(role.status()).toBe(200)
      expect(["admin", "maintainer"]).toContain((await role.json()).role)
      const pull = await step("Prepare an open pull request with a fresh head as the test account", () => prepareReviewPull(repository, true))
      const href = `/${repository}/pull/${pull.number}`
      const record = (stage: string) => console.info("pull-review.proof", { repository, number: pull.number, sha: pull.head.sha, stage })
      record("fixture-ready")
      const seen = new Set<string>()
      page.on("response", (response) => {
        const url = new URL(response.url())
        if (url.origin !== new URL(baseURL).origin) return
        const path = url.pathname
        const kind = /^\/api\/shapes\/(items|pulls|checks|reviews)$/.exec(path)?.[1] ??
          (path === `/api/repos/${repository}/role` ? "role" :
            path.startsWith(`/api/repos/${repository}/compare/`) ? "compare" :
              path === `/api/repos/${repository}/pulls/${pull.number}/review` ? "review" : undefined)
        if (kind === undefined || seen.has(`${kind}:${response.status()}`)) return
        seen.add(`${kind}:${response.status()}`)
        console.info("pull-review.http", { repository, number: pull.number, sha: pull.head.sha, kind, status: response.status() })
      })
      test.info().annotations.push({ type: "pull-review", description: `${repository}#${pull.number} head=${pull.head.sha}` })
      await step("Open the scratch pull request and read its change", async () => {
        record("files")
        const compared = page.waitForResponse((response) => {
          const path = new URL(response.url()).pathname
          return path.includes(`/api/repos/${repository}/compare/`) && path.endsWith(`...${pull.head.sha}`)
        }, { timeout: 120_000 })
        await page.goto(href)
        await expect(page.getByRole("navigation", { name: "Pull request", exact: true })).toBeVisible({ timeout: 90_000 })
        await page.getByRole("link", { name: /^Files/ }).click()
        expect((await compared).status(), "Files compares this head").toBe(200)
        await expect(page.getByRole("region", { name: "Files", exact: true })).toContainText(`e2e/${pull.head.ref}.txt`, { timeout: 60_000 })
        await expect(page.getByRole("region", { name: "Files", exact: true })).toContainText("Pull request review production proof.")
        record("files-ready")
        await page.goto(href)
      })
      await step("Request review of the head shown", async () => {
        record("request")
        const admitted = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith(`/pulls/${pull.number}/review`))
        const review = page.getByRole("button", { name: "Review", exact: true })
        await expect(review).toBeEnabled({ timeout: 60_000 })
        await review.click()
        const response = await admitted
        expect(response.status()).toBe(202)
        expect(await response.json()).toMatchObject({ sha: pull.head.sha, started: true })
        expect(response.request().postDataJSON()).toMatchObject({ headSha: pull.head.sha })
        record("started")
        await expect(page.getByRole("status").filter({ hasText: /^(Review requested|Checks running)$/ })).toBeVisible({ timeout: 60_000 })
      })
      await step("The head's review finishes successfully on Checks", async () => {
        record("checks")
        await page.goto(`${href}/checks`)
        const rows = await pollGitHub(
          () => shapeRows<{ id: string; sha: string; flow: string }>(page.request, `/api/shapes/checks?repo=${repository}`),
          (rows) => rows.some((row) => row.sha === pull.head.sha && row.flow === "checks/review"),
        )
        const run = rows.find((row) => row.sha === pull.head.sha && row.flow === "checks/review")!
        console.info("pull-review.run", { repository, number: pull.number, sha: pull.head.sha, id: run.id })
        const review = page.locator(`[data-run="${run.id}"]`)
        await expect(review).toBeVisible({ timeout: 60_000 })
        test.info().annotations.push({ type: "review-run", description: (await review.getByRole("link", { name: "checks/review", exact: true }).getAttribute("href"))! })
        const status = review.locator('[data-slot="run-status"]')
        await expect(status).toHaveAttribute("data-state", /^(completed|failed)$/, { timeout: 180_000 })
        console.info("pull-review.terminal", { repository, sha: pull.head.sha, id: run.id, state: await status.getAttribute("data-state") })
        await expect(status).toHaveAttribute("data-state", "completed")
        record("completed")
      })
      await step("Requesting the reviewed head again reuses its completed review", async () => {
        record("repeat")
        await page.goto(href)
        const admitted = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith(`/pulls/${pull.number}/review`))
        await page.getByRole("button", { name: "Review", exact: true }).click()
        const response = await admitted
        expect(response.status()).toBe(202)
        expect(await response.json()).toMatchObject({ sha: pull.head.sha, started: false })
      })
      await step("GitHub has one comment review on that head, attributed to the test account", async () => {
        record("github-review")
        type Review = { id: number; state: string; commit_id: string; body: string; user: { type: string } }
        const reviews: Array<Review> = []
        for (let number = 1; ; number++) {
          const batch = await github<ReadonlyArray<Review>>(page, `/repos/${repository}/pulls/${pull.number}/reviews?per_page=100&page=${number}`)
          reviews.push(...batch)
          if (batch.length < 100) break
        }
        const ours = reviews.filter((review) => review.commit_id === pull.head.sha && review.user.type === "Bot")
        expect(ours).toHaveLength(1)
        expect(ours[0]).toMatchObject({ state: "COMMENTED", user: { type: "Bot" } })
        expect(ours[0]!.body).toContain(`Reviewed by Smithers for @${me().login} (review).`)
        expect(ours[0]!.id).toBeGreaterThan(0)
        console.info("pull-review.github", { repository, number: pull.number, sha: pull.head.sha, reviewId: ours[0]!.id })
        await page.goto(href)
        await expect(page.getByRole("main")).toContainText(`Reviewed by Smithers for @${me().login}`, { timeout: 60_000 })
        const current = await github<{ state: string; merged: boolean; head: { sha: string } }>(page, `/repos/${repository}/pulls/${pull.number}`)
        expect(current).toMatchObject({ state: "open", merged: false, head: { sha: pull.head.sha } })
        record("passed")
      })
    },
  )

  test(
    "a Contributor sees no Review and cannot request one",
    { annotation: { type: "summary", description: "The test account's real Contributor permission hides Review and the API refuses it." } },
    async ({ page }) => {
      requires("githubApp")
      test.setTimeout(180_000)
      const repository = `${OWN_BRANCH.owner}/${OWN_BRANCH.name}`
      const role = await page.request.get(`/api/repos/${repository}/role`)
      expect(role.status()).toBe(200)
      expect((await role.json()).role, "the test account is below Maintainer on the shared scratch repository").toBe("member")
      const pull = await prepareReviewPull(repository)
      const viewedRole = page.waitForResponse((response) => response.url().endsWith(`/api/repos/${repository}/role`))
      await page.goto(`/${repository}/pull/${pull.number}`)
      const answer = await viewedRole
      expect(answer.status()).toBe(200)
      expect(await answer.json()).toMatchObject({ role: "member" })
      await expect(page.getByRole("navigation", { name: "Pull request", exact: true })).toBeVisible({ timeout: 90_000 })
      await expect(page.locator(".pull-merge .pull-refs")).toBeVisible()
      await expect(page.getByRole("button", { name: "Squash and merge" })).toHaveCount(0)
      await expect(page.getByRole("button", { name: "Review", exact: true })).toHaveCount(0)
      const refused = await page.request.post(`/api/repos/${repository}/pulls/${pull.number}/review`, { headers: writeHeaders(), data: { headSha: pull.head.sha } })
      expect(refused.status()).toBe(403)
      expect(await refused.json()).toMatchObject({ code: "forbidden" })
    },
  )
})
