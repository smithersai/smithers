import { expect, test } from "@playwright/test"
import { installCloudFixture } from "./cloudFixture.ts"

/*
 * Lane citc T1 (docs/workbench-lanes/citc.md "Exit", ADR 0002): against a
 * fake cloud upstream the app opens a workspace, the card streams
 * starting→running (the seam's settle watch), the Snapshots facet lists what
 * the upstream answered, and a degraded sign-in refuses a workspace act with
 * the exact "sign in again to enable" wording.
 *
 * The server is a double: the shared cloud fixture (cloudFixture.ts) answers
 * the bootstrap, the cloud session and the Smithers Cloud inventory; this
 * spec adds the workspace routes behind /api/cloud/*.
 */

const REPO = "smithersai/smithers"

const WS = (status: string, provisioningStage: string | null = null) => ({
  id: "ws-1",
  repo_full_name: REPO,
  name: "review",
  target_bookmark: "main",
  status,
  provisioning_stage: provisioningStage,
  suspended_at: null,
  created_at: "2026-09-01T00:00:00Z"
})

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body)
})

test.beforeEach(async ({ page }) => {
  // A persisted store from an earlier test must not carry state across tests.
  await page.addInitScript(() => {
    try {
      window.localStorage.clear()
    } catch {
      // Storage the browser refuses is the empty store already.
    }
  })
})

test("T1: /workspace.open renders the card, streams starting→running, and the Snapshots facet lists", async ({ page }) => {
  await installCloudFixture(page)
  let polls = 0
  await page.route(new RegExp(`/api/cloud/api/repos/${REPO}/workspaces(\\?.*)?$`), (route) => {
    if (route.request().method() === "POST") return route.fulfill(json(WS("pending", "allocating"), 201))
    return route.fulfill(json([WS("running")]))
  })
  await page.route(`**/api/cloud/api/repos/${REPO}/workspaces/ws-1`, (route) => {
    polls += 1
    return route.fulfill(json(polls < 2 ? WS("starting", "boot") : WS("running")))
  })
  await page.route(`**/api/cloud/api/repos/${REPO}/workspace-snapshots`, (route) =>
    route.fulfill(json([{ id: "snap-1", name: "golden", workspace_id: "ws-1", created_at: "2026-08-01T00:00:00Z" }])))
  await page.route(`**/api/cloud/api/repos/${REPO}/workspace/sessions`, (route) =>
    route.fulfill(json([])))
  await page.goto("/")

  await page.getByTestId("composer-input").fill("/workspace.open main smithersai/smithers")
  await page.getByTestId("composer-send").click()

  // The card: header names the repo, the bookmark, and the BOOKMARK's head — labeled, never a workspace head.
  const card = page.getByTestId("card-workspace-ws-1")
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card).toContainText("smithersai/smithers · main")
  await expect(card).toContainText("bookmark main head @ kxyzqrpv")
  await expect(card).not.toContainText("uptime")
  // The settle watch streams the status: pending → starting → running (the seam polls while unsettled). The card
  // renders the collection's freshest row, so the first paint is whichever landed last — the create's pending or
  // the watch's first poll (starting) — never a status the row has already left.
  await expect(card).toContainText(/Pending|Starting/)
  await expect(card).toContainText("Running", { timeout: 20_000 })

  // The Snapshots facet lists what the upstream answered, with its acts.
  await card.getByRole("tab", { name: "Snapshots" }).click()
  await expect(card).toContainText("golden")
  await expect(card.getByRole("button", { name: "Fork a workspace from golden" })).toBeVisible()
  await expect(card.getByRole("button", { name: "Delete snapshot golden" })).toBeVisible()

  // The tree row: the workspace copy nested under its repository, name · state.
  await expect(page.getByTestId("copy-workspace:ws-1")).toContainText("review · running")
})

test("T1: a degraded sign-in refuses a workspace act with the exact enable wording", async ({ page }) => {
  await installCloudFixture(page, { degraded: true })
  await page.goto("/")

  await page.getByTestId("composer-input").fill("/workspace.list")
  await page.getByTestId("composer-send").click()

  const toast = page.locator(".toast-stack .toast-detail")
  await expect(toast).toContainText("sign in again to enable", { timeout: 15_000 })
  await expect(toast).toContainText("This Smithers Cloud sign-in can't use workspaces")
})
