import { createHmac, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { GitHub } from "@smthrs/integrations"
import { Effect, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { installationToken, pushDelivery } from "./ciAuth"
import { expect, test } from "./devices"
import { field, type LogRecord, LogTail } from "./logs"
import { requires, target } from "./target"

// CI on Smithers (docs/features/ci.md): on a deployment the pusher is the App installation, authenticated with
// GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY from the vault's environment wrapper. GitHub delivers the real push to
// the App's one production webhook; ChatApi's ci.dispatch record correlates its delivery id with the pushed SHA.
// Local development keeps the person push (E2E_GITHUB_TOKEN) and self-signed delivery (E2E_GITHUB_WEBHOOK_SECRET).
// E2E_REPO_FLOWS_REPOSITORY (never smithersai) holds e2e/fixtures/ci-repo on its default branch. The target enables
// REPO_FLOWS and allows the repository in REPO_FLOWS_REPOSITORIES; the App has Contents and Commit statuses write.
// GitHub API calls use the SDK's redacted authentication and HTTP outside Playwright's request context: no key,
// JWT or access token enters a Playwright trace, error attachment or browser. Each step follows the run's records.

const REPOSITORY = process.env.E2E_REPO_FLOWS_REPOSITORY ?? ""

/** GitHub REST as the target's pusher, with the SDK's credential scrubbing (including error causes). */
const github = (token: Redacted.Redacted<string>, method: GitHub.GitHubClient.RequestMethod, path: string, body?: unknown) =>
  Effect.runPromise(Effect.gen(function* () {
    const client = yield* GitHub.GitHubClient.make({ token: Redacted.value(token) }, {})
    return yield* client.request(method, path, body)
  }).pipe(Effect.provide(FetchHttpClient.layer)))

/** Pushes one commit adding `ci-e2e.txt` onto the default branch's head, as branch `branch`: its SHA. */
const push = async (token: Redacted.Redacted<string>, branch: string, word: string) => {
  const repo = await github(token, "GET", `/repos/${REPOSITORY}`) as { default_branch: string }
  const head = await github(token, "GET", `/repos/${REPOSITORY}/git/ref/heads/${repo.default_branch}`) as { object: { sha: string } }
  const base = await github(token, "GET", `/repos/${REPOSITORY}/git/commits/${head.object.sha}`) as { tree: { sha: string } }
  const tree = await github(token, "POST", `/repos/${REPOSITORY}/git/trees`, {
    base_tree: base.tree.sha,
    tree: [{ path: "ci-e2e.txt", mode: "100644", type: "blob", content: `${word}\n` }],
  }) as { sha: string }
  const commit = await github(token, "POST", `/repos/${REPOSITORY}/git/commits`, {
    message: `CI e2e ${word}`,
    tree: tree.sha,
    parents: [head.object.sha],
  }) as { sha: string }
  await github(token, "POST", `/repos/${REPOSITORY}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha })
  return { sha: commit.sha, before: head.object.sha, defaultBranch: repo.default_branch }
}

/** The records named `message` whose `field` is `value`, in arrival order. */
const recordsOf = async (logs: LogTail, message: string, key: string, value: string) =>
  (await logs.records()).own.filter((record: LogRecord) => record.message === message && field(record, key) === value)

test("ci: a push runs the repository's flow, each job on its own machine, and GitHub shows smithers/ci passed", {
  annotation: { type: "summary", description: "A push runs the repository's own CI on Smithers machines; GitHub shows the check." },
}, async ({ devices, request }) => {
  requires("localLogs", "repoFlows")
  if (target === "deployment") requires("githubAppKey")
  else requires("githubPushToken", "webhookSecret")
  test.setTimeout(20 * 60_000)
  const token = target === "deployment"
    ? (await Effect.runPromise(installationToken(REPOSITORY, {
      appId: process.env.GITHUB_APP_ID!,
      privateKey: Redacted.make(process.env.GITHUB_APP_PRIVATE_KEY!),
    }).pipe(Effect.provide(FetchHttpClient.layer)))).token
    : Redacted.make(process.env.E2E_GITHUB_TOKEN!)
  const logs = await LogTail.start()
  const [a] = await devices.open("A")
  const branch = `smithers-ci-e2e-${devices.word}`
  try {
    const pushed = await test.step("Push a commit to a branch", () => push(token, branch, devices.word))
    const delivery = await test.step("GitHub delivers the push", async () => {
      if (target === "deployment") {
        await expect.poll(async () => pushDelivery((await logs.records()).own, REPOSITORY, pushed.sha), {
          timeout: 2 * 60_000,
          message: "GitHub's real push delivery reaches ChatApi for this commit",
        }).toBeTruthy()
        return pushDelivery((await logs.records()).own, REPOSITORY, pushed.sha)!
      }
      const delivery = randomUUID()
      const body = JSON.stringify({
        ref: `refs/heads/${branch}`,
        before: "0".repeat(40),
        after: pushed.sha,
        created: true,
        deleted: false,
        repository: { full_name: REPOSITORY, default_branch: pushed.defaultBranch },
      })
      const signature = createHmac("sha256", process.env.E2E_GITHUB_WEBHOOK_SECRET!).update(body).digest("hex")
      const delivered = await request.post("/api/github/webhook", {
        headers: {
          "content-type": "application/json",
          "x-github-event": "push",
          "x-github-delivery": delivery,
          "x-hub-signature-256": `sha256=${signature}`,
        },
        data: body,
      })
      expect(delivered.status()).toBe(200)
      return delivery
    })
    const run = `ci:${delivery}`
    await test.step("The default branch's trigger starts the ci flow", async () => {
      await expect.poll(async () => (await recordsOf(logs, "ci.dispatch", "delivery", delivery)).map((record) => field(record, "outcome")), {
        timeout: 2 * 60_000,
      }).toEqual(["matched"])
      await expect.poll(async () => (await recordsOf(logs, "ci.repo_flow.plan", "run", run)).map((record) => field(record, "outcome")), {
        timeout: 3 * 60_000,
      }).toEqual(["planned"])
    })
    await test.step("Watch the repository run on Smithers", async () => {
      await a.page.goto(`/${REPOSITORY}/actions`)
      const runLink = a.page.locator(`a[href$="/actions/runs/${encodeURIComponent(run)}"]`)
      await expect(runLink).toBeVisible({ timeout: 30_000 })
      await runLink.click()
      await expect(a.page.getByRole("main", { name: "Run", exact: true })).toBeVisible()
      await expect(a.page.getByRole("link", { name: "Runs", exact: true })).toBeVisible()
      await expect(a.page.getByRole("link", { name: REPOSITORY, exact: true })).toBeVisible()
      await expect(a.page.getByRole("tab", { name: /^Steps/ })).toBeVisible({ timeout: 30_000 })
      await expect(a.page.getByRole("heading", { name: "ci", exact: true })).toBeVisible()
      const stop = a.page.getByRole("button", { name: "Stop", exact: true })
      if (await stop.isVisible()) await expect(stop).toBeEnabled()
      await a.page.reload()
      await expect(a.page.getByRole("main", { name: "Run", exact: true })).toBeVisible()
    })
    await test.step("Each job runs on its own machine at the commit", async () => {
      await expect.poll(
        async () => (await recordsOf(logs, "ci.job.call", "run", run)).filter((record) => field(record, "call") === "step").length,
        { timeout: 12 * 60_000, intervals: [5_000] },
      ).toBe(4)
      const checkouts = await recordsOf(logs, "ci.job.call", "run", run)
      expect(checkouts.filter((record) => field(record, "call") === "checkout").map((record) => [field(record, "job"), field(record, "outcome")]).sort())
        .toEqual([["checkout", "exact"], ["toolchain", "exact"]])
    })
    await test.step("smithers/ci is reported passed on the commit", async () => {
      await expect.poll(
        async () => (await recordsOf(logs, "ci.repo_flow.status", "run", run)).map((record) => [field(record, "state"), field(record, "outcome")]),
        { timeout: 2 * 60_000 },
      ).toContainEqual(["success", "sent"])
      const combined = await github(token, "GET", `/repos/${REPOSITORY}/commits/${pushed.sha}/status`) as {
        statuses: Array<{ context: string; state: string; description: string }>
      }
      expect(combined.statuses.find((status) => status.context === "smithers/ci")).toMatchObject({ state: "success", description: "Passed" })
    })
    await test.step("GitHub shows the check on the commit", async () => {
      await a.page.goto(`https://github.com/${REPOSITORY}/commit/${pushed.sha}`)
      await a.page.getByRole("button", { name: /checks?/i }).first().click().catch(() => undefined)
      await expect(a.page.getByText("smithers/ci").first()).toBeVisible({ timeout: 30_000 })
    })
  } finally {
    await github(token, "DELETE", `/repos/${REPOSITORY}/git/refs/heads/${branch}`).catch(() => undefined)
    await logs.dispose()
  }
})

test("ci fixture: the test repository's flow is the one e2e/fixtures/ci-repo holds", async () => {
  // What a person merges onto the test repository's default branch, once, so the e2e above has a trigger and a flow.
  const manifest = JSON.parse(readFileSync(new URL("./fixtures/ci-repo/.smithers/factory.json", import.meta.url), "utf8"))
  expect(manifest.contributes.triggers).toEqual([
    { on: "github.push", flow: "ci", title: "Every push to an e2e branch", branches: ["smithers-ci-e2e-*"] },
  ])
})
