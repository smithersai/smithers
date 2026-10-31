import { expect, type Page, type TestInfo } from "@playwright/test"
import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { type AlertProviders, startAlertProviders } from "../worker/test/alertProviders.ts"
import { recordActions, step, themeOf, writeManifest } from "./fixtures"
import { baseURL, requires } from "./target"
import { strictTest as test } from "./watch"

// The fleet (decision 0136, docs/features/fleet.md), end to end: an Admin registers a runner and names the coding
// agent, the spec starts that runner itself (`smthrs runner serve`) with the deterministic ACP test agent, and people
// commit TODOs. Everything is real: the app, its routes and flows, Postgres, Electric, the runner, its checkouts and the
// agent processes. The test agent stands in for a model only.
//
// 1. "lists every run": 53 runs, one stalled, one busy and 51 that end at once; the fleet lists every one, the oldest
//    (outside the newest 50) included, live on a desktop and on a 390 px phone.
// 2. "stall": with AGENT_STALL_MINUTES=1 on the server (`fleetStall`), a silent agent reads Stalled and a CPU-bound
//    quiet build does not.
// 3. "offline": killing the runner raises one Runner offline alert in the bell within 90 s, and, with a Telegram
//    stand-in the server sends to (`fleetTelegram`), one Telegram message.
//
// It runs TODOs on an external agent, so it needs S1's `agentRunner` (e2e/target.ts): a build signing in through the
// GitHub App on a scratch repository the test account administers. It never merges.

const started = new WeakMap<TestInfo, number>()
const repo = process.env.E2E_FACTORY_REPOSITORY ?? ""
const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)))
const smthrs = join(root, "packages/smithers/bin/smithers.mjs")
const testAgent = join(root, "packages/smithers/agent/test/fixtures/acp-test-agent.mjs")

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
    ...(body === undefined ? {} : { data: body }),
  })
  expect(response.status(), `${method} ${path}`).toBe(status)
}

/** A runner of this repository with the test agent, and the repository's coding agent; stopped by `stop`. */
const runner = async (page: Page, capacity: number) => {
  const word = `f${Date.now().toString(36)}`
  const state = mkdtempSync(join(tmpdir(), "fleet-e2e-"))
  const name = `e2e-${word}`
  const sha = execFileSync(process.execPath, [smthrs, "runner", "token", "--state", state], { encoding: "utf8" }).trim()
  await page.goto(`/${repo}/stack`)
  await write(page, `/api/repos/${repo}/runners/${name}`, "PUT", { tokenSha256: sha, labels: ["e2e"], capacity })
  await write(page, `/api/repos/${repo}/agents/${name}`, "PUT", { labels: ["e2e"], profile: "acp-test", coding: true })
  // Every TODO starts at once: independent lanes (decision 0132).
  await write(page, `/api/repos/${repo}/stack`, "POST", {
    opId: crypto.randomUUID(),
    op: "configure",
    lanes: 64,
    maxOpen: 500,
    base: "independent",
  })
  writeFileSync(join(state, "runner.json"), JSON.stringify({
    origin: new URL(baseURL).origin,
    name,
    capacity,
    stateDir: state,
    heartbeatSeconds: 5,
    repositories: { [`github/${repo.toLowerCase()}`]: { mirror: process.env.E2E_RUNNER_MIRROR! } },
    profiles: { "acp-test": { argv: [process.execPath, testAgent], env: { ACP_TEST_AGENT_STATE: join(state, "agent") } } },
  }))
  const child: ChildProcess = spawn(process.execPath, [smthrs, "runner", "serve", "--config", join(state, "runner.json")], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: new URL(baseURL).hostname === "localhost" ? "0" : "1" },
  })
  return {
    name,
    word,
    child,
    stop: async () => {
      await write(page, `/api/repos/${repo}/agents/${name}`, "DELETE").catch(() => undefined)
      await write(page, `/api/repos/${repo}/runners/${name}`, "DELETE").catch(() => undefined)
      child.kill("SIGKILL")
      rmSync(state, { recursive: true, force: true })
    },
  }
}

/** Commits a TODO through the stack route, as a person's press does. */
const commit = (page: Page, title: string, prompt: string) =>
  write(page, `/api/repos/${repo}/stack`, "POST", { opId: crypto.randomUUID(), op: "commit", title, prompt })

const fleet = (page: Page) => page.getByRole("table", { name: "Agent runs" })
const row = (page: Page, title: string) => fleet(page).getByRole("row").filter({ hasText: title })

test("fleet: lists every run: the oldest of 53, live on a desktop and a phone", {
  annotation: { type: "summary", description: "Every agent run of the repository shows in the fleet, past the newest 50." },
}, async ({ page }) => {
  test.setTimeout(30 * 60_000)
  const running = await runner(page, 4)
  try {
    await step("People commit 53 TODOs: one silent, one busy, 51 that end at once", async () => {
      await commit(page, `Oldest ${running.word}`, "refuse")
      await commit(page, `Silent ${running.word}`, "run `sleep 900`")
      await commit(page, `Busy ${running.word}`, "run `busy 600`")
      for (let index = 0; index < 50; index++) await commit(page, `Quick ${index} ${running.word}`, "refuse")
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
  annotation: { type: "summary", description: "A silent agent reads Stalled after a minute; a busy quiet one stays Working." },
}, async ({ page }) => {
  requires("fleetStall")
  test.setTimeout(10 * 60_000)
  const running = await runner(page, 2)
  try {
    await step("Two TODOs: one agent goes silent, one runs a quiet build", async () => {
      await commit(page, `Silent ${running.word}`, "run `sleep 900`")
      await commit(page, `Busy ${running.word}`, "run `busy 600`")
    })
    await step("The silent one reads Stalled; the busy one keeps Working", async () => {
      await page.goto(`/${repo}/-/fleet`)
      await expect(row(page, `Silent ${running.word}`)).toHaveAttribute("data-state", "stalled", { timeout: 4 * 60_000 })
      await expect(row(page, `Busy ${running.word}`)).toHaveAttribute("data-state", "working")
      await page.getByRole("button", { name: /^Notifications/ }).click()
      const panel = page.getByRole("dialog", { name: "Notifications" })
      await expect(panel.getByText(`Silent ${running.word} · Stalled`).first()).toBeVisible({ timeout: 60_000 })
    })
  } finally {
    await running.stop()
  }
})

test("fleet: offline: killing the runner raises one Runner offline alert in the bell and on Telegram", {
  annotation: { type: "summary", description: "A runner that stops answering reaches the Admins once, within 90 s." },
}, async ({ page }) => {
  requires("fleetTelegram")
  test.setTimeout(10 * 60_000)
  let providers: AlertProviders | undefined
  const running = await runner(page, 1)
  try {
    providers = await startAlertProviders(Number(new URL(process.env.E2E_FLEET_TELEGRAM_URL!).port))
    await step("An Admin sends alerts to a Telegram chat; a TODO runs", async () => {
      await write(page, "/api/alert-channels", "POST", { channel: "telegram", destinations: [process.env.E2E_FLEET_TELEGRAM_CHAT] }, 200)
      await commit(page, `Held ${running.word}`, "run `sleep 900`")
      await page.goto(`/${repo}/-/fleet`)
      await expect(row(page, `Held ${running.word}`)).toHaveAttribute("data-state", "working", { timeout: 4 * 60_000 })
    })
    const killedAt = Date.now()
    await step("The runner dies; within 90 s one Runner offline alert", async () => {
      running.child.kill("SIGKILL")
      await page.getByRole("button", { name: /^Notifications/ }).click()
      const alert = page.getByRole("dialog", { name: "Notifications" }).getByText(`Runner ${running.name} offline`)
      await expect(alert.first()).toBeVisible({ timeout: OFFLINE_WITHIN })
      expect(Date.now() - killedAt).toBeLessThanOrEqual(OFFLINE_WITHIN)
      await expect.poll(() =>
        providers!.received.filter((each) => JSON.stringify(each.body).includes(`Runner ${running.name} offline`)).length,
        { timeout: 30_000 }).toBe(1)
      // Later probes and windows start nothing more.
      await page.waitForTimeout(60_000)
      await expect(alert).toHaveCount(1)
      expect(providers!.received.filter((each) => JSON.stringify(each.body).includes(`Runner ${running.name} offline`)))
        .toHaveLength(1)
    })
  } finally {
    await running.stop()
    await providers?.close()
  }
})
