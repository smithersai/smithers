import { devices, expect, test, type Locator, type Page } from "@playwright/test"

/*
 * The shell fits a phone. `.app-shell` is a flex item, so its default
 * min-width:auto once made it grow to its min-content width (sidebar + the
 * widest card): at a 400px viewport the shell rendered 726px and the whole
 * page scrolled sideways. The pin measures the shell itself under a wide
 * probe child, so it holds whatever cards happen to be mounted.
 */
test("the app shell fits a 400px viewport with no horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 })
  await page.goto("/")
  await expect(page.locator(".app-shell")).toHaveCount(1)

  const metrics = await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".app-shell")
    if (!shell) throw new Error("no .app-shell")
    // Wide, unshrinkable content: the shell must clip it, not grow past the viewport.
    const host = shell.querySelector<HTMLElement>(".app-main") ?? shell
    const probe = document.createElement("div")
    probe.style.cssText = "width:900px;flex:none;height:1px;"
    host.appendChild(probe)
    const rect = shell.getBoundingClientRect()
    const read = {
      shellMinWidth: getComputedStyle(shell).minWidth,
      viewport: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      shellWidth: Math.round(rect.width),
      shellRight: Math.round(rect.right)
    }
    probe.remove()
    return read
  })

  // The shrink rule itself, independent of which surface happens to be mounted.
  expect(metrics.shellMinWidth).toBe("0px")
  expect(metrics.shellWidth).toBeLessThanOrEqual(metrics.viewport)
  expect(metrics.shellRight).toBeLessThanOrEqual(metrics.viewport)
  expect(metrics.documentScrollWidth).toBeLessThanOrEqual(metrics.viewport)
})

/*
 * The shared card frame at phone width: whatever cards are mounted, no card
 * and no descendant may render past the column that holds them.
 */
test("mounted cards stay inside the transcript column at 400px", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 })
  await page.goto("/")
  await page.waitForTimeout(2000)

  const overflowing = await page.evaluate(() => {
    const out: string[] = []
    for (const card of document.querySelectorAll<HTMLElement>(".smithers-card")) {
      const column = card.parentElement
      if (!column) continue
      const edge = column.getBoundingClientRect().right
      for (const el of [card, ...card.querySelectorAll<HTMLElement>("*")]) {
        const rect = el.getBoundingClientRect()
        if (rect.width > 0 && rect.right > edge + 1) out.push(`${el.tagName}.${el.className} right=${Math.round(rect.right)} edge=${Math.round(edge)}`)
      }
    }
    return out.slice(0, 10)
  })

  expect(overflowing).toEqual([])
})

const openTutorial = async (page: Page) => {
  await page.goto("/smithersai/smithers/?tutorial")
  await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "1")
}

// Measure before tapping: locator.tap() can scroll overflow:hidden ancestors,
// making a pill that a real finger cannot reach appear to work.
const reachableAction = async (page: Page, action: Locator) => {
  await expect(action).toBeVisible()
  const box = (await action.boundingBox())!
  const footer = (await page.locator(".guide-footer").boundingBox())!
  const viewport = page.viewportSize()!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
  expect(box.y + box.height).toBeLessThanOrEqual(footer.y)
  expect(await action.evaluate(element => {
    const rect = element.getBoundingClientRect()
    return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
  })).toBe(true)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

for (const device of [
  { name: "iPhone 14 portrait", descriptor: "iPhone 14", viewport: { width: 390, height: 844 } },
  { name: "iPhone 14 landscape", descriptor: "iPhone 14", viewport: { width: 844, height: 390 } },
  { name: "iPad Mini", descriptor: "iPad Mini", viewport: { width: 768, height: 1024 } },
]) {
  test.describe(device.name, () => {
    const { defaultBrowserType: _, ...descriptor } = devices[device.descriptor]
    test.use({ ...descriptor, viewport: device.viewport, contextOptions: { reducedMotion: "reduce" } })

    test("tutorial pills stay reachable above the footer with help open and dismissed", async ({ page }) => {
      await openTutorial(page)
      const issues = page.getByRole("button", { name: "Show issues", exact: true })
      const review = page.getByRole("button", { name: "Review changes", exact: true })
      await expect(page.getByRole("note", { name: "Help" })).toBeVisible()
      await reachableAction(page, issues)
      await reachableAction(page, review)
      await page.locator(".guide-actions .help-bubble-dismiss").tap()
      await reachableAction(page, review)
      const point = await reachableAction(page, issues)
      await page.touchscreen.tap(point.x, point.y)
      await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "2")
    })

    test("Chat gives touch suggestions the remaining height and keeps Mode clear", async ({ page }) => {
      await openTutorial(page)
      await page.getByRole("button", { name: "Chat", exact: true }).tap()
      const input = page.getByTestId("composer-input")
      // A touch open shows the composer; the on-screen keyboard follows the user's own tap on it.
      await expect(input).toBeVisible()
      await input.tap()
      await expect(input).toBeFocused()
      const header = (await page.locator(".session-navigation").boundingBox())!
      const inputBox = (await input.boundingBox())!
      expect.soft(inputBox.y).toBeGreaterThanOrEqual(header.y + header.height)
      await input.fill("hello from a phone")
      await expect(input).toHaveValue("hello from a phone")
      expect(await input.evaluate(element => {
        const rect = element.getBoundingClientRect()
        return document.elementFromPoint(rect.x + 2, rect.y + 2) === element
      })).toBe(true)
      await expect(page.locator(".palette-foot")).toBeHidden()
      await input.fill("/")
      const list = page.locator(".slash-menu-body")
      const first = page.getByTestId("palette").getByRole("option").first()
      const listBox = (await list.boundingBox())!
      const rowBox = (await first.boundingBox())!
      expect(listBox.height).toBeGreaterThanOrEqual(rowBox.height)
      expect(await first.evaluate(element => {
        const box = element.getBoundingClientRect()
        return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
      })).toBe(true)
      const mode = page.getByRole("dialog", { name: "Chat" }).getByRole("button", { name: "Mode: Normal", exact: true })
      expect((await mode.boundingBox())!.y).toBeGreaterThanOrEqual(listBox.y + listBox.height)
      await input.fill("hello from a phone")
      await page.keyboard.press("Escape")
      await expect(page.getByRole("dialog", { name: "Chat", exact: true })).toBeHidden()
      await expect(page.locator(".guide-shell")).toHaveAttribute("data-conversation-open", "false")
      await page.getByRole("button", { name: "Chat", exact: true }).tap()
      await expect(input).toBeFocused()
      await expect(input).toHaveValue("hello from a phone")
      await page.touchscreen.tap(1, device.viewport.height / 2)
      await expect(page.getByRole("dialog", { name: "Chat", exact: true })).toBeHidden()
    })

    test("the issue transcript gets the remaining height and scrolls independently of the actions", async ({ page }) => {
      await openTutorial(page)
      await page.keyboard.press("i")
      await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "2")
      await page.keyboard.press("r")
      await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "3")
      const transcript = page.getByRole("log", { name: "Onboarding chat history" })
      await expect(transcript.locator('[data-kind="issue"]')).toBeVisible()
      expect((await transcript.boundingBox())!.height).toBeGreaterThanOrEqual(device.viewport.height * 0.4)
      const action = page.getByRole("button", { name: "View issue flows", exact: true })
      const before = await reachableAction(page, action)
      await transcript.evaluate(element => { element.scrollTop = element.scrollHeight })
      expect(await reachableAction(page, action)).toEqual(before)
      await transcript.evaluate(element => { element.scrollTop = 0 })
      await expect.poll(() => transcript.evaluate(element => element.scrollTop)).toBe(0)
    })

    if (device.viewport.width === 390) {
      test("the flows card wraps the full flow title at phone width", async ({ page }) => {
        await openTutorial(page)
        await page.keyboard.press("i")
        await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "2")
        await page.keyboard.press("r")
        await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "3")
        await page.keyboard.press("e")
        await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "4")
        const title = page.locator('.guide-transcript .workflow-list-text > span').first()
        await expect(title).toContainText("Research and reproduce")
        await title.scrollIntoViewIfNeeded()
        const metrics = await title.evaluate(element => {
          const style = getComputedStyle(element)
          return { whiteSpace: style.whiteSpace, overflow: style.textOverflow, height: element.getBoundingClientRect().height,
            lineHeight: parseFloat(style.lineHeight), width: element.clientWidth, scrollWidth: element.scrollWidth }
        })
        expect(metrics.whiteSpace).not.toBe("nowrap")
        expect(metrics.overflow).not.toBe("ellipsis")
        expect(metrics.height).toBeGreaterThan(metrics.lineHeight)
        expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.width)
      })
    }
  })
}
