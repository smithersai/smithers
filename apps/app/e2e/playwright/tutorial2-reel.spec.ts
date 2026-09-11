import { expect, test, type Page } from "@playwright/test"
import { GUIDE_STAGES } from "../../src/mainview/onboarding/lessons"

const hold = async (page: Page) => {
  await page.locator(".guide-shell").waitFor()
  await page.keyboard.press("Shift")
}
const expectStage = (page: Page, step: number) => expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", String(step))
const slash = async (page: Page, command: string) => {
  if (await page.locator(".guide-shell").getAttribute("data-conversation-open") !== "true") await page.keyboard.press("Control+k")
  await page.getByTestId("composer-input").fill(command)
  await page.keyboard.press("Enter")
}
/** Skeleton integration harness. Explicit named events stand in for future feature producers.
 * This checks tutorial plumbing, not OAuth, GitHub writes, or an agent execution.
 */
const complete = async (page: Page, step: number) => {
  const stage = GUIDE_STAGES[step]
  if (stage.kind !== "do") { await page.keyboard.press("ArrowRight"); return }
  if (step === 5) await slash(page, "/plugins.install librarian")
  else await slash(page, `/onboarding.act signal ${stage.completion}`)
  await expect(page.locator(`[data-message-step="${step}"] .guide-step-done`).first()).toBeVisible()
  if (await page.getByTestId("composer-input").isVisible()) await page.keyboard.press("Escape")
  await expectStage(page, step + 1)
}
const walkTo = async (page: Page, target: number) => {
  await hold(page)
  while (Number(await page.locator(".guide-shell").getAttribute("data-stage")) < target) {
    const step = Number(await page.locator(".guide-shell").getAttribute("data-stage"))
    await complete(page, step)
    await expectStage(page, step + 1)
    await hold(page)
  }
}

// walkTo is kept identical to onboarding.spec.ts's unexported skeleton helper.
// Named signals exercise plumbing; this does not claim real OAuth/agent work.
test("optional reel advances without input, demonstrates theme and toast, and Escape exits", async ({ page }) => {
  await page.goto("/")
  await walkTo(page, 9)
  const shell = page.locator(".guide-shell")
  const originalTheme = await shell.getAttribute("data-theme")
  await expect(page.getByRole("button", { name: "What else can you do?" })).toBeVisible()
  await page.keyboard.press("w")
  await expect(page.locator("[data-reel-stage='0']")).toBeVisible()
  await expect(shell).toHaveAttribute("data-theme", originalTheme === "dark" ? "light" : "dark")
  await expect(page.locator("[data-reel-stage='1']")).toBeVisible()
  await expect(shell).toHaveAttribute("data-theme", originalTheme!)
  await expect(page.getByRole("status").filter({ hasText: "You can keep working" })).toBeVisible()
  await expect(page.locator("[data-reel-stage='2']")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.locator("[data-reel-stage]")).toHaveCount(0)
  await expectStage(page, 9)
  await expect(shell).toHaveAttribute("data-conversation-open", "false")
  await expect(page.getByTestId("composer-input")).toBeHidden()
})
