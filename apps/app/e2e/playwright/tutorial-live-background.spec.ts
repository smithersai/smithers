import { expect, test } from "@playwright/test"

test.use({ contextOptions: { reducedMotion: "reduce" } })

test("live research leaves chat usable and toasts the whole background run", async ({ page }) => {
  let releaseLaunch!: () => void
  const launch = new Promise<void>(resolve => { releaseLaunch = resolve })
  let complete = false
  let launches = 0
  const run = () => ({ sessionId: "test", runId: "research-background", operation: "research",
    phase: complete ? "completed" : "running", createdAt: 1, updatedAt: 2,
    events: [], ...(complete ? { result: "Research complete" } : {}) })
  await page.route("**/api/tutorial/live/research", async route => {
    launches++
    await launch
    await route.fulfill({ status: 202, json: run() })
  })
  await page.route("**/api/tutorial/live/run/*", route => route.fulfill({ json: run() }))
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host: "cloud", version: "test", buildSha: "test",
    capabilities: ["agent", "identity", "cloud"], authFlow: "native-handoff", sandbox: null
  } }))
  await page.route("**/api/auth/session", route => route.fulfill({ json: { status: "signed-out" } }))
  await page.goto("/")
  const openChat = page.getByRole("button", { name: "Chat", exact: true })
  await openChat.focus()
  await page.keyboard.press("Enter")
  await page.getByTestId("composer-input").fill("/issue.repro 3 practice:smithersai/hello-server")
  await page.getByTestId("composer-input").press("Enter")
  const chat = page.getByRole("button", { name: "Chat", exact: true })
  await expect(chat).toBeEnabled()
  await expect(page.locator('.toast[data-toast-status="running"]')).toContainText("Researching issue")
  const input = page.getByTestId("composer-input")
  if (!await input.isVisible()) {
    await chat.focus()
    await page.keyboard.press("Enter")
  }
  await expect(input).toBeEditable()
  await input.fill("I can keep chatting while research runs")
  await expect(input).toHaveValue("I can keep chatting while research runs")
  // A second typed invocation while launch is unresolved joins the same request.
  await input.fill("/issue.repro 3 practice:smithersai/hello-server")
  await input.press("Enter")
  await expect(page.locator('.toast[data-toast-status="running"]')).toBeVisible()
  expect(launches).toBe(1)
  releaseLaunch()
  await expect(page.locator('[data-kind="run-trace"]')).toContainText("Running")
  await expect(page.locator('.toast[data-toast-status="running"]')).toBeVisible()
  await page.screenshot({ path: "/tmp/tutorial-background-chat.png" })
  expect(launches).toBe(1)
  complete = true
  await expect(page.locator('.toast[data-toast-status="ok"]')).toContainText("Research complete")
})
