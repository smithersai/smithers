/*
 * The integrator's whole-tutorial walk (apps/app/TUTORIAL2_INTEGRATION.md).
 *
 * One pass from stage 0 to the workspace at 1280x800 in the light theme, with
 * a screenshot per stage. Every say stage auto-advances on its own read pause;
 * every do stage shows its single pill with its key chip, and the key press
 * completes it where the harness has the real backend. Where the backend is a
 * deployment boundary (OAuth, the ranked GitHub inventory, the workspace's
 * Librarian modules, a paid agent run) the lesson's named skeleton signal
 * stands in AS SETUP, exactly as the lane specs do: it proves the shell, the
 * pill, the check and the advance, never that the feature ran.
 */
import { expect, test, type Page } from "@playwright/test"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { GUIDE_STAGES } from "../../src/mainview/onboarding/lessons"

/* Playwright loads specs as CommonJS, so the output directory resolves from __dirname. */
const SHOTS = join(__dirname, "..", "..", "tutorial2-shots")
const shell = (page: Page) => page.locator(".guide-shell")
const stageNow = async (page: Page) => Number(await shell(page).getAttribute("data-stage"))
const atStage = (page: Page, value: number) => expect(shell(page)).toHaveAttribute("data-stage", String(value))

const slash = async (page: Page, command: string) => {
  if (await shell(page).getAttribute("data-conversation-open") !== "true") await page.keyboard.press("Control+k")
  await page.getByTestId("composer-input").fill(command)
  await page.keyboard.press("Enter")
  await page.keyboard.press("Escape")
}

/** Hold the current stage still: any input cancels a say stage's pending advance. */
const hold = async (page: Page) => {
  await shell(page).waitFor()
  await page.keyboard.press("Shift")
}

const shoot = async (page: Page, index: number) => {
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(SHOTS, `stage-${String(index).padStart(2, "0")}.png`) })
}

test("the whole tutorial walks from the greeting to the workspace", async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true })
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto("/")
  await shell(page).waitFor()
  await expect(shell(page)).toHaveAttribute("data-theme", "light")

  // Stage 0: the greeting says its line and advances on its own.
  await atStage(page, 0)
  await shoot(page, 0)
  await atStage(page, 1)

  for (let step = 1; step <= 8; step++) {
    await hold(page)
    await atStage(page, step)
    const lesson = GUIDE_STAGES[step]!
    /* The actionable half of the union, matched on its own field so no lesson kind is spelled here. */
    if (!("completion" in lesson)) throw new Error(`stage ${step} asks for no action`)

    // The single pill, its label and its key chip.
    const actions = lesson.actions ?? []
    for (const action of actions) {
      const pill = page.locator(`.guide-actions button[data-flow="${action.flow}"]`)
      await expect(pill).toBeVisible()
      await expect(pill).toHaveAttribute("aria-keyshortcuts", action.key.toLowerCase())
      await expect(pill.locator("kbd")).toHaveText(action.key)
    }
    await shoot(page, step)

    if (step === 5) {
      // The one lesson whose real producer runs in this harness: the actual install.
      await page.keyboard.press("b")
    } else {
      await slash(page, `/onboarding.act signal ${lesson.completion}`)
    }
    // The green check, then the automatic advance.
    await expect(page.locator(`[data-message-step="${step}"] .guide-step-done`).first()).toBeVisible()
    await atStage(page, step + 1)
  }

  // Stage 9: the workspace, with the optional reel offered.
  await hold(page)
  await atStage(page, 9)
  const more = page.getByRole("button", { name: /What else can you do/ })
  await expect(more).toBeVisible()
  await expect(more).toHaveAttribute("aria-keyshortcuts", "w")
  await shoot(page, 9)

  // The reel plays its own cards, then Escape lands back on the workspace.
  await page.keyboard.press("w")
  await expect(page.locator("[data-reel-stage='0']")).toBeVisible()
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(SHOTS, "stage-10-reel.png") })
  await expect(page.locator("[data-reel-stage='1']")).toBeVisible({ timeout: 15_000 })
  await page.keyboard.press("Escape")
  await expect(page.locator("[data-reel-stage]")).toHaveCount(0)
  await atStage(page, 9)
  await expect(more).toBeVisible()
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(SHOTS, "stage-11-workspace.png") })
  expect(await stageNow(page)).toBe(9)
})
