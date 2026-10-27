import { expect } from "@playwright/test"
import { test } from "./fixtures"
import { requires } from "./target"

test("model credentials have unique accessible names", async ({ page }) => {
  requires("member")
  await page.goto("/app/settings")
  for (const protocol of ["OpenAI-compatible", "Anthropic-compatible"]) {
    await expect(page.getByRole("textbox", { name: `${protocol} Base URL`, exact: true })).toBeVisible()
    await expect(page.getByLabel(`${protocol} Key`, { exact: true })).toBeVisible()
  }
})
