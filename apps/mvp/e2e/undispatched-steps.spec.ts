import { expect, test } from "./fixtures"
import { requires } from "./target"
import { inspectRun } from "./run-prerequisites"

requires("githubSignIn")

// An existing durable quota-failed TODO: read-only, no provider call or repository write.
const runId = process.env.E2E_UNDISPATCHED_RUN_ID

test("failed TODO: undispatched actions are skipped, while the action that ran stays failed", async ({ page }) => {
  expect(runId, "E2E_UNDISPATCHED_RUN_ID must name a verified retained TODO with legacy undispatched actions").toBeTruthy()
  const inspection = await inspectRun(page.request, runId!)
  expect(inspection.steps.find(step => step.action === "todo/Implement")).toMatchObject({ status: "failed" })
  expect(inspection.steps.find(step => step.action === "todo/Implement")!.attempts.some(attempt => attempt.state === "failed" && attempt.error !== null)).toBe(true)
  for (const action of ["todo/Publish", "todo/Await", "todo/Settle"]) {
    expect(inspection.steps.find(step => step.action === action), `${action} must really be undispatched`).toMatchObject({ attempts: [] })
  }
  await page.goto(`/app/runs/${encodeURIComponent(runId!)}`)
  const graph = page.locator('[data-slot="flow-graph"]')
  await expect(graph.getByRole("button", { name: /implement, Failed/i })).toBeVisible({ timeout: 60_000 })
  for (const action of ["publish", "await", "settle"]) {
    await expect(graph.getByRole("button", { name: new RegExp(`${action}, Skipped`, "i") })).toBeVisible()
    await expect(graph.getByRole("button", { name: new RegExp(`${action}, Failed`, "i") })).toHaveCount(0)
  }
  await graph.getByRole("button", { name: /implement, Failed/i }).click()
  await expect(page.getByRole("tab", { name: /Logs/ })).toBeVisible()
})
