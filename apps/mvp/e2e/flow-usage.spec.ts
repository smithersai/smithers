import { expect, test } from "./devices"
import { field, type LogRecord, LogTail } from "./logs"
import { partly } from "./target"

// Flow usage, end to end (docs/observability.md#flow-usage, docs/features/runs.md#flows): the real app, its engine
// worker and ChatApi, no model and no sign-in. The theme button runs `app/theme/set` on the device's durable engine,
// which records the run's start and settlement (`@smthrs/flow` `RunMetrics`) with its door, actor kind and placement;
// ChatApi's relay keeps them; and the Runs page's flows summary counts the run. No mocks.

/** The engine worker's `message` lines for `flow`, as ChatApi relayed them, with the usage fields. */
const usage = (records: Array<LogRecord>, message: string, flow: string) =>
  records
    .filter((record) => record.message === message && field(record, "flow") === flow)
    .map((record) => ({
      door: field(record, "door"),
      actor: field(record, "actor"),
      placement: field(record, "placement"),
      outcome: field(record, "outcome"),
      code: field(record, "code"),
      timed: typeof field(record, "durationMs") === "number",
    }))

test("flow usage: a button's run is counted by flow, door, actor and placement, and the Runs page sums it", {
  annotation: { type: "summary", description: "Each run records how it started and ended; Runs shows runs, success and p95 per flow." },
}, async ({ devices }) => {
  const logs = partly("localLogs") ? await LogTail.start() : undefined
  const [a] = await devices.open("A")
  const page = a.page
  await expect(page.getByRole("button", { name: "Switch to dark mode" })).toBeVisible({ timeout: 30_000 })

  await test.step("Switch to dark mode", async () => {
    await page.getByRole("button", { name: "Switch to dark mode" }).click()
    await expect(page.getByRole("button", { name: "Switch to light mode" })).toBeVisible({ timeout: 30_000 })
  })

  if (logs !== undefined) {
    await test.step("The engine recorded the run's start and end", async () => {
      await expect
        .poll(async () => usage((await logs.records()).browser, "flow.run.settled", "app/theme/set"), { timeout: 30_000 })
        .toContainEqual({ door: "button", actor: "person", placement: "browser", outcome: "succeeded", code: "none", timed: true })
      expect(usage((await logs.records()).browser, "flow.run.started", "app/theme/set")).toContainEqual(
        { door: "button", actor: "person", placement: "browser", outcome: undefined, code: undefined, timed: false },
      )
    })
  }

  await test.step("Runs sums the flow's runs", async () => {
    await page.goto("/app/runs")
    const flows = page.getByRole("table", { name: "Flows" })
    await expect(flows).toBeVisible({ timeout: 30_000 })
    const row = flows.getByRole("row").filter({ hasText: "app/theme/set" })
    await expect(row).toContainText("100%")
    await expect(row.getByRole("cell").nth(1)).toHaveText(/^[1-9]\d*$/)
    await expect(row.getByRole("cell").nth(3)).toHaveText(/\d/)
  })
})

test("runs list: a run reads like a CI run, with its trigger and actor, opens in place to its steps, and its flow lists its runs", {
  annotation: { type: "summary", description: "Runs lists each run's trigger, branch and actor; a run opens in place to its steps and logs; a flow lists its own runs." },
}, async ({ devices }) => {
  const [a] = await devices.open("A")
  const page = a.page
  // The device may keep an earlier test's theme: the button switches whichever way it points.
  const theme = page.getByRole("button", { name: /^Switch to (dark|light) mode$/ })
  await expect(theme).toBeVisible({ timeout: 30_000 })
  await test.step("Switch the theme", async () => {
    const before = await theme.getAttribute("aria-label") ?? await theme.textContent()
    await theme.click()
    await expect(theme).not.toHaveAccessibleName(before ?? "", { timeout: 30_000 })
  })

  const runs = page.getByRole("table", { name: "Runs" })
  const row = runs.locator("tr[data-run]").filter({ hasText: "app/theme/set" }).first()
  await test.step("Runs lists the theme's run with what started it and who", async () => {
    // In the app, as a person goes there: a reload would leave the run to the next leader to take over.
    await page.getByRole("navigation", { name: "Pages" }).getByRole("link", { name: "Runs", exact: true }).click()
    await expect(row).toBeVisible({ timeout: 30_000 })
    await expect(row.locator("[data-slot='run-trigger']")).toHaveText("button")
    await expect(row.locator("[data-slot='run-actor']")).toHaveText("you")
    // The list follows the engine: the run reads Done once it settles.
    await expect(row.locator("[data-slot='run-status']")).toHaveAttribute("data-word", "Done", { timeout: 30_000 })
  })

  await test.step("The run opens in place to its step", async () => {
    await row.getByRole("link", { name: "Show app/theme/set" }).click()
    await expect(page).toHaveURL(/\/app\/runs\?open=/)
    const details = runs.locator("tr[data-run-details] [data-slot='run-details']")
    await expect(details.locator("details[data-step]").filter({ hasText: "app/theme/write" })).toHaveAttribute("data-state", "completed", { timeout: 30_000 })
    await runs.getByRole("link", { name: "Hide app/theme/set" }).first().click()
    await expect(runs.locator("tr[data-run-details]")).toHaveCount(0)
  })

  await test.step("The flow lists only its own runs", async () => {
    await page.getByRole("table", { name: "Flows" }).getByRole("link", { name: "app/theme/set", exact: true }).click()
    await expect(page).toHaveURL(/flow=app%2Ftheme%2Fset/)
    const flows = await runs.locator("tr[data-run] .sui-run-list-flow").allTextContents()
    expect(flows.length).toBeGreaterThan(0)
    expect(new Set(flows)).toEqual(new Set(["app/theme/set"]))
    await page.getByRole("table", { name: "Flows" }).getByRole("link", { name: "All", exact: true }).click()
    await expect(page).toHaveURL(/\/app\/runs$/)
  })
})
