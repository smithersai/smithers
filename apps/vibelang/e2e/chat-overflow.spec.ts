// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
import { expect, test } from "./coverage"

test.use({ viewport: { width: 390, height: 844 } })

test("a finished mock reply fits a phone while its long code scrolls inside the bubble", async ({ page }, info) => {
  await page.goto("/?agent=mock")
  await page.getByRole("button", { name: "Ask the agent" }).click()
  const input = page.getByRole("textbox", { name: "Message" })
  await expect(input).toBeFocused()
  await input.pressSequentially("Hello")
  await expect(input).toHaveValue("Hello")
  await input.press("Enter")

  const answer = page.locator(".sui-chat-message[data-role='assistant']")
  await expect(answer).toHaveAttribute("data-done", "true", { timeout: 15_000 })
  const code = answer.locator("pre")
  await expect(code).toContainText('effect { return users.find("7") catch () => "Guest" }')
  await page.waitForFunction(() => !document.documentElement.matches(":active-view-transition"))

  const layout = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    messages: [...document.querySelectorAll<HTMLElement>(".sui-chat-message")].map((message) => {
      const frame = message.getBoundingClientRect()
      const bubble = message.querySelector(".sui-chat-bubble")!.getBoundingClientRect()
      return { role: message.dataset.role, left: frame.left, right: frame.right, bubbleLeft: bubble.left, bubbleRight: bubble.right }
    }),
  }))
  await info.attach("finished-reply-layout", { body: JSON.stringify(layout, null, 2), contentType: "application/json" })
  await page.screenshot({ path: info.outputPath("finished-reply.png") })
  expect(layout.width).toBe(390)
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width)
  for (const message of layout.messages) {
    expect(message.bubbleLeft).toBeGreaterThanOrEqual(0)
    expect(message.bubbleRight).toBeLessThanOrEqual(layout.width)
    if (message.role === "user") expect(message.bubbleRight).toBeCloseTo(message.right, 0)
    if (message.role === "assistant") expect(message.bubbleLeft).toBeCloseTo(message.left, 0)
  }

  const overflow = await code.evaluate((element) => {
    element.scrollLeft = element.scrollWidth
    return { width: element.clientWidth, scrollWidth: element.scrollWidth, scrollLeft: element.scrollLeft }
  })
  expect(overflow.scrollWidth).toBeGreaterThan(overflow.width)
  expect(overflow.scrollLeft).toBeGreaterThan(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(layout.width)
})

for (const width of [390, 1280]) {
  test(`the header keeps its links inside a ${width}-pixel page before chat`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 })
    await page.goto("/?agent=mock")
    const navigation = page.locator(".vl-nav")
    await expect(navigation.getByText("Mock", { exact: true })).toBeVisible()
    for (const name of ["History", "Docs", "GitHub"]) {
      const link = navigation.getByRole("link", { name, exact: false })
      await expect(link).toBeVisible()
      await link.focus()
      await expect(link).toBeFocused()
    }
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: info.outputPath(`header-${width}.png`) })
    const layout = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      controls: [...document.querySelectorAll(".vl-home, .vl-nav > *")].map((element) => {
        const { left, right } = element.getBoundingClientRect()
        return { left, right }
      }),
    }))
    await info.attach("header-layout", { body: JSON.stringify(layout, null, 2), contentType: "application/json" })
    expect(layout.width).toBe(width)
    expect(layout.scrollWidth).toBeLessThanOrEqual(width)
    for (const control of layout.controls) {
      expect(control.left).toBeGreaterThanOrEqual(0)
      expect(control.right).toBeLessThanOrEqual(width)
    }
  })
}

test("maximized wiki leave the phone header links visible and clickable", async ({ page }, info) => {
  await page.goto("/?agent=mock")
  await page.getByRole("button", { name: "Wiki", exact: true }).click()
  await page.getByRole("button", { name: "Maximize the wiki" }).click()
  const pane = page.getByRole("region", { name: "Wiki", exact: true })
  await expect(pane).toHaveAttribute("data-maximized", "true")
  const paneBox = (await pane.boundingBox())!
  const links = page.locator(".vl-nav").getByRole("link")
  for (const link of await links.all()) {
    const box = (await link.boundingBox())!
    expect(box.y + box.height).toBeLessThanOrEqual(paneBox.y)
    await link.click({ trial: true })
  }
  await page.screenshot({ path: info.outputPath("maximized-docs-header.png") })
  await page.getByRole("button", { name: "Minimize the wiki" }).click()
  await expect(pane).toHaveAttribute("data-maximized", "false")
})

test("the live signed-out header keeps Sign in and every link inside a 390-pixel page", async ({ page }) => {
  const port = process.env.E2E_PORT ?? 4173
  // The injected Factory reports Live; rendering and all transport data still use the real app and offline service.
  await page.goto(`http://127.0.0.1:${port}/e2e/runtime/index.html?fault=live-header`)
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible()
  await expect(page.getByRole("combobox", { name: "Visit as" })).toHaveCount(0)
  for (const name of ["History", "Docs", "GitHub"]) {
    const link = page.getByRole("link", { name })
    await expect(link).toBeVisible()
    const box = (await link.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width)
})
