import { expect, test } from "@playwright/test"
import type { MythicalItem, MythicalStack } from "@smthrs/rpc/Mythical"
import { installCloudFixture } from "./cloudFixture"
import { fillComposer } from "./composer"

/*
 * The Stack card against a fake Smithers Cloud (#1745): the slash door embeds
 * it, the event stream's hints re-read the snapshot so a lane moving shows in
 * the card and in the shared toast stack, and a refused admin act stays on
 * the card with a Retry that succeeds once the server accepts.
 */

const REPO = "smithersai/smithers"
const BASE = `/api/repos/${REPO}/mythical`
const item = (id: string, state: MythicalItem["state"], extra: Partial<MythicalItem> = {}): MythicalItem => ({
  id, state, attempt: 1, runs: {}, dependsOn: [], updatedAt: new Date().toISOString(),
  issue: { number: Number(id.slice(1)), title: `Issue ${id}`, url: `https://github.com/${REPO}/issues/${id.slice(1)}` },
  ...extra
})
const snapshot = (generation: number, items: MythicalItem[]): MythicalStack => ({
  repository: REPO, state: "active", generation, mainBehind: false,
  changes: [{ changeId: "kbootstrapchange", commitId: "c1", title: "Initial import", kind: "bootstrap", state: "landed" }],
  items, lanes: [{ index: 0, state: items.some(row => row.lane === 0) ? "busy" : "idle" }, { index: 1, state: "idle" }],
  limits: { maxParallel: 2 }
})

test("the Stack card follows lanes live, and a refused act is retried from the card", async ({ page }) => {
  await installCloudFixture(page)
  let current = snapshot(1, [item("i7", "queued")])
  let backfill = 403
  const writes: string[] = []
  await page.route(url => url.pathname === BASE, route => route.fulfill({ json: current }))
  // Every stream carries one hint and ends; the client re-reads and reconnects.
  await page.route(url => url.pathname === `${BASE}/events`, route => route.fulfill({
    status: 200, headers: { "content-type": "text/event-stream" },
    body: `event: mythical\ndata: {"generation":${current.generation},"kind":"item"}\n\n`
  }))
  await page.route(url => url.pathname === `${BASE}/backfill`, route => {
    writes.push(route.request().method())
    return backfill === 403
      ? route.fulfill({ status: 403, json: { message: "Only a repository writer can backfill." } })
      : route.fulfill({ status: 202, json: current })
  })

  await page.goto("/")
  await expect(page.getByTestId("first-run-actions")).toBeVisible()
  await fillComposer(page, `/stack.show ${REPO}`)
  await page.getByTestId("composer-send").click()
  const card = page.locator('[data-kind="stack"]')
  await expect(card.getByTestId("stack-counts")).toContainText("1 change")
  await expect(card.getByTestId("stack-lane-count")).toHaveText("0/2 lanes")
  await expect(card.getByTestId("stack-item-i7")).toContainText("queued")
  if (await page.getByTestId("composer-input").isVisible()) await page.getByTestId("composer-input").press("Escape")

  current = snapshot(2, [item("i7", "integrating", { lane: 0 })])
  await expect(card.getByTestId("stack-lane-0")).toContainText("#7 Issue i7", { timeout: 15_000 })
  await expect(card.getByTestId("stack-lane-0")).toContainText("rebasing")
  await expect(card.getByTestId("stack-lane-count")).toHaveText("1/2 lanes")
  const notice = page.locator(".toast-stack .toast", { hasText: "#7 Issue i7" })
  await expect(notice).toHaveAttribute("data-toast-status", "running")
  if (process.env.CAPTURE_DIR) await page.screenshot({ path: `${process.env.CAPTURE_DIR}/stack-card.png` })

  current = snapshot(3, [item("i7", "proposed", {
    checks: { state: "passed", failed: [] }, pullRequest: { number: 70, url: "https://github.com/pr/70", state: "open" }
  })])
  await expect(card.getByTestId("stack-item-i7")).toContainText("PR #70", { timeout: 15_000 })
  // Settled with the open pull request: ok, or already dismissed on its own.
  await expect(page.locator('.toast-stack .toast[data-toast-status="running"]', { hasText: "#7 Issue i7" })).toHaveCount(0)

  await card.getByRole("button", { name: "Backfill", exact: true }).click()
  const failure = card.locator('[data-testid="stack-failure"][data-act="backfill"]')
  await expect(failure).toContainText("backfill")
  backfill = 202
  await failure.getByRole("button", { name: "Retry" }).click()
  await expect.poll(() => writes).toEqual(["POST", "POST"])
  await expect(failure).toHaveCount(0)
})
