import { expect, test, type Page } from "@playwright/test"
import { GUIDE_STAGES } from "../../src/mainview/onboarding/lessons"

// This acceptance needs an authenticated workspace with both Librarian native
// delegates installed. No intercepted launch receipts or synthetic lesson-7 signals.
const repo = process.env.SMITHERS_TUTORIAL_REPO ?? "smithersai/smithers"
if (process.env.SMITHERS_TUTORIAL_STORAGE_STATE) test.use({ storageState: process.env.SMITHERS_TUTORIAL_STORAGE_STATE })
const slash = async (page: Page, command: string) => {
  if (await page.locator(".guide-shell").getAttribute("data-conversation-open") !== "true") await page.keyboard.press("Control+k")
  await page.getByTestId("composer-input").fill(command)
  await page.keyboard.press("Enter")
}
const stage = (page: Page, value: number) => expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", String(value))
const reachBackgroundLesson = async (page: Page) => {
  await page.goto(`/${repo}`)
  await page.locator(".guide-shell").waitFor()
  await page.keyboard.press("Shift")
  // Prerequisite lesson state only. This does not supply identity, a selected
  // repository, run IDs, run results, or the background completion signal.
  while (Number(await page.locator(".guide-shell").getAttribute("data-stage")) < 6) {
    const step = Number(await page.locator(".guide-shell").getAttribute("data-stage"))
    const lesson = GUIDE_STAGES[step]!
    if (lesson.kind === "say") await page.keyboard.press("ArrowRight")
    else if (step === 5) await slash(page, "/plugins.install librarian")
    else await slash(page, `/onboarding.act signal ${lesson.completion}`)
    await stage(page, step + 1)
    await page.keyboard.press("Shift")
  }
}
const runIds = async (page: Page) => page.locator('[data-testid^="run-trace-"]').evaluateAll(nodes =>
  nodes.filter(node => node.classList.contains("run-trace")).map(node => node.getAttribute("data-testid")!.slice("run-trace-".length)))

test("two real background receipts can be monitored while chatting, survive reload, and complete only after both inspections", async ({ page }) => {
  await reachBackgroundLesson(page)
  await slash(page, "/wiki.create")
  // Root's shared schema-derived form supplies the real repository options.
  await expect(page.getByText("Repository", { exact: true }).last()).toBeVisible()
  /* The tutorial's own projection of the form; the covered workspace is inert. */
  const field = page.locator("[data-tutorial-cards]").getByTestId("flow-form-repo")
  if (await field.evaluate(node => node.tagName === "SELECT")) await field.selectOption(repo)
  else await field.fill(repo)
  await page.getByRole("button", { name: /submit/i }).last().focus()
  await page.keyboard.press("Enter")
  await expect.poll(async () => (await runIds(page)).length).toBe(1)
  await slash(page, `/history.bootstrap ${repo}`)
  await expect.poll(async () => (await runIds(page)).length).toBe(2)
  const ids = await runIds(page)
  expect(new Set(ids).size).toBe(2)
  await stage(page, 6)
  await slash(page, "Keep working while the Librarian runs.")
  await expect(page.getByText("Keep working while the Librarian runs.", { exact: true }).first()).toBeVisible()
  await slash(page, `/runs.open ${ids[0]} ${repo}`)
  await stage(page, 6)
  await page.reload()
  await stage(page, 6)
  expect(new Set(await runIds(page))).toEqual(new Set(ids))
  await slash(page, `/runs.open ${ids[1]} ${repo}`)
  await stage(page, 7)
  await page.reload()
  await stage(page, 7)
})

test("a refused launch never checks the background lesson", async ({ page }) => {
  await reachBackgroundLesson(page)
  await slash(page, "/wiki.create definitely-missing/tutorial-repository")
  await slash(page, "/history.bootstrap definitely-missing/tutorial-repository")
  await page.keyboard.press("Escape")
  await page.keyboard.press("ArrowRight")
  await stage(page, 6)
  await expect(page.locator('[data-message-step="6"] .guide-step-done')).toHaveCount(0)
})
