import { expect } from "@playwright/test"
import { test } from "./fixtures"

test("chat has one named live message log", async ({ page }) => {
  await page.goto("/app")
  await expect(page.getByRole("log", { name: "Messages", exact: true })).toHaveCount(1)
  await expect(page.getByRole("log")).toHaveCount(1)
  await expect(page.getByRole("log").getByRole("navigation")).toHaveCount(0)
})
