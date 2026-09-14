import { expect, test, type Page } from "@playwright/test"
import { stubTutorialHost, launchedFlows, INSTALLED_REPO } from "./tutorial-stubs"

// Local boundary doubles; the lesson controls, provision path and durable run cards are real.
const repo = INSTALLED_REPO
const slash = async (page: Page, command: string) => {
  if (await page.locator(".guide-shell").getAttribute("data-conversation-open") !== "true") await page.keyboard.press("Control+k")
  await page.getByTestId("composer-input").fill(command)
  await page.keyboard.press("Enter")
}
const stage = (page: Page, value: number) => expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", String(value))
const reachBackgroundLesson = async (page: Page) => {
  const host = await stubTutorialHost(page, "http://127.0.0.1:47311")
  host.signedIn = true
  host.installed = true
  await page.goto("/")
  await stage(page, 1)
  await page.keyboard.press("q")
  await stage(page, 12)
  return host
}
const runIds = async (page: Page) => page.locator('[data-testid^="run-trace-"]').evaluateAll(nodes =>
  nodes.filter(node => node.classList.contains("run-trace")).map(node => node.getAttribute("data-testid")!.slice("run-trace-".length)))

test("two background launches complete the lesson without opening either run, and survive reload", async ({ page }) => {
  const host = await reachBackgroundLesson(page)
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
  // Script v4 beat 12: both launched is the lesson; the user never has to open a run card.
  await stage(page, 13)
  expect(launchedFlows(host)).toEqual([`librarian/wiki ${repo}`, `librarian/history ${repo}`])
  await expect(page.getByText("Both are running. I\'ll tell you when they\'re done.", { exact: true })).toBeVisible()
  await page.reload()
  await stage(page, 13)
  expect(new Set(await runIds(page))).toEqual(new Set(ids))
})

test("a refused launch never checks the background lesson", async ({ page }) => {
  await reachBackgroundLesson(page)
  await page.route("**/api/workflow/provision", route => route.fulfill({ json: { status: "no-cloud-repo" } }))
  await slash(page, "/wiki.create definitely-missing/tutorial-repository")
  await slash(page, "/history.bootstrap definitely-missing/tutorial-repository")
  await page.keyboard.press("Escape")
  await page.keyboard.press("ArrowRight")
  await stage(page, 12)
  await expect(page.locator('[data-message-step="12"] .guide-step-done')).toHaveCount(0)
})

test("an App-connected repository missing from Cloud reports under the lesson and can retry", async ({ page }) => {
  const host = await reachBackgroundLesson(page)
  await page.route("**/api/workflow/provision", route => route.fulfill({ json: { status: "no-cloud-repo" } }))
  await page.keyboard.press("u")
  const notice = page.locator('[data-message-step="12"] [data-notice]')
  await expect(notice).toContainText(`Create Wiki didn't start: ${repo} isn't on Smithers Cloud yet`)
  await expect(page.locator('.guide-actions [data-flow="wiki.create"]')).toBeVisible()
  expect(launchedFlows(host)).toEqual([])
  await page.reload()
  await stage(page, 12)
  await expect(notice).toContainText("isn't on Smithers Cloud yet")
  await page.route("**/api/workflow/provision", route => route.fulfill({ json: { status: "ready" } }))
  await page.keyboard.press("u")
  await expect.poll(() => launchedFlows(host).length).toBe(1)
  await page.keyboard.press("y")
  await stage(page, 13)
})

test("reload during preparation reports the interrupted launch and preserves retry pills", async ({ page }) => {
  const host = await reachBackgroundLesson(page)
  await page.route("**/api/workflow/provision", route => route.fulfill({ json: { status: "provisioning" } }))
  await page.keyboard.press("u")
  const notice = page.locator('[data-message-step="12"] [data-notice]')
  await expect(notice).toContainText(`Preparing your ${repo} workspace… This can take up to 3 minutes.`)
  await page.reload()
  await stage(page, 12)
  await expect(notice).toContainText("Create Wiki didn't start: Workspace preparation was interrupted by a reload. Try again.")
  await expect(page.locator('.guide-actions [data-flow="wiki.create"]')).toBeVisible()
  expect(launchedFlows(host)).toEqual([])
})

test("a workspace still provisioning at the deadline reports a failure line", async ({ page }) => {
  const host = await reachBackgroundLesson(page)
  await page.route("**/api/workflow/provision", route => route.fulfill({ json: { status: "provisioning" } }))
  await page.clock.install()
  await page.keyboard.press("u")
  await expect(page.locator('[data-message-step="12"] [data-notice]')).toContainText("Preparing your")
  await page.clock.fastForward(181_000)
  await expect(page.locator('[data-message-step="12"] [data-notice]')).toContainText("Create Wiki didn't start: Workspace preparation took longer than 3 minutes. Try again.")
  await expect(page.locator('.guide-actions [data-flow="wiki.create"]')).toBeVisible()
  expect(launchedFlows(host)).toEqual([])
})
