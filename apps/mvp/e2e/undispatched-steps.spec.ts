import { expect, test } from "./fixtures"
import { requires } from "./target"

requires("githubSignIn")

// An existing durable quota-failed TODO: read-only, no provider call or repository write.
const runId = process.env.E2E_UNDISPATCHED_RUN_ID ?? "todo:e345303f-5e9d-4a50-ad1f-5a6187c1fbde"

test("failed TODO: undispatched actions are skipped, while the action that ran stays failed", async ({ page }) => {
  await page.goto(`/app/runs/${encodeURIComponent(runId)}`)
  const graph = page.locator('[data-slot="flow-graph"]')
  await expect(graph.getByRole("button", { name: /implement, Failed/i })).toBeVisible({ timeout: 60_000 })
  for (const action of ["publish", "await", "settle"]) {
    await expect(graph.getByRole("button", { name: new RegExp(`${action}, Skipped`, "i") })).toBeVisible()
    await expect(graph.getByRole("button", { name: new RegExp(`${action}, Failed`, "i") })).toHaveCount(0)
  }
  await graph.getByRole("button", { name: /implement, Failed/i }).click()
  await expect(page.getByRole("tab", { name: /Logs/ })).toBeVisible()
})
