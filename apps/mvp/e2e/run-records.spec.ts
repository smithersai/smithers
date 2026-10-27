import { expect, test } from "./fixtures"
import { requires } from "./target"

// Read-only regression against the test account's retained bug-bash runs.
// No launch, provider call, or repository write is required.
requires("githubSignIn", "member")

test("failed history opens on its failure with records and consistent skipped steps", async ({ page }) => {
  await page.goto("/app/runs")
  const rows = page.getByRole("table", { name: "Runs", exact: true }).locator("tr[data-run]")
  const failed = rows.filter({ has: page.getByText("Failed", { exact: true }) }).first()
  await expect(failed).toBeVisible()
  await failed.locator(".sui-run-list-flow a").click()
  const graph = page.getByRole("group", { name: "Run graph" })
  await expect(graph).toBeVisible()
  await expect(graph.locator('[data-state="failed"]').first()).toHaveAttribute("aria-pressed", "true")
  const inspector = page.locator('[data-slot="step-inspector"]')
  await expect(inspector.locator(".sui-span-detail-attempts")).toBeVisible()
  await expect(inspector.locator(".sui-span-detail-attempts")).not.toHaveText("")
  await expect(graph.locator('[data-state="skipped"]').first()).toHaveAttribute("aria-label", /, Skipped$/)
  for (const detail of await page.locator('details[data-slot="json-value"]').all()) await expect(detail).not.toHaveAttribute("open")
})

test("repository history returns to personal Runs and keeps engine names in details", async ({ page }) => {
  await page.goto("/app/runs")
  const link = page.getByRole("table", { name: "Runs", exact: true }).locator('.sui-run-list-flow a[href*="/actions/runs/"]').first()
  await expect(link).toBeVisible()
  await link.click()
  await expect(page.getByRole("group", { name: "Run graph" })).toBeVisible()
  await expect(page.getByRole("link", { name: "Runs", exact: true })).toHaveAttribute("href", "/app/runs")
  await page.getByRole("tab", { name: "Journal", exact: true }).click()
  const events = page.locator(".sui-run-journal-type summary")
  await expect(events.first()).toBeVisible()
  for (const summary of await events.all()) await expect(summary).not.toHaveText(/flows\.|telemetry\./)
})
