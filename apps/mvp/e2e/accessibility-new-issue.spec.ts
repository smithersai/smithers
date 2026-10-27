import { expect } from "@playwright/test"
import { test } from "./fixtures"
import { requires, syncedRepository } from "./target"

test("New issue focuses Title and preserves Description while typing", async ({ page }) => {
  requires("member", "githubApp", "syncedRepository")
  await page.goto(`/${syncedRepository()}/issues`)
  await page.getByRole("link", { name: "New issue", exact: true }).focus()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toBeFocused()
  const body = page.getByRole("textbox", { name: "Description", exact: true })
  await body.focus()
  await page.keyboard.type("Keyboard draft")
  await expect(body).toBeFocused()
})
