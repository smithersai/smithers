import { recordExchange, withAttachedAgent } from "./attach"
import { expect, test } from "./devices"
import { requires, syncedRepository } from "./target"

requires("member")

for (const width of [1280, 390]) {
  test(`unread notifications at ${width}px: repository header stays at the top`, async ({ devices }) => {
    requires("githubApp", "syncedRepository")
    const [tab] = await devices.open("Reader")
    const page = tab.page
    await page.setViewportSize({ width, height: 800 })
    const repository = syncedRepository()
    await page.goto(`/${repository}`)
    const header = page.locator(".repo-header")
    await expect(header).toBeVisible()
    // The signed-in account's real synced history is the fixture: no intercepted requests or local rows.
    const bell = page.getByRole("button", { name: /^Notifications/ })
    await expect(bell).toHaveAccessibleName(/\d+ unread/, { timeout: 30_000 })
    const count = Number((await bell.getAttribute("aria-label"))?.match(/(\d+) unread/)?.[1])
    expect(count, "Run with an account whose notification history overflows three toasts").toBeGreaterThan(3)
    await expect(page.locator('[data-slot="toast-stack"] button').filter({ hasText: /^\+\d+$/ })).toHaveCount(0)
    await expect(page.locator('[data-slot="toast"][data-alert]')).toHaveCount(0)
    await expect.poll(async () => (await header.boundingBox())?.y).toBeLessThanOrEqual(24)
    await bell.click()
    await expect(page.getByRole("dialog", { name: "Notifications" })).toBeVisible()
  })
}

for (const width of [1280, 390]) {
  test(`many unread entries at ${width}px: the bell keeps repository content at the top`, async ({ devices }) => {
    requires("localServer")
    const [tab] = await devices.open("Reader")
    const page = tab.page
    await page.setViewportSize({ width, height: 800 })
    const answers: string[] = []
    const post = async (path: string, data: unknown) => {
      const response = await page.request.post(path, { data })
      expect(response.ok(), `${path}: ${await response.text()}`).toBe(true)
    }
    try {
      await withAttachedAgent(page, async (agent) => {
        for (let i = 0; i < 8; i++) {
          const id = crypto.randomUUID(), answerId = crypto.randomUUID()
          await recordExchange(agent, { id, answerId, text: "Notification history " + devices.word + " " + i }, "The run did not finish.")
          answers.push(answerId)
          await agent.reportRunAsPerson(answerId, { status: "working" })
          await agent.reportRunAsPerson(answerId, { status: "failed" })
          await post("/api/notifications/ack", { subject: "run:" + answerId, version: 2, act: "hide" })
        }
      })
      await page.goto("/octocat/Spoon-Knife")
      const header = page.locator(".repo-header")
      // A full page load boots the app again, which takes seconds on a busy dev server.
      await expect(header).toBeVisible({ timeout: 30_000 })
      await page.getByRole("button", { name: /^Notifications/ }).click()
      const panel = page.getByRole("dialog", { name: "Notifications" })
      for (const id of answers) {
        await expect(panel.locator(`[data-entry="run:${id}"]`)).toBeVisible({ timeout: 30_000 })
      }
      await page.keyboard.press("Escape")
      await expect(page.locator('[data-slot="toast-stack"] button').filter({ hasText: /^\+\d+$/ })).toHaveCount(0)
      await expect.poll(async () => (await header.boundingBox())?.y).toBeLessThanOrEqual(24)
    } finally {
      for (const id of answers) await post("/api/notifications/ack", { subject: `run:${id}`, version: 2, act: "dismiss" })
    }
  })
}
