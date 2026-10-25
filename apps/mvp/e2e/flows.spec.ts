import type { Page } from "@playwright/test"
import { expect, test } from "./devices"
import { requires } from "./target"

// Your own flows and their runs, end to end (docs/features/flows.md#your-own-flows, docs/features/runs.md, decision
// 0014's F1 and F7): a real browser, its own durable engine and the real model. A person drafts a flow from a prompt on
// the Flows page, saves it, runs it, watches its run page to its answer, then stops a live run and retries it; and opens
// a flow's code, runs it, relabels its step and runs that code in the QuickJS realm to its answer. No mocks. Each run
// is a few model calls: Cerebras rate-limits concurrent calls, so the steps go one after another. Drafting asks the
// agent, a Member's (worker/PersonalFlows.ts `canAsk`), and waits for the real model (`liveModel`).

requires("personalModel", "member", "liveModel")

/** The run page's state word, in the header's live region. */
const runState = (page: Page) => page.locator('[data-slot="run-header"] [role="status"]')

/** The draft card's status line, in its live region. */
const draftState = (page: Page) => page.locator('[data-slot="flow-draft-view"] [role="status"]')

/**
 * Waits for the draft's round to end: Ready or Needs you. A round that failed or stopped fails the test at once, with
 * the card's words for why (the model refused, the budget is spent, its checks failed), so a refusal by the model
 * reads as one.
 */
const roundEnded = async (page: Page) => {
  const status = draftState(page)
  await expect(status).toContainText(/Ready|Needs you|Failed|Stopped/, { timeout: 120_000 })
  const text = (await status.textContent()) ?? ""
  if (/Failed|Stopped/.test(text)) {
    const why = await page.locator(".sui-flow-draft-failure").textContent().catch(() => null)
    throw new Error(`The draft's round ended ${text.trim()}${why === null ? "" : `: ${why.trim()}`}`)
  }
  return text
}

/** Drafts `name` from `request` on the Flows page and saves it: the person's flow, back on the Flows page. */
const draftAndSave = async (page: Page, name: string, request: string) => {
  // Flows opens by its address: a deployment's device opens on the test account's branch, which has no Pages nav.
  await page.goto("/app/flows")
  await page.getByRole("link", { name: "New flow" }).click()
  await page.getByLabel("Name").fill(name)
  await page.getByLabel("What it should do").fill(request)
  await page.getByRole("button", { name: "Draft" }).click()
  await expect(page).toHaveURL(/\/app\/flows\/drafts\/[0-9a-f-]{36}$/, { timeout: 30_000 })
  // A blocking question the agent asked: take its default and answer, so the next round drafts.
  if ((await roundEnded(page)).includes("Needs you")) {
    await page.getByRole("button", { name: "Answer" }).click()
    await expect(draftState(page)).toContainText(/Drafting|Ready/, { timeout: 30_000 })
    expect(await roundEnded(page)).toContain("Ready")
  }
  // The draft is flow source: one flow.ts module.
  await expect(page.getByText("flow.ts")).toBeVisible()
  await page.getByRole("button", { name: "Save" }).click()
  await expect(page).toHaveURL(/\/app\/flows$/, { timeout: 90_000 })
  await expect(page.getByRole("button", { name: `Run ${name}` })).toBeVisible()
}

/**
 * The run graph's first node for `name`'s step `step` (`load`, `code`, `evaluate`, `call`), done: the graph names a
 * personal flow's steps by it, and the code evaluates once per round.
 */
const doneStep = (page: Page, name: string, step: string) =>
  page.getByRole("group", { name: "Run graph" }).getByRole("button", { name: `${name}/${step}, Done`, exact: true }).first()

/** Starts a run of `name` from the Flows page and waits for its run page. */
const run = async (page: Page, name: string) => {
  if (!page.url().endsWith("/app/flows")) await page.goto("/app/flows")
  await page.getByRole("button", { name: `Run ${name}` }).click()
  await expect(page).toHaveURL(/\/app\/runs\/[0-9a-f-]{36}$/, { timeout: 30_000 })
}

test("flows: draft a flow, save it, run it, watch its run page, then stop a run and retry it", async ({ devices }) => {
  test.setTimeout(300_000)
  const [a] = await devices.open("A")
  const page = a.page
  const name = `count-${Date.now().toString(36)}`

  // Draft: the form, then the card, which the drafting agent fills; Save: the flow is yours, on the Flows page.
  await draftAndSave(
    page,
    name,
    "Write the numbers from one to three hundred as English words, separated by commas, and answer with that list.",
  )

  // Run it and watch its run page follow it to its answer: its graph, the step that loaded the flow and the code that ran
  // it, and its result.
  await run(page, name)
  await expect(runState(page)).toContainText("Done", { timeout: 120_000 })
  await expect(page.getByRole("tab", { name: /^Steps/ })).toBeVisible()
  await expect(doneStep(page, name, "load")).toBeVisible()
  await expect(doneStep(page, name, "code")).toBeVisible()
  await expect(page.getByText("Result")).toBeVisible()
  await page.getByRole("tab", { name: "Journal" }).click()
  await expect(page.getByRole("table", { name: "Journal" })).toContainText("flows.engine.run-decision")
  await page.getByRole("tab", { name: "Timeline" }).click()

  // Stop a live run: Stopping, then Stopped. The model may answer before the press lands; then run it again.
  let stopped = false
  for (let attempt = 0; attempt < 3 && !stopped; attempt++) {
    await run(page, name)
    const stop = page.getByRole("button", { name: "Stop" })
    await stop.click({ timeout: 10_000 }).catch(() => undefined)
    await expect(runState(page)).toContainText(/Stopped|Done/, { timeout: 120_000 })
    stopped = (await runState(page).textContent())?.includes("Stopped") ?? false
  }
  expect(stopped, "a run stopped while it worked").toBe(true)

  // Retry the stopped run: a new run of the same flow, whose page opens and follows it.
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(page).toHaveURL(/\/app\/runs\/retry%3A.+%2Frun$/, { timeout: 30_000 })
  await expect(runState(page)).toContainText(/Working|Done/, { timeout: 60_000 })
  await expect(runState(page)).toContainText("Done", { timeout: 120_000 })

  // Runs lists every run of the flow, newest first.
  await page.goto("/app/runs")
  await expect(page.getByRole("table", { name: "Runs" })).toContainText("flow/run")
})

test("flows: Retry from here on a run's code replays its load and runs the code again to Done", async ({ devices }) => {
  test.setTimeout(300_000)
  const [a] = await devices.open("A")
  const page = a.page
  const name = `again-${Date.now().toString(36)}`
  await draftAndSave(page, name, "Answer with the single word again.")
  await run(page, name)
  await expect(runState(page)).toContainText("Done", { timeout: 120_000 })
  // The run's own journal: the load ran an attempt of its own.
  await page.getByRole("tab", { name: "Journal" }).click()
  await expect(page.getByRole("table", { name: "Journal" })).toContainText("flows.engine.attempt-started")
  await page.getByRole("tab", { name: /^Steps/ }).click()

  // The load has nothing before it, so the inspector offers no Retry from here on it; the code does.
  await doneStep(page, name, "load").click()
  await expect(page.getByRole("button", { name: "Retry from here" })).toHaveCount(0)
  await doneStep(page, name, "code").click()
  await page.getByRole("button", { name: "Retry from here" }).click()

  // A new run of its own opens and follows the code to its answer.
  await expect(page).toHaveURL(/\/app\/runs\/retry%3A.+%2Frun$/, { timeout: 30_000 })
  await expect(runState(page)).toContainText("Done", { timeout: 120_000 })
  await expect(doneStep(page, name, "load")).toBeVisible()
  await expect(doneStep(page, name, "code")).toBeVisible()
  // The load replayed: the new run records the retry and the load's finished attempt, and starts no attempt of its own.
  await page.getByRole("tab", { name: "Journal" }).click()
  const journal = page.getByRole("table", { name: "Journal" })
  await expect(journal).toContainText("flows.engine.attempt-finished")
  await expect(journal).not.toContainText("flows.engine.attempt-started")
})

test("flows: draft a flow from a prompt, open its code, run it, relabel its step, and the edited code runs to its answer", {
  annotation: { type: "summary", description: "A hand-edited flow runs in the QuickJS realm" },
}, async ({ devices }) => {
  test.setTimeout(300_000)
  const [a] = await devices.open("A")
  const page = a.page
  const name = `ready-${Date.now().toString(36)}`
  await draftAndSave(page, name, "Answer with the single word ready.")

  // Code: the flow is a typed Flow.make module named for it, with one agent step.
  await page.getByRole("link", { name: `Code ${name}` }).click()
  await expect(page).toHaveURL(new RegExp(`/app/flows/code/${name}$`))
  const code = page.getByRole("textbox", { name: "Code" })
  await expect(code).toHaveValue(new RegExp(`export default Flow\\.make\\("${name}"`), { timeout: 30_000 })
  await expect(code).toHaveValue(new RegExp(`AgentAction\\.make\\("${name}/agent"`))
  await expect(page.getByText("Needs a sandbox", { exact: true })).toHaveCount(0)

  // Run it as drafted: its run page follows it to its answer.
  await run(page, name)
  await expect(runState(page)).toContainText("Done", { timeout: 120_000 })
  await expect(doneStep(page, name, "load")).toBeVisible()

  // Relabel its step in code: it's the person's code now, which still runs here, and Save keeps it as the next revision.
  await page.goto("/app/flows")
  await page.getByRole("link", { name: `Code ${name}` }).click()
  await expect(code).toHaveValue(new RegExp(`"${name}/agent"`), { timeout: 30_000 })
  await code.fill((await code.inputValue()).replace(`"${name}/agent"`, `"${name}/answer"`))
  await expect(page.getByText("Needs a sandbox", { exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Save" }).click()
  await expect(page).toHaveURL(/\/app\/flows$/, { timeout: 90_000 })

  // Run again: the edited code runs in the realm to its answer, and its run page shows the realm's steps.
  await expect(page.getByRole("button", { name: `Run ${name}` })).toBeEnabled({ timeout: 30_000 })
  await expect(page.getByRole("row").filter({ hasText: name })).not.toContainText("Needs a sandbox")
  await run(page, name)
  await expect(runState(page)).toContainText("Done", { timeout: 120_000 })
  for (const step of ["load", "code", "evaluate", "call"]) await expect(doneStep(page, name, step)).toBeVisible()
  await expect(page.getByText("Result")).toBeVisible()
  await page.goto("/app/flows")
  await page.getByRole("link", { name: `Code ${name}` }).click()
  await expect(code).toHaveValue(new RegExp(`"${name}/answer"`), { timeout: 30_000 })
})

test("flows: delete a draft while it drafts, and it leaves your drafts", async ({ devices }) => {
  test.setTimeout(120_000)
  const [a] = await devices.open("A")
  const page = a.page
  const name = `gone-${Date.now().toString(36)}`
  await page.goto("/app/flows")
  await page.getByRole("link", { name: "New flow" }).click()
  await page.getByLabel("Name").fill(name)
  await page.getByLabel("What it should do").fill("Write the numbers from one to three hundred as English words.")
  await page.getByRole("button", { name: "Draft" }).click()
  await expect(page).toHaveURL(/\/app\/flows\/drafts\/[0-9a-f-]{36}$/, { timeout: 30_000 })
  // Delete on the card: the round stops on this device, the draft is gone, and the Flows page opens without it.
  await page.locator('[data-slot="flow-draft-view"]').getByRole("button", { name: "Delete", exact: true }).click()
  await expect(page).toHaveURL(/\/app\/flows$/, { timeout: 30_000 })
  await expect(page.getByRole("link", { name, exact: true })).toHaveCount(0, { timeout: 30_000 })
  await page.reload()
  await expect(page.getByRole("link", { name: "New flow" })).toBeVisible()
  await expect(page.getByRole("link", { name, exact: true })).toHaveCount(0)
})
