import { type APIRequestContext, request as requests } from "@playwright/test"
import { createHash, randomBytes } from "node:crypto"
import { ADMIN_RECEIPTS_ROUTE } from "../src/features/runners/contract"
import { expect, test } from "./fixtures"
import { adminWrite } from "./runner"
import { baseURL, requires } from "./target"

// The deploy smoke's check of registration (decision 0148, docs/infrastructure.md#the-deploy-smoke): the test account, an
// Admin of its own scratch repository by GitHub's role, registers a runner and names an agent through the fenced routes,
// and each counts. What a route can see stands in for the row: the runner's receipt says it was set, and an agent reads only
// while its `reconfirm_at` (migration `0097_runner_reconfirmation`) is null. Both are retired after, however the test ended.
// No overflow: turning one on can start a box.
//
// It never claims, so `repo_authorized_at` isn't proved here (agent-runner.spec.ts does that): a claim marks a runner seen,
// and a seen runner gone quiet raises a Runner offline alert, which a smoke check must never do. It holds only a digest of
// a token no process kept. It starts no runner and never asks for a git credential. The agent never codes (`coding: false`),
// so what TODOs code with doesn't change. The name is new each run, so nothing else can hold it and a write replaces
// nothing. A killed worker never reaches its cleanup: what it leaves is a runner never seen, which no alert selects and no
// process holds a token for, until the next deployment run's setup sweeps `e2e-` names (cleanScratch), which also removes
// an agent of a retired `e2e-smoke-` runner, since a PUT that never answered can land after this run retired both. The routes retire
// by marking, so what stays is one removed `runners` row a run and the change records and receipts every Admin action keeps.

requires("runnerRegistration")

const repo = process.env.E2E_FACTORY_REPOSITORY ?? ""
const NAME = `e2e-smoke-${randomBytes(8).toString("hex")}`
/** A write lands seconds after its 202 (e2e/runner.ts). */
const LANDS_WITHIN_MS = 60_000
/** How long a retirement waits for one receipt before asking again, and for all of them. */
const RETIRE_RECEIPT_MS = 20_000
const RETIRES_WITHIN_MS = 60_000
/** How long a write whose answer never came gets to reach the routes' fence read before the retirement. No route bounds this. */
const LATE_WRITE_MS = 60_000

let api: APIRequestContext | undefined
/** A write was sent and no answer came, so it may still be on its way. */
let unanswered = false

/** How the action `execution` ended: its receipt, 404 until then. */
const outcomeOf = async (session: APIRequestContext, execution: string, timeout = LANDS_WITHIN_MS) => {
  let outcome: string | undefined
  await expect.poll(async () => {
    const response = await session.get(new URL(`${ADMIN_RECEIPTS_ROUTE}${encodeURIComponent(execution)}`, baseURL).href)
    if (response.status() === 200) outcome = ((await response.json()) as { readonly outcome: string }).outcome
    return response.status()
  }, { timeout }).toBe(200)
  return outcome!
}

/** Retires `path`: a raced write, a refusal or a request that failed is asked again until the retirement itself lands. */
const retire = async (session: APIRequestContext, path: string) => {
  await expect.poll(async () => {
    try {
      return await outcomeOf(session, await adminWrite(session, repo, path, "DELETE"), RETIRE_RECEIPT_MS)
    } catch {
      return "no answer"
    }
  }, { timeout: RETIRES_WITHIN_MS, intervals: [1_000] }).toMatch(/^(removed|missing)$/)
}

/**
 * Sets `path`, and answers how it ended. A write still on its way when the test ends is seen by afterEach: a retirement
 * fences a write the route has already read the generation for, not one that reads it after, which would find the bumped
 * generation and land.
 */
const put = async (session: APIRequestContext, path: string, body: unknown) => {
  unanswered = true
  const execution = await adminWrite(session, repo, path, "PUT", body)
  unanswered = false
  return outcomeOf(session, execution)
}

/**
 * The agent, then the runner, and the runner only once the agent is gone: the setup's sweep finds an agent through its
 * runner (cleanScratch), so a runner retired first could strand it.
 */
const retireBoth = async (session: APIRequestContext) => {
  await retire(session, `agents/${NAME}`)
  await retire(session, `runners/${NAME}`)
}

// Not a `finally`: a test out of time is abandoned where it stands, and this still runs, on the session's own context.
test.afterEach(async () => {
  if (api === undefined) return
  const session = api
  try {
    if (unanswered) await new Promise((resolve) => setTimeout(resolve, LATE_WRITE_MS))
    await retireBoth(session)
    expect((await session.get(new URL(`/api/repos/${repo}/agents/${NAME}`, baseURL).href)).status(), "the removed agent").toBe(404)
  } finally {
    await session.dispose()
    api = undefined
    unanswered = false
  }
})

test("an Admin registers a runner and an agent through the fenced routes, each counts, and both are retired", async ({ page }) => {
  // Two writes, then at worst the wait for a late write and both retirements, which share this time when the test ends in it.
  test.setTimeout(300_000)
  api = await requests.newContext({ baseURL, storageState: await page.context().storageState(), ignoreHTTPSErrors: test.info().project.use.ignoreHTTPSErrors })
  const tokenSha256 = createHash("sha256").update(randomBytes(32)).digest("hex")
  expect(await put(api, `runners/${NAME}`, { tokenSha256, labels: [], capacity: 1 })).toBe("set")
  expect(await put(api, `agents/${NAME}`, { labels: [], profile: "smoke", coding: false })).toBe("set")
  const agent = await api.get(new URL(`/api/repos/${repo}/agents/${NAME}`, baseURL).href)
  expect([agent.status(), await agent.json()]).toEqual([200, { name: NAME, coding: false }])
})
