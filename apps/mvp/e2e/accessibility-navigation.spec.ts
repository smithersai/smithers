import { expect } from "@playwright/test"
import { test } from "./fixtures"

test("route navigation focuses its heading", async ({ page }) => {
  await page.goto("/app")
  const flows = page.getByRole("navigation", { name: "Pages" }).getByRole("link", { name: "Flows", exact: true })
  await flows.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused()
})
