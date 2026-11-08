// Stays .ts: Playwright collects test files by JS/TS extension only.
import { expect, test } from "@playwright/test"

const local = `http://127.0.0.1:${process.env.E2E_PORT ?? 4173}`

test("a question without a matching script still gets a complete answer", async ({ page }) => {
  await page.goto("/?agent=mock")
  await page.getByRole("button", { name: "Ask the agent" }).click()
  const input = page.getByRole("textbox", { name: "Message" })
  await expect(input).toBeFocused()
  await input.fill("Hello")
  await input.press("Enter")
  const answer = page.locator(".sui-chat-message[data-role='assistant']")
  await expect(answer).toHaveAttribute("data-done", "true")
  await expect(answer).toContainText("VibeLang is Effect as its own language")
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled()
})

for (const [fault, label] of [["tour-refuse", "Agent busy"], ["tour-unavailable", "Send failed"]] as const) {
  test(`a ${fault} is visible and a later Learn more recovers`, async ({ page }) => {
    await page.goto(`${local}/e2e/runtime/index.html?fault=${fault}`)
    await page.getByRole("button", { name: "Learn more" }).click()
    await expect(page.locator("[data-docked] .sui-chat-composer-status")).toHaveText(label)
    await expect(page.getByRole("button", { name: "Esc", exact: true })).toBeHidden()
    await expect(page.getByTitle("VibeLang docs")).toHaveCount(0)
    await page.getByRole("button", { name: "Expand the VibeLang home page" }).click()
    await page.getByRole("button", { name: "Learn more" }).click()
    await expect(page.getByTitle("VibeLang docs")).toBeVisible()
    await expect(page.getByRole("button", { name: "Esc", exact: true })).toBeVisible()
    await page.getByRole("button", { name: "Esc", exact: true }).click()
    await expect(page.getByRole("button", { name: "Esc", exact: true })).toBeHidden()
  })
}

test("an unavailable tour end restores Esc so the person can retry", async ({ page }) => {
  await page.goto(`${local}/e2e/runtime/index.html?fault=end-tour-unavailable`)
  await page.getByRole("button", { name: "Learn more" }).click()
  await expect(page.getByTitle("VibeLang docs")).toBeVisible()
  const escape = page.getByRole("button", { name: "Esc", exact: true })
  await escape.click()
  await expect(escape).toBeVisible()
  await escape.click()
  await expect(escape).toBeHidden()
  await expect(page.getByRole("textbox", { name: "Message" })).toBeFocused()
})
