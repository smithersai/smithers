// Stays .ts: Playwright collects browser tests by JS/TS extension only.
// Live mode loads an issue's comments when it opens. The faulty Factory (test/support/FaultyFactory.vibe) runs the live
// screens over the real mock and fails the first details read once.
import { expect, test } from "./coverage"

test("a failed comment load says so, and opening the issue again loads it", async ({ page }) => {
  await page.goto(`http://127.0.0.1:${Number(process.env.E2E_PORT ?? 4173)}/e2e/runtime/index.html?fault=live-details`)
  await page.getByRole("button", { name: "Issues", exact: true }).click()
  await page.getByRole("link", { name: "Case branches on tuples", exact: true }).click()
  await expect(page.getByRole("heading", { name: "#42", exact: true })).toBeVisible()
  await expect(page.getByRole("alert")).toContainText("Couldn't load comments. Retry.")
  await page.getByRole("link", { name: "‹ Issues", exact: true }).click()
  await page.getByRole("link", { name: "Case branches on tuples", exact: true }).click()
  await expect(page.getByRole("heading", { name: "#42", exact: true })).toBeVisible()
  await expect(page.getByRole("alert")).toHaveCount(0)
})
