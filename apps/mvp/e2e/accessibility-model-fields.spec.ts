import { expect } from "@playwright/test"
import { test } from "./fixtures"
import { openAdd } from "./personal-model"
import { requires } from "./target"

test("model credentials have unique accessible names", async ({ page }) => {
  requires("member")
  await page.goto("/app/settings")
  const dialog = await openAdd(page.getByRole("region", { name: "Your model", exact: true }), page, "api_key")
  await expect(dialog.getByRole("textbox", { name: "Base URL", exact: true })).toHaveCount(1)
  await expect(dialog.getByLabel("Key", { exact: true })).toHaveCount(1)
})
