import { expect, test } from "./fixtures"
import { requires, signedOut } from "./target"

test.use(signedOut)

test("repository README renders sanitized HTML and hides comments", async ({ page }) => {
  requires("codeStorage")
  await page.goto("/smithersai/smithers/blob/main/README.md")
  const preview = page.locator(".sui-markdown-editor[data-readonly]")
  await expect(preview.locator("pre")).toContainText("██", { timeout: 30_000 })
  await expect(preview.locator("strong")).toContainText("Automate maintaining your codebase")
  await expect(preview).not.toContainText("<!--")
  await expect(preview).not.toContainText('<pre align="center">')
  await expect(preview.locator("script, style, [onclick], [onerror]")).toHaveCount(0)
})
