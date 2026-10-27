import { expect, test } from "./fixtures"
import { target } from "./target"
import { expectServerError } from "./watch"

for (const path of ["/nope-page", "/no-user", "/vibelang", "/admin", "/smithersai/smithers/flows", "/smithersai/smithers/flows/x", "/smithersai/smithers/runs/x", "/app/conversations/x", "/smithersai/smithers/issues/0", "/smithersai/smithers/issues/-1", "/smithersai/smithers/issues/abc", "/smithersai/smithers/pull/0", "/smithersai/smithers/%"]) {
  test(`unknown page recovers through the shell: ${path}`, async ({ page }) => {
    expectServerError(404, path)
    const response = await page.goto(path)
    if (target === "deployment") expect(response?.status()).toBe(404)
    await expect(page.getByText("Not found", { exact: true })).toBeVisible()
    await expect(page.getByRole("navigation", { name: "Pages" })).toBeVisible()
    const back = page.getByRole("link", { name: "Back to chat", exact: true })
    await expect(back).toHaveAttribute("href", "/app")
    await back.click()
    await expect(page.getByRole("main", { name: "App", exact: true })).toBeVisible()
  })
}
