import { expect, type Page, type TestInfo } from "@playwright/test"
import { strictTest as test } from "./watch"
import { recordActions, step, themeOf, writeManifest } from "./fixtures"
import { NEEDS_REPRO_COMMENT, NEEDS_REPRO_LABEL, COMMITMENTS, COMMITMENT_COPY } from "../src/features/issues/lifecycle"
import { requires, scratchRepository } from "./target"

// Local limitation: this journey needs a real signed-in GitHub user, the App installation, webhook delivery and synced scratch repository. A local stack configured with those runs with E2E_TARGET=deployment; the model-free mini has none of them.
//
// Real GitHub, a deployment, Postgres, Electric and the browser; no model is needed for these slices. The test account
// is a Maintainer on the scratch repository (E2E_ISSUES_REPOSITORY), signed in by the deployment's setup.
requires("syncedScratch", "maintainer")

const started = new WeakMap<TestInfo, number>()
/** The scratch repository, `owner/name`, read once each test has declared its needs. */
let repo = ""

test.beforeEach(async ({ context, page }, info) => {
  started.set(info, Date.now())
  repo = scratchRepository()
  await page.emulateMedia({ colorScheme: themeOf(info) })
  await recordActions(page, info, "Maintainer")
  const response = await context.request.get("/api/auth/session")
  expect(response.status()).toBe(200)
  const session = await response.json() as { signedIn: boolean; role?: string }
  expect(session.signedIn, "the run's stored session is signed in (the deployment's setup)").toBe(true)
  expect(["admin", "maintainer"]).toContain(session.role)
})

test.afterEach(async ({ page }, info) => {
  await writeManifest(info, "flow.json", started.get(info) ?? Date.now(), [{ name: "Maintainer", video: await page.video()?.path(), openedAt: 0 }])
})

const openIssue = async (page: Page, title: string, body: string) => {
  await page.goto(`/${repo}/issues/new`)
  await page.getByLabel("Title", { exact: true }).fill(title)
  await page.getByLabel("Description", { exact: true }).fill(body)
  await page.getByRole("button", { name: "Create issue", exact: true }).click()
  const row = page.getByRole("listitem").filter({ hasText: title })
  await expect(row).toContainText(/#\d+/, { timeout: 120_000 })
  await row.getByRole("link", { name: title, exact: true }).click()
  await expect(page.getByRole("group", { name: "Triage", exact: true })).toBeVisible({ timeout: 60_000 })
  return Number(new URL(page.url()).pathname.split("/").at(-1))
}

const githubIssue = async (page: Page, number: number) => {
  const response = await page.request.get(`https://api.github.com/repos/${repo}/issues/${number}`)
  expect(response.status()).toBe(200)
  return await response.json() as { labels: Array<{ name: string }>; state: string }
}

test("needs repro: a bug asks once across two triage runs and remains open", {
  annotation: { type: "summary", description: "The real GitHub App requests missing code once without judging the bug." },
}, async ({ page }) => {
  test.setTimeout(300_000)
  await page.goto(`/${repo}/issues`)
  const enable = page.getByRole("button", { name: "Enable triage", exact: true })
  if (await enable.isVisible({ timeout: 30_000 }).catch(() => false)) await enable.click()
  await expect(page.getByRole("button", { name: "Pause triage", exact: true })).toBeVisible({ timeout: 60_000 })
  const number = await step("Open a bug without code", () => openIssue(page, `[bug] Reproduction gate ${Date.now()}`,
    "The button crashes.\n\n```ts\n```\nNo reproduction yet.\n```"))
  for (let attempt = 0; attempt < 2; attempt++) await step("Request triage", async () => {
    await page.getByRole("button", { name: "Run triage again", exact: true }).click()
    await expect(page.getByText(NEEDS_REPRO_COMMENT, { exact: true })).toHaveCount(1, { timeout: 120_000 })
    await expect(page.getByRole("group", { name: "Triage", exact: true })).not.toHaveAttribute("data-pending", "requested", { timeout: 120_000 })
  })
  const issue = await githubIssue(page, number)
  expect(issue.labels.map((label) => label.name)).toContain(NEEDS_REPRO_LABEL)
  expect(issue.labels.map((label) => label.name)).not.toContain("smithers:accepted")
  expect(issue.state).toBe("open")
  const comments = await page.request.get(`https://api.github.com/repos/${repo}/issues/${number}/comments`)
  expect(comments.status()).toBe(200)
  expect((await comments.json() as Array<{ body: string; user: { type: string } }>).filter((comment) => comment.body.includes(NEEDS_REPRO_COMMENT)))
    .toEqual([expect.objectContaining({ user: expect.objectContaining({ type: "Bot" }) })])
})

test("commitment: accepted for discussion gets a Maintainer timeline visible on GitHub and in the list filter", {
  annotation: { type: "summary", description: "Set each commitment, reload it, and filter the GitHub-backed issues list." },
}, async ({ page }) => {
  test.setTimeout(300_000)
  const title = `Commitment ${Date.now()}`
  const number = await step("Open an issue", () => openIssue(page, title, "Discuss this small improvement."))
  const triage = page.getByRole("group", { name: "Triage", exact: true })
  if (await triage.getByRole("button", { name: "Accept", exact: true }).isVisible()) {
    await step("Accept for discussion", async () => {
      await triage.getByRole("button", { name: "Accept", exact: true }).click()
      await expect(triage).toHaveAttribute("data-triage", "accepted", { timeout: 120_000 })
    })
  }
  for (const commitment of COMMITMENTS) await step(`Set ${COMMITMENT_COPY[commitment]}`, async () => {
    await page.getByRole("button", { name: "Set commitment", exact: true }).click()
    await page.getByRole("menuitem", { name: COMMITMENT_COPY[commitment], exact: true }).click()
    await expect(page.getByRole("group", { name: "Commitment", exact: true })).toHaveAttribute("data-commitment", commitment, { timeout: 120_000 })
    const labels = (await githubIssue(page, number)).labels.map((label) => label.name).filter((name) => name.startsWith("smithers:commit-"))
    expect(labels).toEqual([`smithers:commit-${commitment}`])
  })
  await step("Reload and filter the issue list", async () => {
    await page.reload()
    await expect(page.getByRole("group", { name: "Commitment", exact: true })).toHaveAttribute("data-commitment", "none", { timeout: 60_000 })
    await page.goto(`/${repo}/issues?commitment=none`)
    await expect(page.getByRole("link", { name: title, exact: true })).toBeVisible({ timeout: 60_000 })
    await page.getByRole("navigation", { name: "Commitment", exact: true }).getByRole("link", { name: "Now", exact: true }).click()
    await expect(page.getByRole("link", { name: title, exact: true })).toHaveCount(0)
  })
})
