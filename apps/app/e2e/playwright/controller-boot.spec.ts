import { expect, test } from "@playwright/test"

test("fresh cloud tutorial controls work while identity is still loading", async ({ page }) => {
  let release!: () => void
  let reached!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const requested = new Promise<void>(resolve => { reached = resolve })
  let bootstrapReads = 0
  let identityReads = 0
  await page.route("**/api/bootstrap", route => {
    bootstrapReads++
    return route.fulfill({ json: {
      apiVersion: 1, host: "cloud", version: "test", buildSha: "test",
      capabilities: ["identity"], authFlow: "redirect", sandbox: null,
    } })
  })
  await page.route("**/api/auth/session", async route => {
    identityReads++
    reached()
    await held
    await route.fulfill({ json: { status: "signed-out" } })
  })
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" })
    await requested
    await expect(page.getByRole("button", { name: "Show issues", exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: "Skip tutorial", exact: true })).toBeVisible()
    await page.getByRole("button", { name: "Show issues", exact: true }).click()
    await expect(page.locator('.guide-transcript [data-kind="issue-list"]')).toBeVisible()
    expect(bootstrapReads).toBe(1)
    expect(identityReads).toBe(1)
  } finally {
    release()
  }
})
