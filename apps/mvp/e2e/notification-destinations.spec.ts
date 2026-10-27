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
  await expect(tab.page).toHaveURL(new RegExp(`/tree/${sha}[0-9a-f]*/*$`))
})

test("failed clone stays at its reason and Retry", async ({ devices }) => {
  const [tab] = await devices.open("Reader")
  await tab.page.goto(`/${syncedRepository()}`)
  await tab.page.getByRole("button", { name: /^Notifications/ }).click()
  const entry = tab.page.locator('[data-entry^="clone:"][data-tone="failed"]').first()
  await expect(entry).toBeVisible({ timeout: 30_000 })
  const before = tab.page.url()
  await entry.locator('[data-slot="notification-row"]').click()
  await expect(entry.getByRole("button", { name: "Retry", exact: true })).toBeVisible()
  await expect(entry.getByRole("button", { name: "Open", exact: true })).toHaveCount(0)
  await expect(tab.page).toHaveURL(before)
})

test("timeline previews use readable times", async ({ devices }) => {
  const [tab] = await devices.open("Reader")
  await tab.page.goto("/app")
  const timeline = tab.page.getByRole("navigation", { name: "Conversation timeline" })
  await timeline.getByRole("button").first().hover()
  const preview = tab.page.getByRole("tooltip").first()
  await expect(preview).toBeVisible()
  await expect(preview).not.toContainText(/\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+\+00/)
})
