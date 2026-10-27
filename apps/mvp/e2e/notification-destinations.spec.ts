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

test("failed header opens the failed answer's run", async ({ devices }) => {
  requires("localServer")
  const [tab] = await devices.open("Reader")
  const id = crypto.randomUUID(), answerId = crypto.randomUUID()
  const question = await tab.page.request.post("/api/questions", { data: { id, answerId, text: `Header failure ${devices.word}` } })
  expect(question.ok()).toBe(true)
  const answer = await tab.page.request.post(`/api/answers/${answerId}`, { data: { status: "failed", failure: "unfinished" } })
  expect(answer.ok()).toBe(true)
  await tab.page.goto("/app")
  const header = tab.page.getByRole("link", { name: "Answer failed — view run" })
  await expect(header).toHaveAttribute("href", `/app/runs/${answerId}`, { timeout: 30_000 })
  await header.click()
  await expect(tab.page).toHaveURL(new RegExp(`/app/runs/${answerId}$`))
})

test("failed notification opens the answer it names", async ({ devices }) => {
  const [tab] = await devices.open("Reader")
  await tab.page.goto(`/${syncedRepository()}`)
  await tab.page.getByRole("button", { name: /^Notifications/ }).click()
  const entry = tab.page.locator('[data-entry^="run:"][data-tone="failed"]').first()
  await expect(entry).toBeVisible({ timeout: 30_000 })
  const runId = (await entry.getAttribute("data-entry"))!.slice("run:".length)
  await entry.locator('[data-slot="notification-row"]').click()
  await expect(tab.page).toHaveURL(new RegExp(`#${runId}$`))
  const header = tab.page.getByRole("link", { name: "Answer failed — view run" })
  await expect(header).toHaveAttribute("href", /\/app\/runs\//)
})
