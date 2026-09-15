import { expect, test } from "@playwright/test"

test.skip(process.env.SMITHERS_CHAT_STUB === "0", "uses the local deterministic model")

test("a committed native reply survives lost delivery and browser reload without another inference POST", async ({ page }) => {
  let starts = 0
  let allowReplay = false
  let resumedReads = 0
  await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [{ name: "smithersai/smithers" }] } }))
  await page.route("**/api/agent/turn", async route => {
    starts++
    // Exercise the real Bun producer and file SQLite, then lose all output
    // batches on the browser hop. The backend has already committed them.
    const response = await route.fetch()
    expect(response.headers()["x-smithers-turn-journal"]).toBe("1")
    const lines = (await response.text()).trim().split("\n").map(line => JSON.parse(line))
    expect(lines.some(line => line.type === "batch")).toBe(true)
    await route.fulfill({ response, body: `${JSON.stringify(lines.find(line => line.type === "accepted"))}\n` })
  })
  await page.route("**/api/agent/turn/replay", async route => {
    if (!allowReplay) return route.fulfill({ status: 503, json: { status: "error", code: "storage_failed" } })
    resumedReads++
    await route.continue()
  })
  await page.goto("/")
  await page.getByRole("button", { name: "Skip tutorial", exact: true }).click()
  await page.getByRole("button", { name: "Not now", exact: true }).click()
  await page.getByRole("button", { name: "Finish tutorial", exact: true }).click()
  await expect(page.getByRole("button", { name: "Finish tutorial", exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Chat", exact: true }).click()
  const prompt = "recover this accepted reply"
  const input = page.getByTestId("composer-input")
  await input.fill(prompt)
  const response = page.waitForResponse(response => new URL(response.url()).pathname === "/api/agent/turn")
  await input.press("Enter")
  await response
  await expect(page.locator('.smithers-chat-message[data-role="user"]', { hasText: prompt })).toHaveCount(1)
  const answer = page.locator('.smithers-chat-message[data-role="assistant"]', { hasText: `stub: ${prompt}` })
  await expect(answer).toHaveCount(0)
  await page.reload()
  allowReplay = true
  await expect(answer).toContainText(`stub: ${prompt}`, { timeout: 15_000 })
  await expect(answer).toHaveCount(1)
  expect(resumedReads).toBeGreaterThan(0)
  expect(starts).toBe(1)
  await page.reload()
  await expect(answer).toHaveCount(1)
  expect(starts).toBe(1)
})
