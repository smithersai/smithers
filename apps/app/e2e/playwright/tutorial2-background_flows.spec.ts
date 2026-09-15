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
  // Chat is a modal: close it before entering the embedded form beneath it.
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog", { name: "Chat", exact: true })).toHaveCount(0)
  /* The tutorial's own projection of the form; the covered workspace is inert. */
  const field = page.locator("[data-tutorial-cards]").getByTestId("flow-form-repo")
  if (await field.evaluate(node => node.tagName === "SELECT")) await field.selectOption(repo)
  else await field.fill(repo)
  const submit = page.getByRole("button", { name: /submit/i }).last()
  await expect(submit).toBeEnabled()
  await submit.focus()
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
  const notice = page.locator('.guide-actions [data-notice]')
  await expect(notice).toContainText(`${repo} isn't on Smithers Cloud yet`)
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
  const notice = page.locator('.guide-actions [data-notice]')
  await expect(notice).toContainText(`Preparing your ${repo} workspace… This can take up to 3 minutes.`)
  await page.reload()
  await stage(page, 12)
  await expect(notice).toContainText("Workspace preparation was interrupted by a reload. Try again.")
  await expect(page.locator('.guide-actions [data-flow="wiki.create"]')).toBeVisible()
  expect(launchedFlows(host)).toEqual([])
})

test("a workspace still provisioning at the deadline reports a failure line", async ({ page }) => {
  const host = await reachBackgroundLesson(page)
  await page.route("**/api/workflow/provision", route => route.fulfill({ json: { status: "provisioning" } }))
  await page.clock.install()
  await page.keyboard.press("u")
  await expect(page.locator('.guide-actions [data-notice]')).toContainText("Preparing your")
  await page.clock.fastForward(181_000)
  await expect(page.locator('.guide-actions [data-notice]')).toContainText("Workspace preparation took longer than 3 minutes. Try again.")
  await expect(page.locator('.guide-actions [data-flow="wiki.create"]')).toBeVisible()
  expect(launchedFlows(host)).toEqual([])
})

test("both failed launches explain themselves and preparation uses a neutral color", async ({ page }) => {
  await reachBackgroundLesson(page)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route("**/api/workflow/provision", async route => {
    await held
    await route.fulfill({ json: { status: "no-cloud-repo" } })
  })
  try {
    await page.keyboard.press("u")
    const notice = page.locator('.guide-actions [data-notice]')
    await expect(notice).toContainText("Preparing your")
    const usesDanger = () => notice.evaluate(node => {
      const probe = document.createElement("span")
      probe.style.color = "var(--danger)"
      node.append(probe)
      const matches = getComputedStyle(node).color === getComputedStyle(probe).color
      probe.remove()
      return matches
    })
    expect(await usesDanger()).toBe(false)
    await page.keyboard.press("y")
    release()
    await expect(notice.locator("p")).toContainText("Create Wiki didn't start:")
    await expect(notice.locator("p")).toContainText("Create Mythical history didn't start:")
    expect(await notice.locator("p").innerText()).toContain("\n")
    expect(await usesDanger()).toBe(true)
  } finally { release() }
})

const failRun = async (page: Page, failedId: () => string | undefined) => {
  await page.route("**/api/workflow/rpc", route => {
    const call = route.request().postDataJSON()
    const selector = call.payload?.selector
    if (call.procedure !== "Projection.Snapshot" || selector?._tag !== "run-summary" || selector.runId !== failedId()) return route.fallback()
    return route.fulfill({ json: { ok: true, payload: {
      cursor: { projection: "run-summary", runId: selector.runId, value: 1 },
      rows: [{ runId: selector.runId, flowId: "librarian/history", status: "failed", createdAt: 0, updatedAt: 1,
        turns: 0, calls: 0, callsFailed: 0, editsAttempted: 0, editsSucceeded: 0, inputTokens: 0, outputTokens: 0,
        verdict: "failed — Error: Error: git exited 1", diagnosis: "failed" }]
    } } })
  })
}

test("an accepted history run that fails keeps beat 12 open and its keyboard Retry launches a fresh run", async ({ page }) => {
  const host = await reachBackgroundLesson(page)
  await failRun(page, () => "librarian-run-1")
  await page.keyboard.press("y")
  const notice = page.locator('.guide-actions [data-notice]')
  await expect(notice.locator("p")).toContainText("Create Mythical history didn't start:")
  await expect(notice.locator("p")).toContainText("Not your fault")
  await expect(notice.locator("p")).not.toContainText("git exited")
  await expect(notice.locator("details")).not.toHaveAttribute("open")
  await page.keyboard.press("u")
  await expect.poll(() => launchedFlows(host).length).toBe(2)
  await stage(page, 12)
  const retry = page.locator('.guide-actions [data-flow="history.bootstrap"]')
  await expect(retry).toContainText("Retry Mythical history")
  await retry.focus()
  await page.keyboard.press("Enter")
  await stage(page, 13)
  expect(launchedFlows(host)).toHaveLength(3)
})

test("a failure after advancing removes the running promise and offers a persistent keyboard Retry", async ({ page }) => {
  const host = await reachBackgroundLesson(page)
  let failed: string | undefined
  await failRun(page, () => failed)
  await page.keyboard.press("u")
  await expect.poll(() => launchedFlows(host).length).toBe(1)
  await page.keyboard.press("y")
  await stage(page, 13)
  failed = "librarian-run-2"
  const retry = page.getByRole("button", { name: "Retry Mythical history", exact: true })
  await expect(retry).toBeVisible()
  await expect(page.getByText("Both are running. I'll tell you when they're done.", { exact: true })).toHaveCount(0)
  await page.keyboard.press("f")
  await expect(page.locator(".guide-shell")).toHaveCount(0)
  await expect(page.getByText(/Your Wiki and history will land soon/)).toHaveCount(0)
  await retry.focus()
  await page.keyboard.press("Enter")
  await expect.poll(() => launchedFlows(host).length).toBe(3)
  await expect(retry).toHaveCount(0)
})

test("completed Wiki survives reload without Retry or repeated chips, and only failed history retries", async ({ page }) => {
  const host = await reachBackgroundLesson(page)
  await page.route("**/api/workflow/rpc", route => {
    const call = route.request().postDataJSON()
    const selector = call.payload?.selector
    if (call.procedure !== "Projection.Snapshot" || selector?._tag !== "run-summary") return route.fallback()
    const failed = selector.runId === "librarian-run-2"
    return route.fulfill({ json: { ok: true, payload: {
      cursor: { projection: "run-summary", runId: selector.runId, value: 1 },
      rows: [{ runId: selector.runId, flowId: selector.runId === "librarian-run-1" ? "librarian/wiki" : "librarian/history",
        status: failed ? "failed" : "completed", createdAt: 0, updatedAt: 1,
        turns: 0, calls: 0, callsFailed: 0, editsAttempted: 0, editsSucceeded: 0, inputTokens: 0, outputTokens: 0,
        verdict: failed ? "failed — Error: Error: git exited 1" : "Ready", diagnosis: failed ? "failed" : "" }]
    } } })
  })
  await page.keyboard.press("u")
  const wiki = page.locator('.guide-actions [data-flow="wiki.create"]')
  await expect(wiki).toContainText("Wiki ready")
  await expect(wiki).toBeDisabled()
  await page.keyboard.press("y")
  const notice = page.locator('.guide-actions [data-notice]')
  await expect(notice.locator("p")).toContainText("Create Mythical history didn't start:")
  await expect(notice.locator("p")).not.toContainText("Wiki")
  await expect(notice.locator("p")).not.toContainText("may have started")
  // The same outcome remains on the cards while its transient announcement expires.
  await expect(page.locator('[data-run-chip="wiki"]')).toHaveCount(0)
  await expect(page.locator('[data-run-chip="history"]')).toHaveCount(0)
  await page.reload()
  await stage(page, 12)
  await expect(wiki).toContainText("Wiki ready")
  await expect(wiki).toBeDisabled()
  await expect(notice.locator("p")).toContainText("Create Mythical history didn't start:")
  await expect(notice.locator("p")).not.toContainText("Wiki")
  await expect(page.locator('[data-run-chip]')).toHaveCount(0)
  const details = notice.locator("summary")
  await details.focus()
  await page.keyboard.press("Enter")
  await expect(notice.locator("pre")).toHaveText("failed — Error: Error: git exited 1")
  await page.keyboard.press("u")
  expect(launchedFlows(host)).toHaveLength(2)
  const retry = page.locator('.guide-actions [data-flow="history.bootstrap"]')
  await expect(retry).toContainText("Retry Mythical history")
  await retry.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByText("Both are running. I'll tell you when they're done.", { exact: true })).toBeVisible()
  await stage(page, 13)
  expect(launchedFlows(host)).toEqual([`librarian/wiki ${repo}`, `librarian/history ${repo}`, `librarian/history ${repo}`])
  await expect(page.locator('[data-run-chip]')).toHaveCount(0)
})
