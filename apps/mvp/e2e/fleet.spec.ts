import { expect, type Page, type TestInfo } from "@playwright/test"
import { type AlertProviders, startAlertProviders } from "../worker/test/alertProviders.ts"
import { recordActions, step, themeOf, writeManifest } from "./fixtures"
import { cleanUp, startRunner } from "./runner"
import { dropWord, stackChange } from "./stackWrites"
import { baseURL, partly, requires, stallMinutes, writeHeaders } from "./target"
import { strictTest as test } from "./watch"

// The fleet (decision 0143, docs/features/fleet.md), end to end: an Admin registers a runner and names the coding
// agent, the spec starts that runner itself (`smthrs runner serve`) with the deterministic ACP test agent, and people
// commit TODOs. Everything is real: the app, its routes and flows, Postgres, Electric, the runner, its checkouts and the
// agent processes. The test agent stands in for a model only.
//
// 1. "lists every run": 53 runs, one stalled, one busy and 51 that end at once; the fleet lists every one, the oldest
//    (outside the newest 50) included, live on a desktop and on a 390 px phone.
// 2. "stall": a silent agent reads Stalled and a CPU-bound quiet build does not. It waits out the server's own
//    AGENT_STALL_MINUTES (`fleetStall`): 1 where a stack is started so, a deployment's 10 with E2E_LONG=1.
// 3. "offline": killing the runner raises one Runner offline alert in the bell within 90 s, and, with a Telegram
//    stand-in the server sends to (E2E_FLEET_TELEGRAM_URL and E2E_FLEET_TELEGRAM_CHAT), one Telegram message. A
//    deployment's real Telegram can't be read back, so there the bell is the proof.
//
// It runs TODOs on an external agent, so it needs S1's `agentRunner` (e2e/target.ts): a build signing in through the
// GitHub App on a scratch repository the test account administers. It never merges.

const started = new WeakMap<TestInfo, number>()
const repo = process.env.E2E_FACTORY_REPOSITORY ?? ""

/** The most an outage takes to reach the bell (FINAL.md §7, S5). */
const OFFLINE_WITHIN = 90_000

test.beforeEach(async ({ page }, info) => {
  started.set(info, Date.now())
  requires("agentRunner")
  await page.emulateMedia({ colorScheme: themeOf(info) })
  await recordActions(page, info, "Maya")
})

test.afterEach(async ({}, info) => {
  await writeManifest(info, "flow.json", started.get(info) ?? Date.now(), [{ name: "Maya", video: "video.webm", openedAt: 0 }])
})

/** An Admin's write to the repository, as the signed-in page; it must answer `status`. */
const write = async (page: Page, path: string, method: "PUT" | "DELETE" | "POST", body?: unknown, status = 202) => {
  const response = await page.request.fetch(new URL(path, baseURL).href, {
    method,
    headers: writeHeaders(),
    ...(body === undefined ? {} : { data: body }),
  })
  expect(response.status(), `${method} ${path}`).toBe(status)
}

/** A runner of this repository with the test agent, the repository's coding agent, and a stack of independent lanes. */
const runner = async (page: Page, capacity: number) => {
  const word = `f${Date.now().toString(36)}`
  await page.goto(`/${repo}/stack`)
  const started = await startRunner(page, repo, word, capacity, { heartbeatSeconds: 5 })
  // Every TODO starts at once: independent lanes (decision 0135).
  const api = { request: started.api }
  const configure = (lanes: number, maxOpen: number, base: "independent" | "stacked") =>
    stackChange(api, repo, { op: "configure", lanes, maxOpen, base })
  expect(await configure(64, 500, "independent")).toMatchObject({ status: 202 })
  const numbers: Array<number> = []
  return {
    ...started,
    word,
    /** Commits a TODO, as a person's press does. */
    commit: async (title: string, prompt: string) => {
      const answer = await stackChange(api, repo, { op: "commit", title, prompt })
      expect(answer, `commit ${title}`).toMatchObject({ status: 202, body: { outcome: "committed" } })
      numbers.push(answer.body.number!)
    },
    /** The repository as the spec found it: no TODO of this run open, one stacked lane, Smithers' own agent. */
    stop: () =>
      cleanUp(
        ...numbers.reverse().map((number) => () => stackChange(api, repo, { op: "drop", number })),
        () => dropWord(api, repo, word),
        () => configure(1, 200, "stacked"),
        started.stop,
      ),
  }
}

const fleet = (page: Page) => page.getByRole("table", { name: "Agent runs" })
const row = (page: Page, title: string) => fleet(page).getByRole("row").filter({ hasText: title })

test("fleet: lists every run: the oldest of 53, live on a desktop and a phone", {
  annotation: { type: "summary", description: "Every agent run of the repository shows in the fleet, past the newest 50." },
}, async ({ page }) => {
  test.setTimeout(30 * 60_000)
  const running = await runner(page, 4)
  try {
    await step("People commit 53 TODOs: one silent, one busy, 51 that end at once", async () => {
      await running.commit(`Oldest ${running.word}`, "refuse")
      await running.commit(`Silent ${running.word}`, "run `sleep 900`")
      await running.commit(`Busy ${running.word}`, "run `busy 600`")
      for (let index = 0; index < 50; index++) await running.commit(`Quick ${index} ${running.word}`, "refuse")
    })
    await step("The fleet lists every run, live", async () => {
      await page.goto(`/${repo}/-/fleet`)
      await expect(row(page, `Silent ${running.word}`)).toHaveAttribute("data-state", /working|stalled/, { timeout: 5 * 60_000 })
      await expect(row(page, `Oldest ${running.word}`)).toHaveAttribute("data-state", "failed", { timeout: 15 * 60_000 })
      await expect(fleet(page).getByRole("row").filter({ hasText: running.word })).toHaveCount(53, { timeout: 15 * 60_000 })
      await expect(page.getByRole("table", { name: "Machines" }).getByRole("row").filter({ hasText: running.name }))
        .toHaveAttribute("data-state", "online")
    })
    await step("On a phone, the same rows", async () => {
      await page.setViewportSize({ width: 390, height: 844 })
      await expect(row(page, `Oldest ${running.word}`)).toBeVisible()
      await expect(row(page, `Busy ${running.word}`)).toHaveAttribute("data-state", "working")
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    })
  } finally {
    await running.stop()
  }
})

test("fleet: stall: a silent agent reads Stalled, a quiet CPU-bound build does not", {
  annotation: { type: "summary", description: "A silent agent reads Stalled after the deployment's window; a busy quiet one stays Working." },
}, async ({ page }) => {
  requires("fleetStall")
  const window = stallMinutes() * 60
  // The window, then the probes' 30 s and the fleet's own read.
  const stalled = (window + 180) * 1000
  test.setTimeout(stalled + 6 * 60_000)
  const running = await runner(page, 2)
  try {
    await step("Two TODOs: one agent goes silent, one runs a quiet build", async () => {
      await running.commit(`Silent ${running.word}`, `run \`sleep ${window + 300}\``)
      await running.commit(`Busy ${running.word}`, `run \`busy ${window + 300}\``)
    })
    await step("The silent one reads Stalled; the busy one keeps Working", async () => {
      await page.goto(`/${repo}/-/fleet`)
      await expect(row(page, `Silent ${running.word}`)).toHaveAttribute("data-state", "stalled", { timeout: stalled })
      await expect(row(page, `Busy ${running.word}`)).toHaveAttribute("data-state", "working")
      await page.getByRole("button", { name: /^Notifications/ }).click()
      const panel = page.getByRole("dialog", { name: "Notifications" })
      await expect(panel.getByText(`Silent ${running.word} · Stalled`).first()).toBeVisible({ timeout: 60_000 })
    })
  } finally {
    await running.stop()
  }
})

test("fleet: offline: killing the runner raises one Runner offline alert in the bell", {
  annotation: { type: "summary", description: "A runner that stops answering reaches the Admins once, within 90 s." },
}, async ({ page }) => {
  test.setTimeout(10 * 60_000)
  let providers: AlertProviders | undefined
  const running = await runner(page, 1)
  try {
    // A deployment's real Telegram can't be read back: there the bell is the proof, and the summary says so.
    if (partly("fleetTelegram")) providers = await startAlertProviders(Number(new URL(process.env.E2E_FLEET_TELEGRAM_URL!).port))
    await step("A TODO runs on the runner", async () => {
      if (providers !== undefined) {
        await write(page, "/api/alert-channels", "POST", { channel: "telegram", destinations: [process.env.E2E_FLEET_TELEGRAM_CHAT] }, 200)
      }
      await running.commit(`Held ${running.word}`, "run `sleep 900`")
      await page.goto(`/${repo}/-/fleet`)
      await expect(row(page, `Held ${running.word}`)).toHaveAttribute("data-state", "working", { timeout: 4 * 60_000 })
    })
    const killedAt = Date.now()
    await step("The runner dies; within 90 s one Runner offline alert", async () => {
      running.kill()
      await page.getByRole("button", { name: /^Notifications/ }).click()
      const alert = page.getByRole("dialog", { name: "Notifications" }).getByText(`Runner ${running.name} offline`)
      await expect(alert.first()).toBeVisible({ timeout: OFFLINE_WITHIN })
      test.info().annotations.push({ type: "offline", description: `${Date.now() - killedAt} ms after the kill` })
      expect(Date.now() - killedAt).toBeLessThanOrEqual(OFFLINE_WITHIN)
      const sent = () => providers?.received.filter((each) => JSON.stringify(each.body).includes(`Runner ${running.name} offline`)).length
      if (providers !== undefined) await expect.poll(sent, { timeout: 30_000 }).toBe(1)
      // Later probes and windows start nothing more.
      await page.waitForTimeout(60_000)
      await expect(alert).toHaveCount(1)
      if (providers !== undefined) expect(sent()).toBe(1)
    })
  } finally {
    await running.stop()
    await providers?.close()
  }
})
