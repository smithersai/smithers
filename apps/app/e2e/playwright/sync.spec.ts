import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"
import { installCloudFixture } from "./cloudFixture.ts"

const REPO = "smithersai/smithers"

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body)
})


const serve = async (page: Page): Promise<void> => {
  await installCloudFixture(page, { capabilities: ["agent", "identity", "cloud", "cloud.pat", "local.repositories", "local.targets", "local.terminal", "local.harnesses"] })

  /* The import seam: the job starts cloning, then answers ready with its workspace. */
  let importPolls = 0
  await page.route("**/api/cloud/api/github/import", (route) =>
    route.fulfill(json({ importJobId: "job-1", status: "cloning", stage: "resolving", target_bookmark: "main" }, 202)))
  await page.route("**/api/cloud/api/github/import/job-1", (route) => {
    importPolls += 1
    return route.fulfill(json(importPolls < 2
      ? { importJobId: "job-1", status: "cloning", stage: "pushing_mirror", target_bookmark: "main" }
      : {
          importJobId: "job-1",
          status: "ready",
          stage: "provisioning_workspace",
          target_bookmark: "main",
          repository: { owner: "smithersai", name: "smithers" },
          workspace_id: "ws-9"
        }))
  })
}

test.beforeEach(async ({ page }) => {
  // A persisted store from an earlier test must not carry state across tests.
  await page.addInitScript(() => {
    try {
      window.localStorage.clear()
    } catch {
      // Storage the browser refuses is the empty store already.
    }
    /* The handoff opens the system browser; in T1 the URL is captured, never navigated. */
    const opened: Array<string> = []
    Object.assign(window, { __openedUrls: opened })
    window.open = (url?: string | URL) => {
      opened.push(String(url ?? ""))
      return null
    }
  })
})

const runSlash = async (page: Page, command: string): Promise<void> => {
  await page.getByTestId("composer-input").fill(command)
  await page.getByTestId("composer-send").click()
}

test("T1: /repos.import tracks the job to done with the workspace link", async ({ page }) => {
  await serve(page)
  await page.goto("/")

  await runSlash(page, `/repos.import ${REPO}`)
  const card = page.getByTestId("card-repo-import-smithersai/smithers")
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card).toContainText("Contacting GitHub…")

  await expect(card).toContainText("done", { timeout: 20_000 })
  await expect(card).toContainText("smithersai/smithers")
  await expect(card.getByRole("button", { name: /Open the workspace/ })).toBeVisible()
})
