import type { APIRequestContext, Page, TestInfo } from "@playwright/test"
import { mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import sample from "../plugins/factory/src/status.sample.json" with { type: "json" }
import { DEV_FEED_KEY } from "../worker/feeds/dev"
import { expect, test } from "./fixtures"
import { baseURL, requires, target } from "./target"

// The factory plugin, end to end (docs/features/factory.md, decision 0128): the test pushes a repository's status as
// its collector does, one index document per top-level key of the sample plus a lane's transcript and a commit's
// diff, through the feeds route with the repository's feed key. The run's person then opens the repository's Factory
// tab: Now draws the scoreboard and the lanes, Agents opens a lane's live transcript, Commits a commit's diff, and For
// you, for a maintainer, the decisions, which the host's strip answers. Nothing is mocked; the documents sync from
// Postgres through Electric. The test deletes what it pushed. Locally, `alchemy dev` accepts its development feed key
// (worker/feeds/dev.ts) on its own repository, and its person is an Admin; on a deployment, E2E_FEED_REPOSITORY and
// E2E_FEED_KEY name a repository and its key, and the decision is answered only locally, so a real collector never
// reads a test's answer. Each view is saved as a screenshot beside the run's results.
requires("feedKey")

const local = target === "local"
const [owner, name] = (process.env.E2E_FEED_REPOSITORY ?? process.env.GITHUB_REPOSITORY ?? "smithersai/smithers")
  .split("/") as [string, string]
const key = process.env.E2E_FEED_KEY ?? DEV_FEED_KEY
const lane = sample.agents[0]!.name
const commit = sample.commits[0]!

/** Sets (or, with `null`, deletes) documents of the repository's feed with its key, as the collector does. */
const push = async (request: APIRequestContext, set: Readonly<Record<string, unknown>>) => {
  const response = await request.post(`/api/repos/${owner}/${name}/feeds`, {
    headers: { authorization: `Bearer ${key}` },
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

/** Saves the page as `factory-<shot>.png` beside the run's results. */
const shoot = (page: Page, info: TestInfo, shot: string) => page.screenshot({ path: info.outputPath(`factory-${shot}.png`), fullPage: true })

// The feed is one repository's, shared by every browser project in the run: each project takes its turn, so one's
// cleanup never empties the views another is checking. A turn left by a killed run fails the next after 80 s.
const turn = join(tmpdir(), `smithers-e2e-feed-${owner}-${name}`)
test.beforeAll(async () => {
  for (const started = Date.now();; await new Promise((resolve) => setTimeout(resolve, 250))) {
    try {
      mkdirSync(turn)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() - started > 80_000) throw error
    }
  }
})

test.afterAll(async ({ playwright }) => {
  try {
    const request = await playwright.request.newContext({ baseURL })
    await push(request, Object.fromEntries([...Object.keys(index), ...Object.keys(extra)].map((key) => [key, null])))
    await request.dispose()
  } finally {
    rmSync(turn, { recursive: true, force: true })
  }
})

test("factory: the collector's status shows on the repository's Factory tab, with lanes, a transcript, a diff and the decisions", {
  annotation: { type: "summary", description: "Push the status; open Factory; Now, a lane's transcript, a commit's diff, For you." },
}, async ({ page }, info) => {
  test.setTimeout(120_000)
  await test.step("The collector pushes the status", async () => {
    await push(page.request, { ...index, ...extra })
  })

  await test.step("The repository's header has the Factory tab, which opens Now", async () => {
    await page.goto(`/${owner}/${name}`)
    const tab = page.getByRole("main", { name: "Repository" }).getByRole("link", { name: "Factory", exact: true })
    await expect(tab).toBeVisible({ timeout: 30_000 })
    await tab.click()
    await expect(page).toHaveURL(new RegExp(`/${owner}/${name}/-/factory$`))
    await expect(page.getByRole("table", { name: "Scoreboard" })).toBeVisible()
    await expect(page.getByRole("table", { name: "Lanes" }).getByRole("button", { name: lane })).toBeVisible()
    await shoot(page, info, "now")
  })

  await test.step("Agents lists every lane; a lane opens its live transcript", async () => {
    await page.getByRole("link", { name: "Agents" }).click()
    await expect(page).toHaveURL(/\/-\/factory\/agents$/)
    const lanes = page.getByRole("table", { name: "Lanes" })
    await expect(lanes.getByRole("row")).toHaveCount(sample.agents.length + 1)
    await lanes.getByRole("button", { name: lane }).click()
    const panel = page.getByRole("complementary", { name: lane })
    await expect(panel.getByRole("list", { name: "Transcript" })).toContainText("Reading the grammar")
    await shoot(page, info, "agents-transcript")
    await panel.getByRole("button", { name: "Close" }).click()
    await expect(panel).toBeHidden()
  })

  await test.step("Commits opens a commit's diff", async () => {
    await page.getByRole("link", { name: "Commits" }).click()
    await page.getByRole("table", { name: "Commits" }).getByRole("button", { name: commit.title }).click()
    const panel = page.getByRole("complementary", { name: commit.title })
    await expect(panel.getByRole("region", { name: "README.md" })).toContainText("new line")
    await shoot(page, info, "commits-diff")
  })

  await test.step("For you shows what waits on a maintainer; the strip answers the selected decision", async () => {
    await page.getByRole("complementary", { name: commit.title }).getByRole("button", { name: "Close" }).click()
    await page.getByRole("link", { name: "For you" }).click()
    await expect(page).toHaveURL(/\/-\/factory\/for-you$/)
    const waiting = sample.for_will.filter((ask) => !("decided" in ask) && !(ask.id in sample.answered))
    const first = page.getByRole("region", { name: "Waiting" }).getByRole("article", { name: waiting[0]!.title })
    await expect(first).toHaveAttribute("aria-current", "true")
    const strip = page.getByRole("region", { name: "Actions" })
    // The old factory's two answers: Accept and Change, each with the note.
    await expect(strip.getByRole("button", { name: /^Accept/ })).toBeVisible()
    await expect(strip.getByRole("button", { name: /^Change/ })).toBeVisible()
    await shoot(page, info, "for-you")
    if (local) {
      await strip.getByRole("textbox", { name: "Note" }).fill("Ship it")
      await strip.getByRole("button", { name: /^Accept/ }).click()
      await expect(strip.getByRole("status")).toBeHidden({ timeout: 30_000 })
      await expect(strip.getByRole("alert")).toBeHidden()
      // Its answer went: the note left with it.
      await expect(strip.getByRole("textbox", { name: "Note" })).toHaveValue("")
    }
  })

  await test.step("On a phone, the views take one column", async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole("link", { name: "Agents" }).click()
    await expect(page.getByRole("table", { name: "Lanes" })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    await shoot(page, info, "phone")
  })
})
