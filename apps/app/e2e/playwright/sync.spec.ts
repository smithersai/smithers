import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"
import { installCloudFixture } from "./cloudFixture.ts"

/*
 * Lane sync T1 (docs/workbench-lanes/sync.md "Exit", ADR 0005): against a
 * fake cloud upstream the app connects a repository to a Linear team end to
 * end — the connector-setup card walks authorize → team → repository →
 * confirm and turns into the connected state on the SAME card — a sync
 * starts a RUN whose state, counts and ops fill the sync-ops card, a failed
 * op retries through its own row, and a GitHub import tracks its job to done
 * with the workspace link.
 *
 * Every double is shaped as plue answers it (verified against `~/plue` main):
 * the list lives at /api/integrations/linear, the create at /api/linear, the
 * run and the ops feed under /api/linear/{id}, the op's error is
 * `error_message` and its status one of pending|success|failed|skipped.
 *
 * The server is a double: the shared cloud fixture (cloudFixture.ts) answers
 * the bootstrap, the cloud session and the Smithers Cloud inventory; this
 * spec adds the Linear and import routes. The local origin runs offline in
 * T1, so the /api/linear-auth/* receiver (bun/LinearAuth.ts, covered by its
 * own bun tests) is doubled like every other route; window.open is stubbed
 * so the handoff URL is captured, never navigated.
 */

const REPO = "smithersai/smithers"

const INTEGRATION = {
  id: 7,
  linear_team_id: "team-eng",
  linear_team_key: "ENG",
  linear_team_name: "Engineering",
  repo_owner: "smithersai",
  repo_name: "smithers",
  is_active: true,
  last_sync_at: "2026-09-02T09:00:00Z",
  created_at: "2026-09-01T10:00:00Z"
}

/* plue's LinearOAuthSetupResult: teams + expires_at, and no viewer. */
const SETUP = {
  teams: [
    { id: "team-eng", name: "Engineering", key: "ENG" },
    { id: "team-design", name: "Design", key: "DES" }
  ],
  expires_at: "2099-09-02T12:00:00Z"
}

/* One op as GET /api/linear/{id}/ops answers it. */
const OPS = [
  {
    id: 90,
    run_id: 41,
    source: "smithers-cloud",
    target: "linear",
    entity: "issue",
    entity_id: "90",
    action: "update",
    status: "failed",
    error_message: "Linear API: 422 label 'infra' does not exist on team ENG",
    created_at: "2026-09-02T09:00:00Z"
  },
  {
    id: 91,
    run_id: 41,
    source: "linear",
    target: "smithers-cloud",
    entity: "issue",
    entity_id: "ENG-482",
    action: "create",
    status: "success",
    error_message: "",
    created_at: "2026-09-02T09:00:00Z"
  }
]

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body)
})

/** Install the server double: signed in to a cloud that inventories REPO, with the Linear seam's routes. */
const serve = async (page: Page): Promise<void> => {
  await installCloudFixture(page, { capabilities: ["agent", "identity", "cloud", "cloud.pat", "local.repositories", "local.targets", "local.terminal", "local.harnesses"] })

  /* The Linear seam: the create lands at /api/linear, the list at /api/integrations/linear. */
  let integrations: Array<unknown> = []
  await page.route("**/api/cloud/api/linear", (route) => {
    integrations = [INTEGRATION]
    return route.fulfill(json({ id: 7, linear_team_id: "team-eng", linear_team_name: "Engineering", repo_owner: "smithersai", repo_name: "smithers", is_active: true }, 201))
  })
  await page.route("**/api/cloud/api/integrations/linear", (route) => route.fulfill(json(integrations)))
  /* The handoff receiver (doubled — the local origin is offline in T1). */
  let polls = 0
  await page.route("**/api/linear-auth/start", (route) =>
    route.fulfill(json({ url: "https://cloud.test/api/auth/linear?callback_port=9" })))
  await page.route("**/api/linear-auth/session", (route) => {
    polls += 1
    return route.fulfill(json(polls < 2 ? { state: "waiting" } : { state: "authorized", setupKey: "sk-123" }))
  })
  await page.route("**/api/cloud/api/linear/setup/sk-123", (route) => route.fulfill(json(SETUP)))
  /* The run: started with an id, then polled until it settles, with its ops beside it. */
  await page.route("**/api/cloud/api/linear/7/sync", (route) => route.fulfill(json({ run_id: 41 }, 202)))
  await page.route(/\/api\/cloud\/api\/linear\/7\/sync\/41$/, (route) =>
    route.fulfill(json({
      state: "completed",
      counts: { issues: { done: 1, total: 2, failed: 1 }, comments: { done: 0, total: 0, failed: 0 } },
      started_at: "2026-09-02T09:00:00Z",
      finished_at: "2026-09-02T09:05:00Z"
    })))
  let ops = [...OPS]
  await page.route(/\/api\/cloud\/api\/linear\/7\/ops(\?.*)?$/, (route) => route.fulfill(json(ops)))
  await page.route(/\/api\/cloud\/api\/linear\/7\/ops\/90\/retry$/, (route) => {
    const retry = { ...OPS[0]!, id: 92, retry_of_id: 90, status: "success", error_message: "" }
    ops = [retry, ...ops]
    return route.fulfill(json(retry, 202))
  })

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

test("T1: /linear.connect walks the wizard and turns the card connected", async ({ page }) => {
  await serve(page)
  await page.goto("/")

  await runSlash(page, "/linear.connect")
  const card = page.getByTestId("card-connector-setup-linear-smithersai/smithers")
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card).toContainText("Authorize in your browser")

  /* Step 1: the handoff — the URL went to the browser, the setup key came back. */
  await card.getByRole("button", { name: /Open Linear/ }).click()
  /* plue names no viewer, so the row reads a bare `authorized`. */
  await expect(card).toContainText("authorized", { timeout: 15_000 })
  const opened = await page.evaluate(() => (window as unknown as { __openedUrls: Array<string> }).__openedUrls)
  expect(opened).toEqual(["https://cloud.test/api/auth/linear?callback_port=9"])

  /* Step 2: the teams the key can see, one click each. */
  await card.getByRole("button", { name: /ENG · Engineering/ }).click()
  await expect(card).toContainText("ENG · Engineering")

  /* Step 4: the repository step defaults to the active repository — Connect. */
  await card.getByRole("button", { name: "Connect", exact: true }).click()

  /* The SAME card turns into the connected state. */
  await expect(card).toContainText("ENG · Engineering → smithersai/smithers", { timeout: 15_000 })
  await expect(card.getByRole("button", { name: /Sync now/ })).toBeVisible()
  await expect(card.getByRole("button", { name: /Disconnect/ })).toBeVisible()
})

test("T1: /linear.sync tracks the run, lists its ops, and Retry runs on the failed row", async ({ page }) => {
  await serve(page)
  /* The integration already exists in this cut. */
  await page.route("**/api/cloud/api/integrations/linear", (route) => route.fulfill(json([INTEGRATION])))
  await page.goto("/")

  await runSlash(page, "/linear.sync")
  const syncCard = page.getByTestId("card-sync-ops-linear-7")
  await expect(syncCard).toBeVisible({ timeout: 15_000 })
  await expect(syncCard).toContainText("Linear ENG ↔ smithersai/smithers")
  await expect(syncCard).toContainText("sync started · run 41")

  /* The run poll fills the header and the rows; the failed op keeps its own words. */
  await expect(syncCard).toContainText("1 of 2 · 1 failed", { timeout: 20_000 })
  await expect(syncCard).toContainText("Smithers Cloud → linear issue 90 update")
  await expect(syncCard).toContainText("Linear API: 422 label 'infra' does not exist on team ENG")

  const retrying = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/linear/7/ops/90/retry"))
  await syncCard.getByRole("button", { name: /Retry/ }).click()
  expect((await retrying).status()).toBe(202)
  await expect(syncCard.getByTestId("sync-op-92")).toContainText("Complete", { timeout: 15_000 })
})

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
