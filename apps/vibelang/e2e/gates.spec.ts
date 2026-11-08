// Playwright discovers browser tests only by JS/TS extension.
import { expect, test } from "@playwright/test"
test("the maintainer proposal gate and four reviewer specification gate", async ({ page }) => {
  await page.goto("/?agent=mock")
  await page.getByRole("combobox", { name: "Visit as" }).selectOption("maintainer")
  await page.getByRole("button", { name: "Ask the agent", exact: true }).click()
  await page.getByRole("dialog").getByRole("textbox", { name: "Message" }).fill("Accept VIP #45")
  await page.getByRole("dialog").getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.locator(".sui-chat-message[data-role='assistant']").last()).toHaveAttribute("data-done", "true")
  await page.getByRole("button", { name: "Issues", exact: true }).click()
  await page.getByRole("link", { name: "Pattern matching in case", exact: true }).click()
  const proposal = page.getByRole("region", { name: "Proposal gate" })
  await expect(proposal).toContainText("Maintainer · person")
  await expect(proposal).toContainText("In review")
  await page.getByRole("button", { name: "Accept", exact: true }).click()
  await expect(proposal).toContainText("will")
  await expect(proposal).toContainText("Accepted")
  if (process.env.GATES_SCREENSHOTS) await page.screenshot({ path: `${process.env.GATES_SCREENSHOTS}/proposal-${test.info().project.name}.png`, fullPage: true })
  await page.getByRole("link", { name: "‹ Issues" }).click()
  await page.getByRole("button", { name: "Specification", exact: true }).click()
  const gate = page.getByRole("status", { name: "Specification gate" })
  await expect(gate).toHaveText("Accepted")
  if (process.env.GATES_SCREENSHOTS) await page.screenshot({ path: `${process.env.GATES_SCREENSHOTS}/specification-${test.info().project.name}.png`, fullPage: true })
  await expect(page.getByRole("table", { name: "Specification reviews" }).getByRole("row")).toHaveCount(5)
  for (const button of await page.getByRole("table", { name: "Specification reviews" }).getByRole("button").all()) {
    const rect = (await button.boundingBox())!
    expect(rect.x + rect.width).toBeLessThanOrEqual(page.viewportSize()!.width)
  }
  await page.getByRole("textbox", { name: "Specification text" }).fill("Revised VibeLang specification from accepted VIPs.")
  await page.getByRole("button", { name: "Save revision" }).click()
  await expect(gate).toHaveText("In review")
  for (const reviewer of ["Codex Astra", "Codex Sol", "Claude Fable", "Claude Opus"]) {
    await page.getByRole("row", { name: new RegExp(reviewer) }).getByRole("button", { name: "Request review" }).click()
    await expect(page.getByRole("row", { name: new RegExp(reviewer) })).toContainText(reviewer === "Claude Opus" ? "B" : "A")
  }
  await expect(gate).toHaveText("In review")
  await page.getByRole("row", { name: /Claude Opus/ }).getByRole("button", { name: "Request review" }).click()
  await expect(gate).toHaveText("Accepted")
})
