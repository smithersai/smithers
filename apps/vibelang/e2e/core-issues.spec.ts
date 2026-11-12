// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
// A maintainer's VIP decisions through the mock's real issue host (src/core/IssuesFactory.vibe, issueGraphDecision's
// accept and decline over conversation.vibe's approveVip and declineVip).
import { expect, test } from "./coverage"
import type { Page } from "./coverage"

async function openVip(page: Page) {
  await page.goto("/?agent=mock")
  await page.getByRole("combobox", { name: "Visit as" }).selectOption("maintainer")
  await expect(page.locator(".vl-nav-role")).toHaveText("Maintainer")
  await page.getByRole("button", { name: "Issues", exact: true }).click()
  await page.getByRole("radio", { name: "VIPs", exact: true }).click()
  await page.getByRole("link", { name: "Pattern matching in case", exact: true }).click()
  await expect(page.locator(".sui-item-conv-header")).toContainText("VIP · In review")
}

test("a maintainer declines a VIP in review, which closes it", async ({ page }) => {
  await openVip(page)
  await page.getByRole("button", { name: "Decline", exact: true }).click()
  await expect(page.locator(".sui-item-conv-header")).toContainText("VIP · Declined")
  await expect(page.locator(".sui-item-conv-state")).toHaveText("Closed")
  await expect(page.getByRole("button", { name: "Decline", exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0)
})

test("a maintainer accepts a VIP in review", async ({ page }) => {
  await openVip(page)
  await page.getByRole("button", { name: "Accept", exact: true }).click()
  await expect(page.locator(".sui-item-conv-header")).toContainText("VIP · Accepted")
  await expect(page.locator(".sui-item-conv-state")).toHaveText("Open")
  await expect(page.getByRole("button", { name: "Decline", exact: true })).toHaveCount(0)
})
