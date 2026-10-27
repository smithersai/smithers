import { expect, test } from "./devices"
import { requires, syncedRepository } from "./target"

requires("member", "githubApp", "syncedRepository")

test("commit notification opens its recorded revision", async ({ devices }) => {
  const [tab] = await devices.open("Reader")
  await tab.page.goto(`/${syncedRepository()}`)
  await tab.page.getByRole("button", { name: /^Notifications/ }).click()
  const entry = tab.page.locator('[data-entry^="main:"]').first()
  await expect(entry).toBeVisible({ timeout: 30_000 })
  const sha = (await entry.innerText()).match(/\b[0-9a-f]{7}\b/)?.[0]
  expect(sha).toBeTruthy()
  await entry.locator('[data-slot="notification-row"]').click()
  await entry.getByRole("button", { name: "Open", exact: true }).click()
  await expect(tab.page).toHaveURL(new RegExp(`/tree/${sha}[0-9a-f]*/*$`))
})
