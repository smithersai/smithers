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
  await page.goto("/")
  for (const name of ["Show issues", "Read issue #3", "View issue flows", "Run repro"]) {
    await page.getByRole("button", { name, exact: true }).click()
  }
  const chat = page.getByRole("button", { name: "Chat while it runs", exact: true })
  await expect(chat).toBeEnabled()
  await expect(page.locator('.toast[data-toast-status="running"]')).toContainText("Researching issue")
  await chat.click()
  const input = page.getByTestId("composer-input")
  await expect(input).toBeEditable()
  await input.fill("I can keep chatting while research runs")
  await expect(input).toHaveValue("I can keep chatting while research runs")
  releaseLaunch()
  await expect(page.locator('[data-kind="run-trace"]')).toContainText("Running")
  await expect(page.locator('.toast[data-toast-status="running"]')).toBeVisible()
  await page.screenshot({ path: "/tmp/tutorial-background-chat.png" })
  expect(launches).toBe(1)
  complete = true
  await expect(page.locator('.toast[data-toast-status="ok"]')).toContainText("Research complete")
})
