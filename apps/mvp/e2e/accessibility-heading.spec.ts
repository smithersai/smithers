import { expect } from "@playwright/test"
import { test } from "./fixtures"
import { signedOut } from "./target"

for (const visitor of [false, true]) test.describe(visitor ? "Visitor" : "Signed in", () => {
  if (visitor) test.use(signedOut)
  for (const width of [390, 1280]) test.describe(`Chat heading at ${width}px`, () => {
    test.use({ viewport: { width, height: 844 } })
    test("Chat has a level one heading", async ({ page }) => {
      await page.goto("/app")
      await expect(page.getByRole("heading", { name: "Chat", level: 1 })).toHaveCount(1)
    })
  })
})
