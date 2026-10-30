import type { APIRequestContext } from "@playwright/test"
import sample from "../plugins/factory/src/status.sample.json" with { type: "json" }
import { expect, test } from "./fixtures"
import { baseURL, requires } from "./target"

// The factory plugin, end to end (docs/features/factory.md, decision 0126): the test pushes a repository's status as
// its collector does, one index document per top-level key of the sample plus a lane's transcript and a commit's
// diff, through the feeds route with the repository's feed key. A signed-out visitor then opens the repository's
// Factory tab: Now draws the scoreboard and the lanes, Agents opens a lane's live transcript, Commits a commit's diff,
// and For you the decisions. Nothing is mocked; the documents sync from Postgres through Electric. The test deletes
// what it pushed.
requires("feedKey")

const [owner, name] = process.env.E2E_FEED_REPOSITORY!.split("/") as [string, string]
const lane = sample.agents[0]!.name
const commit = sample.commits[0]!

/** Sets (or, with `null`, deletes) documents of the repository's feed with its key, as the collector does. */
const push = async (request: APIRequestContext, set: Readonly<Record<string, unknown>>) => {
  const response = await request.post(`/api/repos/${owner}/${name}/feeds`, {
    headers: { authorization: `Bearer ${process.env.E2E_FEED_KEY}` },
    data: { set },
  })
  expect(response.status()).toBe(200)
}

const index = Object.fromEntries(Object.entries(sample).map(([key, body]) => [key, { visibility: "public", body }]))
const extra = {
  [`transcript/${lane}`]: {
    visibility: "public",
    body: { live: true, source: "lane", events: [{ kind: "text", text: "Reading the grammar", ts: Date.now() }] },
  },
  [`diff/${commit.id}`]: {
    visibility: "public",
    body: {
      message: commit.title,
      truncated: false,
      patch: "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old line\n+new line\n",
    },
  },
}

test.afterAll(async ({ playwright }) => {
  const request = await playwright.request.newContext({ baseURL })
  await push(request, Object.fromEntries([...Object.keys(index), ...Object.keys(extra)].map((key) => [key, null])))
  await request.dispose()
})

test("factory: the collector's status shows on the repository's Factory tab, with lanes, a transcript, a diff and the decisions", {
  annotation: { type: "summary", description: "Push the status; open Factory; Now, a lane's transcript, a commit's diff, For you." },
}, async ({ page }) => {
  test.setTimeout(120_000)
  await test.step("The collector pushes the status", async () => {
    await push(page.request, { ...index, ...extra })
  })

  await test.step("The repository's header has the Factory tab, which opens Now", async () => {
    await page.goto(`/${owner}/${name}`)
    const tab = page.getByRole("banner", { name: "Repository" }).getByRole("link", { name: "Factory" })
    await expect(tab).toBeVisible({ timeout: 30_000 })
    await tab.click()
    await expect(page).toHaveURL(new RegExp(`/${owner}/${name}/-/factory$`))
    await expect(page.getByRole("table", { name: "Scoreboard" })).toBeVisible()
    await expect(page.getByRole("table", { name: "Lanes" }).getByRole("button", { name: lane })).toBeVisible()
  })

  await test.step("Agents lists every lane; a lane opens its live transcript", async () => {
    await page.getByRole("link", { name: "Agents" }).click()
    await expect(page).toHaveURL(/\/-\/factory\/agents$/)
    const lanes = page.getByRole("table", { name: "Lanes" })
    await expect(lanes.getByRole("row")).toHaveCount(sample.agents.length + 1)
    await lanes.getByRole("button", { name: lane }).click()
    const panel = page.getByRole("complementary", { name: lane })
    await expect(panel.getByRole("list", { name: "Transcript" })).toContainText("Reading the grammar")
    await panel.getByRole("button", { name: "Close" }).click()
    await expect(panel).toBeHidden()
  })

  await test.step("Commits opens a commit's diff", async () => {
    await page.getByRole("link", { name: "Commits" }).click()
    await page.getByRole("table", { name: "Commits" }).getByRole("button", { name: commit.title }).click()
    const panel = page.getByRole("complementary", { name: commit.title })
    await expect(panel.getByRole("region", { name: "README.md" })).toContainText("new line")
  })

  await test.step("For you shows what waits on a maintainer", async () => {
    await page.getByRole("complementary", { name: commit.title }).getByRole("button", { name: "Close" }).click()
    await page.getByRole("link", { name: "For you" }).click()
    await expect(page.getByRole("region", { name: "Waiting" }).or(page.getByRole("region", { name: "Past" })).first())
      .toBeVisible()
  })
})
