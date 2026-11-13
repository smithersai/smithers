// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
// `fault=end-twice` (test/support/FaultyFactory.vibe): the transport sends the tour's end twice, as a client that resends
// an end whose answer it lost. The mock's sequencer (src/core/decide.vibe) refuses the second as no tour running; the
// page reads that refusal as the tour already ended (src/web/main.vibe `EndTourCommand`), so the person has control.
import { expect, test } from "./coverage"

test("an end sent twice ends the tour once and gives the person control", async ({ page }, info) => {
  const port = process.env.E2E_PORT ?? process.env.E2E_4510 ?? process.env.E2E_4511 ?? process.env.E2E_4502 ?? "4173"
  await page.addInitScript(() => localStorage.setItem("vibelang:tour-sound", "off"))
  await page.goto(`http://127.0.0.1:${port}/e2e/runtime/index.html?fault=end-twice`)
  await page.getByRole("button", { name: "Learn more", exact: true }).click()
  const bar = page.getByRole("region", { name: "Walkthrough" })
  await expect(bar).toHaveAttribute("data-step", "1", { timeout: 15_000 })
  await page.keyboard.press("Escape")
  await expect(bar).toHaveCount(0)
  await expect(page.getByRole("alert")).toHaveCount(0)
  const message = page.getByRole("textbox", { name: "Message", exact: true })
  await expect(message).toBeVisible()
  await message.fill("How do services work?")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.locator('[data-role="assistant"][data-done="true"]').last()).toContainText("service")
  await page.screenshot({ path: info.outputPath("end-twice.png"), fullPage: true })
})
