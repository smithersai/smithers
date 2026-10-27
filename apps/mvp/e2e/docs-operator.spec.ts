import { expect, test } from "./fixtures"
import { requires, signedOut } from "./target"

test.use(signedOut)

test("operator reference: model and sandbox defaults distinguish service bindings", async ({ page }) => {
  requires("docsSite")
  await page.goto("/docs/operator/")
  await expect(page.getByRole("heading", { level: 1, name: "Operator configuration" })).toBeVisible()
  for (const setting of ["MODEL_DAILY_TOKEN_BUDGET", "MODEL_MAX_OUTPUT_TOKENS", "SANDBOX_IDLE_SECONDS", "SANDBOX_INSTANCE"]) await expect(page.getByRole("cell", { name: setting, exact: true })).toBeVisible()
  await expect(page.locator(".sl-markdown-content")).toContainText("service binding, not a URL environment variable")
})
