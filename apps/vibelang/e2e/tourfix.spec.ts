// Playwright collects browser tests only from JS/TS files.
import { test, expect, type Page, type Locator } from "@playwright/test"
const docs = (p: Page) => p.getByTitle("VibeLang docs")
const answer = (p: Page) => p.locator(".sui-chat-message[data-role='assistant']").last()
async function start(p: Page) {
  await p.goto("/?agent=mock")
  await p.getByRole("button", { name: "Learn more" }).click()
  await expect(answer(p)).toContainText("VibeLang is")
}
async function inside(p: Page, element: Locator) {
  const box = (await element.boundingBox())!
  const viewport = p.viewportSize()!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
  expect(box.height).toBeGreaterThan(0)
}
test("1: docs and current narration fit without scrolling at every stop", async ({ page }) => {
  test.setTimeout(150_000)
  await start(page)
  for (const path of ["/", "/getting-started/002-why-effect", "/vibelang-features/115-cheat-sheet", "/setup", "/vips"]) {
    await expect(docs(page)).toHaveAttribute("src", "https://vibelang.sh" + path, { timeout: 35_000 })
    await inside(page, docs(page))
    const stop = page.getByRole("region", { name: "Current stop" })
    const current = await stop.count() ? stop : answer(page).locator(".sui-chat-bubble")
    await expect(current).not.toBeEmpty()
    await inside(page, current)
    for (const paragraph of await current.locator("p").all()) await inside(page, paragraph)
    const frame = (await docs(page).boundingBox())!, words = (await current.boundingBox())!
    expect(frame.y + frame.height <= words.y || words.x >= frame.x + frame.width).toBe(true)
  }
})
test("1: the completed tour leaves the docs in view until minimized", async ({ page }) => {
  test.setTimeout(120_000)
  await start(page)
  await expect(answer(page)).toHaveAttribute("data-done", "true", { timeout: 90_000 })
  await inside(page, docs(page))
  await expect(page.getByRole("region", { name: "Docs" })).toHaveAttribute("data-maximized", "true")
  await page.getByRole("button", { name: "Minimize the docs" }).click()
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible()
})
test("2: each stop has its own paragraph through the shared live narration path", async ({ page }) => {
  await start(page)
  await expect(docs(page)).toHaveAttribute("src", "https://vibelang.sh/getting-started/002-why-effect", { timeout: 35_000 })
  await expect(page.locator(".sui-chat-messages").locator(".sui-chat-message[data-role='assistant'] .sui-chat-bubble p")).toHaveCount(2)
})
test("4: maximized docs isolate the chat and release it on minimize", async ({ page }) => {
  await start(page)
  await page.getByRole("button", { name: "Esc", exact: true }).click()
  await page.getByRole("button", { name: "Maximize the docs" }).click()
  const input = page.locator("#vl-prompt")
  await expect.poll(() => input.evaluate(el => !!el.closest("[inert]"))).toBe(true)
  await page.keyboard.press("Escape")
  await expect.poll(() => input.evaluate(el => !!el.closest("[inert]"))).toBe(false)
})
test("5: clicking docs and tabbing cannot take Escape away from the tour", async ({ page }) => {
  await start(page)
  // Click coordinates in the cross-origin frame, then traverse the keyboard focus order.
  const box = (await docs(page).boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await docs(page).focus()
  for (let i = 0; i < 5; i++) {
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("IFRAME")
    await page.keyboard.press("Tab")
  }
  await page.keyboard.press("Escape")
  await expect(page.locator(".vl-glow")).toBeHidden()
  await expect(answer(page)).toHaveAttribute("data-done", "true")
})
test("7: control starts and ends in a persistent polite status region", async ({ page }) => {
  await page.goto("/?agent=mock")
  const status = page.getByRole("status", { name: "Tour" })
  await expect(status).toHaveText("")
  await page.getByRole("button", { name: "Learn more" }).click()
  await expect(status).toHaveText("Agent controlling. Escape to stop.")
  const cdp = await page.context().newCDPSession(page)
  const { nodes } = await cdp.send("Accessibility.getFullAXTree")
  expect(nodes.find(n => n.role?.value === "status" && n.name?.value === "Tour")?.properties).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "live", value: expect.objectContaining({ value: "polite" }) }),
    expect.objectContaining({ name: "atomic", value: expect.objectContaining({ value: true }) }),
  ]))
  await page.keyboard.press("Escape")
  await expect(status).toHaveText("Tour ended. You have control.")
  expect(await status.evaluate(el => el.getBoundingClientRect().width)).toBeLessThanOrEqual(1)
})
