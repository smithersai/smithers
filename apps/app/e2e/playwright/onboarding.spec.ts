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

test("the greeting auto-advances to login and navigation cannot complete login", async ({ page }) => {
  await page.goto("/")
  await expectStage(page, 1)
  await expect(page.locator('[data-message-step="0"]')).toContainText("I'm Smithers, I help your team manage your repository.")
  await expect(page.locator('[data-message-step="1"] .guide-steps')).toContainText("Click Log in to GitHub")
  await page.keyboard.press("ArrowRight")
  await page.keyboard.press("Enter")
  await expectStage(page, 1)
  await expect(page.locator('[data-message-step="1"] .guide-step-done')).toHaveCount(0)
})

test("all lessons walk end-to-end through named skeleton signals and the real plugin install", async ({ page }) => {
  await page.goto("/")
  await walkTo(page, 9)
  await page.reload()
  await expectStage(page, 9)
  await expect(page.getByTestId("composer-input")).toBeHidden()
  await slash(page, "/tut")
  await page.keyboard.press("Escape")
  await page.keyboard.press("ArrowRight")
  await expectStage(page, 1)
  await expect(page.locator('[data-message-step="1"] .guide-step-done')).toHaveCount(0)
})

test("Back pauses, only ArrowRight navigates, composer restores focus", async ({ page }) => {
  await page.goto("/")
  await expectStage(page, 1)
  await page.keyboard.press("ArrowLeft")
  await expectStage(page, 0)
  await page.locator(".guide-shell").focus()
  await page.keyboard.press("Enter")
  await expectStage(page, 0)
  await page.keyboard.press("Control+k")
  await expect(page.getByTestId("composer-input")).toBeFocused()
  await page.keyboard.press("Escape")
  await page.keyboard.press("ArrowRight")
  await expectStage(page, 1)
})

test("plugin opening alone cannot complete installation", async ({ page }) => {
  await page.goto("/")
  await walkTo(page, 5)
  await slash(page, "/plugins")
  await expect(page.locator(".guide-library .plugin-card").first()).toBeVisible()
  await expectStage(page, 5)
  await expect(page.locator('[data-message-step="5"] .guide-step-done')).toHaveCount(0)
  await complete(page, 5)
})

test("reduced motion and a narrow viewport preserve the login instruction", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/")
  await expectStage(page, 1)
  expect(await page.locator(".guide-shell").evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
  await expect(page.locator('[data-message-step="1"] .guide-steps')).toBeVisible()
})


test("lesson 2 login pill carries L and L dispatches the GitHub sign-in route", async ({ page }) => {
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host: "cloud", version: "test", buildSha: "test",
    capabilities: ["identity"], authFlow: "redirect", sandbox: null
  } }))
  await page.route("**/api/auth/session", route => route.fulfill({ json: { status: "signed-out" } }))
  await page.route("**/api/auth/github/start*", route => route.fulfill({
    contentType: "text/html", body: "<p>GitHub sign-in route reached</p>"
  }))
  await page.goto("/")
  await expectStage(page, 1)
  const login = page.getByRole("button", { name: "Log in to GitHub", exact: true })
  await expect(login).toBeVisible()
  await expect(login).toHaveAttribute("data-flow", "auth.sign-in")
  await expect(login).toHaveAttribute("aria-keyshortcuts", "l")
  await expect(login.locator("kbd")).toHaveText("L")
  const request = page.waitForRequest(request => new URL(request.url()).pathname === "/api/auth/github/start")
  await page.keyboard.press("l")
  await request
  await expect(page).toHaveURL(url => url.pathname === "/api/auth/github/start")
})


test("Open a file dispatches the missing-input form inside the tutorial", async ({ page }) => {
  await page.goto("/")
  await walkTo(page, 4)
  await page.getByRole("button", { name: "Open a file", exact: true }).click()
  await expect(page.locator('.guide-transcript [data-kind="flow-form"]')).toBeVisible()
  await expectStage(page, 4)
})
