import { createHmac, randomUUID } from "node:crypto"
import { expect, test } from "./devices"
import { field, type LogRecord, LogTail } from "./logs"
import { me, requires } from "./target"

// Local limitation: the reconciliation/webhook slices need the real GitHub App and synced data; run a credentialed local stack as E2E_TARGET=deployment. Expiry, spend and role timers intentionally require longRun: dev shortens or disables those production windows, so the mini cannot prove them.
//
// Remote flows on the deployment (docs/features/remote-flows.md): the git loop's `github/Reconcile` and `github/Apply`,
// `ops/SpendAlert`, `chat/Expire` and `auth/RecheckRole`, each run by ChatApi's `FlowExecution` Durable Objects. Each
// test does what a person does, then waits for the flow's own record in ChatApi's records (e2e/logs.ts: a Cloudflare
// tail in a deployment) and for what the person sees. Records carry ids, counts and outcomes, never content.
//
// The repository is the deployment's GITHUB_REPOSITORY, the one it syncs (`E2E_SYNCED_REPOSITORY`, smithersai/smithers
// unless set). Nothing here writes to GitHub: the webhook test signs a delivery for an issue that exists, which the
// flow reads back. The spend alert, an answer's expiry and a role check wait out production's own windows, so they run
// with E2E_LONG=1. Signing out revokes the session's GitHub token (`auth/RevokeGitHubToken`); no test here signs out,
// which would end the run's shared session (docs/work/prod-e2e.md).

const REPOSITORY = process.env.E2E_SYNCED_REPOSITORY ?? "smithersai/smithers"

/** ChatApi's own records named `message`, in arrival order. */
const named = async (logs: LogTail, message: string): Promise<Array<LogRecord>> =>
  (await logs.records()).own.filter((record) => record.message === message)

/** The outcomes of the records named `message` that match `where`. */
const outcomes = async (logs: LogTail, message: string, where: (record: LogRecord) => boolean = () => true) =>
  (await named(logs, message)).filter(where).map((record) => field(record, "outcome"))

/**
 * Sets aside what the tab's loading watch (e2e/devices.ts) saw of the issues list: it shows loading until its
 * repository's first complete sync, the specified state (docs/features/issues.md), not a stall.
 */
const issuesLoadingIsSpecified = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const busy = (window as unknown as { __busy?: Array<string> }).__busy
    if (busy !== undefined) busy.splice(0, busy.length, ...busy.filter((seen) => !seen.includes('data-slot="issues-view"')))
  })

/** The issue links of the issues list, `/<owner>/<name>/issues/<number>`. */
const issueLinks = (page: import("@playwright/test").Page) =>
  page.locator(`main[aria-label="Issues"] a[href^="/${REPOSITORY}/issues/"]:not([href$="/new"])`)

test("issues sync: a Member's read of the stale issues list runs github/Reconcile, which walks GitHub and fills it", {
  annotation: { type: "summary", description: "The synced repository's issues list fills from GitHub through the remote sync." },
}, async ({ devices }) => {
  requires("githubApp", "member", "localLogs")
  test.setTimeout(15 * 60_000)
  const logs = await LogTail.start()
  try {
    const [a] = await devices.open("A")
    const walked = (record: LogRecord) => field(record, "repoId") === `github/${REPOSITORY}`
    await a.page.goto(`/${REPOSITORY}/issues`)
    // A read finds the sync older than 5 minutes and starts a walk; a sync fresher than that starts none until it ages,
    // so the tab reads the issues shape again every half minute, as an open list does, until a walk of this test's
    // time has finished.
    await expect.poll(async () => {
      await a.page.request.get("/api/shapes/items?offset=-1")
      return outcomes(logs, "github.reconcile", walked)
    }, { timeout: 12 * 60_000, intervals: [30_000] }).toEqual(expect.arrayContaining([expect.stringMatching(/^(complete|partial)$/)]))
    // A walk failed or refused would be among them; none may be.
    const walks = await outcomes(logs, "github.reconcile", walked)
    expect(walks.filter((outcome) => !["complete", "partial", "superseded"].includes(String(outcome)))).toEqual([])
    await a.page.reload()
    await expect(issueLinks(a.page).first()).toBeVisible({ timeout: 60_000 })
    await issuesLoadingIsSpecified(a.page)
  } finally {
    await logs.dispose()
  }
})

test("webhook: a signed issues delivery starts github/Apply, which reads the issue back from GitHub", {
  annotation: { type: "summary", description: "A GitHub delivery for an issue re-reads it into the app." },
}, async ({ devices, request }) => {
  requires("githubApp", "member", "webhookSecret", "localLogs")
  test.setTimeout(5 * 60_000)
  const logs = await LogTail.start()
  try {
    const [a] = await devices.open("A")
    await a.page.goto(`/${REPOSITORY}/issues`)
    const href = await issueLinks(a.page).first().getAttribute("href", { timeout: 10 * 60_000 })
    await issuesLoadingIsSpecified(a.page)
    const number = Number(href!.slice(href!.lastIndexOf("/") + 1))
    const deliveryId = randomUUID()
    const body = JSON.stringify({ action: "edited", issue: { number }, repository: { full_name: REPOSITORY } })
    const signature = createHmac("sha256", process.env.E2E_GITHUB_WEBHOOK_SECRET!).update(body).digest("hex")
    const delivered = await request.post("/api/github/webhook", {
      headers: {
        "content-type": "application/json",
        "x-github-event": "issues",
        "x-github-delivery": deliveryId,
        "x-hub-signature-256": `sha256=${signature}`,
      },
      data: body,
    })
    expect(delivered.status()).toBe(200)
    const forDelivery = (record: LogRecord) => field(record, "deliveryId") === deliveryId
    await expect.poll(() => outcomes(logs, "github.webhook", forDelivery), { timeout: 60_000 }).toEqual(["applied"])
    await expect.poll(() => outcomes(logs, "github.apply", forDelivery), { timeout: 3 * 60_000, intervals: [2_000] })
      .toEqual([expect.stringMatching(/^(applied|unchanged)$/)])
  } finally {
    await logs.dispose()
  }
})

test("spend alert: a Member's question spends, and the window's ops/SpendAlert records the alert when it ends", {
  annotation: { type: "summary", description: "Model spend records one alert per window, for Admins." },
}, async ({ devices }) => {
  requires("personalModel", "member", "localLogs", "longRun")
  test.setTimeout(25 * 60_000)
  const logs = await LogTail.start()
  try {
    const [a] = await devices.open("A")
    const question = `Reply with the word spend-${devices.word}.`
    await a.askAndWaitTaken(question)
    await a.expectAnswered(question, `spend-${devices.word}`, 120_000)
    // The alert's flow waits out its window (15 minutes in production), then records it: an Admin's toast, and
    // email or Telegram when an Admin saved a destination.
    await expect.poll(() => outcomes(logs, "model.spend.alert"), { timeout: 20 * 60_000, intervals: [10_000] })
      .toContain("recorded")
  } finally {
    await logs.dispose()
  }
})

test("answer expiry: an answer whose device left settles Couldn't answer once chat/Expire's wait ends", {
  annotation: { type: "summary", description: "An answer abandoned by its device settles as failed on every device." },
}, async ({ devices }) => {
  requires("personalModel", "member", "localLogs", "longRun")
  test.setTimeout(35 * 60_000)
  const logs = await LogTail.start()
  try {
    const [a] = await devices.open("A")
    const question = `Count slowly to one hundred, then write expire-${devices.word}.`
    await a.askAndWaitTaken(question)
    // The device that answers it goes away before it answers.
    await a.close()
    // `chat/Expire` waits ANSWER_EXPIRY (25 minutes) of a still queue, then settles the answer.
    await expect.poll(() => outcomes(logs, "chat.answer.expire"), { timeout: 30 * 60_000, intervals: [15_000] })
      .toContain("abandoned")
    const [b] = await devices.open("B")
    await b.expectFailed(question, 120_000)
  } finally {
    await logs.dispose()
  }
})

test("role check: a session whose role is an hour old is checked again on its next request", {
  annotation: { type: "summary", description: "A signed-in person's role is re-read from GitHub every hour." },
}, async ({ devices }) => {
  requires("githubApp", "member", "localLogs", "longRun")
  // The session's role was read when it signed in; ROLE_RECHECK_MINUTES (60) after that, its next request checks it.
  test.setTimeout(70 * 60_000)
  const logs = await LogTail.start()
  try {
    const [a] = await devices.open("A")
    // A request a minute, as a person reading the page makes, until one starts the check and it has asked GitHub.
    await expect.poll(async () => {
      await a.page.goto(`/${REPOSITORY}/issues`)
      return outcomes(logs, "auth.role_check", (record) => field(record, "step") === "check")
    }, { timeout: 66 * 60_000, intervals: [60_000] }).toContain("checked")
    // The account's role on GitHub didn't change, so neither did the session's.
    expect(await (await a.page.request.get("/api/auth/session")).json()).toMatchObject({ signedIn: true, role: me().role })
  } finally {
    await logs.dispose()
  }
})

/** The repository a TODO run writes a branch and a pull request to: a scratch one, never smithersai's. */
const TODO_REPOSITORY = process.env.E2E_TODO_REPOSITORY ?? "roninjin10/smithers-github-tests"

test("todo run: a TODO committed on the stack runs on Cloudflare to an open pull request, and Drop closes it", {
  annotation: { type: "summary", description: "A TODO runs to a pull request on GitHub; dropping it closes the pull request." },
}, async ({ devices }) => {
  requires("personalModel", "githubApp", "member", "longRun")
  expect(TODO_REPOSITORY, "a TODO run writes to GitHub: never a smithersai repository").not.toMatch(/^smithersai\//i)
  test.setTimeout(45 * 60_000)
  const word = devices.word
  const [a] = await devices.open("A")
  const stack = a.page.getByRole("region", { name: `${TODO_REPOSITORY} stack` })
  const row = stack.locator("[data-slot=issues-row]", { hasText: word })
  const title = `README line ${word}`
  await a.page.goto(`/${TODO_REPOSITORY}/stack`)
  await expect(stack).toBeVisible({ timeout: 60_000 })

  // A person writes the TODO and commits it; the stack's writer starts its `todo` run on Cloudflare.
  await a.page.getByRole("button", { name: "New TODO" }).click()
  const draft = a.page.getByRole("form", { name: "TODO draft" }).first()
  await draft.getByLabel("Title").fill(title)
  await draft.getByLabel("Prompt").fill(`Append one line that says ${word} to the end of README.md. Change nothing else.`)
  await draft.getByRole("button", { name: "Commit" }).click()
  await expect(row).toContainText(/T\d+/, { timeout: 60_000 })
  const number = (await row.textContent())!.match(/T(\d+)/)![1]!

  // Working: the branch on GitHub, its machine's checkout from GitHub, the agent; then In review with its pull request.
  await expect(row).toHaveAttribute("data-status", "running", { timeout: 5 * 60_000 })
  await row.getByRole("link", { name: title }).click()
  const todo = a.page.getByRole("article", { name: new RegExp(title) })
  await expect(todo).toHaveAttribute("data-status", "in_review", { timeout: 35 * 60_000 })
  const link = a.page.getByRole("link", { name: /^#\d+$/ })
  await expect(link).toBeVisible({ timeout: 60_000 })
  const pr = Number((await link.textContent())!.slice(1))
  const pull = async () =>
    (await (await a.page.request.get(`https://api.github.com/repos/${TODO_REPOSITORY}/pulls/${pr}`)).json()) as {
      state: string
      merged: boolean
      head: { ref: string }
    }
  expect(await pull()).toMatchObject({ state: "open", merged: false, head: { ref: expect.stringMatching(new RegExp(`^smithers/t${number}-`)) } })

  // A person drops it: the run closes the pull request it opened, as the App, and the TODO shows Dropped.
  await todo.getByRole("button", { name: "Drop", exact: true }).click()
  await a.page.getByRole("dialog", { name: `Drop T${number}?` }).getByRole("button", { name: "Drop", exact: true }).click()
  await expect(todo).toHaveAttribute("data-status", "dropped", { timeout: 60_000 })
  await expect.poll(async () => (await pull()).state, { timeout: 5 * 60_000, intervals: [15_000] }).toBe("closed")
})
