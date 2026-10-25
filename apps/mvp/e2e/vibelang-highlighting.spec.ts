import { expect, step, test } from "./fixtures"
import { requires } from "./target"

requires("codeStorage", "member")

// Read-only, pinned public VibeLang examples through the real repository view.
const revision = "3ad97368713b9a1fab1fa408388a017687aa7431"
const examples = [
  { path: "typescript/vibelang/cases/decl-schema-error-family/main.vibe", words: ["error", "NotStored", "extends", "StoreError"] },
  { path: "typescript/vibelang/cases/decl-schema-alias/main.vibe", words: ["schema", "Code"] },
  { path: "packages/compiler/test/eslint/fixtures/modules.vibe", words: ["module", "text"] },
] as const

test("VibeLang: inherited errors, schema aliases and module escapes have colour", {
  annotation: { type: "summary", description: "Real .vibe files highlight error inheritance, schema aliases and module blocks." },
}, async ({ page }) => {
  test.setTimeout(420_000)
  for (const example of examples) {
    await step(`Read ${example.path}`, async () => {
      await page.goto(`/smithersai/vibelang/blob/${revision}/${example.path}`)
      const code = page.locator('[data-slot="code-view"]')
      const clone = page.locator('header[aria-label="Repository"]').getByRole("button", { name: "Clone" })
      await expect(code.or(clone)).toBeVisible({ timeout: 60_000 })
      if (await clone.isVisible()) await clone.click()
      await expect(code).toHaveAttribute("data-state", "ready", { timeout: 180_000 })
      for (const word of example.words) {
        // Playwright pierces pierre's shadow root; exact token boundaries ensure
        // these words aren't merely present together in an unhighlighted span.
        const token = code.locator('span[style*="color"]').filter({ hasText: new RegExp(`^${word}$`) }).first()
        await expect(token).toBeVisible({ timeout: 120_000 })
      }
    })
  }
})
