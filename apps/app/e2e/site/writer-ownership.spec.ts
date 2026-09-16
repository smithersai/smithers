import { expect, test } from "@playwright/test"

test("keyboard takeover at the Astro root consumes its intent and restores the saved app", async ({ context, page }) => {
  const errors: string[] = []
  context.on("page", tab => tab.on("pageerror", error => errors.push(error.message)))
  page.on("pageerror", error => errors.push(error.message))
  await context.route("**/api/recommend", route => route.fulfill({ json: { suggestions: [] } }))
  await context.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["identity"], authFlow: "redirect", sandbox: null,
  } }))
  await context.route("**/api/auth/session", route => route.fulfill({ json: { status: "signed-out" } }))
  await page.goto("/")
  await page.getByRole("link", { name: "Start Here", exact: true }).focus()
  await page.keyboard.press("Enter")
  await expect(page.getByTestId("first-run-actions")).toBeVisible()
  await page.keyboard.press("ControlOrMeta+k")
  const input = page.locator('textarea[aria-label="Chat message"]')
  await input.fill("/issues.list")
  await input.press("Enter")
  await expect(page.getByTestId("card-practice-issues")).toBeVisible()

  const second = await context.newPage()
  await second.goto("/?tutorial")
  await expect(second.getByRole("heading", { name: "Smithers is open in another tab" })).toBeVisible()
  await second.getByRole("button", { name: "Use Smithers here" }).focus()
  await second.keyboard.press("Enter")
  await expect(second.getByTestId("card-practice-issues")).toBeVisible()
  await expect(page.getByRole("heading", { name: "Smithers moved to another tab" })).toBeVisible()

  // This document has no query marker: its explicit request must cross the landing boundary.
  await expect(page).toHaveURL("/")
  await page.getByRole("button", { name: "Use Smithers here" }).focus()
  await page.keyboard.press("Enter")
  await expect(page.getByTestId("card-practice-issues")).toBeVisible()
  await expect(second.getByRole("heading", { name: "Smithers moved to another tab" })).toBeVisible()
  expect(await page.evaluate(() => sessionStorage.getItem("smithers.writer-takeover"))).toBeNull()

  // Ordinary reload still shows the landing: taking over is a one-shot action.
  await page.reload()
  await expect(page.getByRole("link", { name: "Start Here", exact: true })).toBeVisible()
  expect(errors).toEqual([])
})
