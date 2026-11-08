// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
import { expect, type Page, test } from "@playwright/test"

// Learn more starts the agent's tour (wiki/decisions/0014-agent-tour.md, ruling VL-28), on the mock: the agent
// narrates, opens VibeLang's docs in a pane and moves it, while a glow and Esc show it is in control.

const DOCS = "https://vibelang.sh"

async function learnMore(page: Page) {
  await page.goto("/")
  await page.getByRole("button", { name: "Learn more" }).click()
}

/** Waits until no view transition runs, so a screenshot shows the page and not a transition's snapshot. */
async function settled(page: Page) {
  await page.waitForFunction(() => !document.documentElement.matches(":active-view-transition"))
}

const frame = (page: Page) => page.getByTitle("VibeLang docs")
const narration = (page: Page) => page.locator(".sui-chat-message[data-role='assistant']").first()

test.describe("the splash's actions", () => {
  test("Learn more is the primary action; Ask the agent and Contribute are secondary", async ({ page }, testInfo) => {
    await page.goto("/")
    const learn = page.getByRole("button", { name: "Learn more" })
    const ask = page.getByRole("button", { name: "Ask the agent" })
    const contribute = page.getByRole("link", { name: "Contribute" })
    await expect(learn).toBeVisible()
    await expect(ask).toBeVisible()
    await expect(contribute).toBeVisible()
    await expect(contribute).toHaveAttribute("href", "https://github.com/smithersai/vibelang/blob/main/CONTRIBUTING.md")
    // The primary is filled with the brand color; the secondaries share one quieter style, and come after it.
    const fill = (locator: typeof learn) => locator.evaluate((element) => getComputedStyle(element).backgroundColor)
    expect(await fill(learn)).not.toBe(await fill(ask))
    expect(await fill(ask)).toBe(await fill(contribute))
    const [first, second, third] = await Promise.all([learn, ask, contribute].map((locator) => locator.boundingBox()))
    expect(first!.y <= second!.y && (first!.y < second!.y || first!.x < second!.x)).toBe(true)
    expect(second!.y <= third!.y && (second!.y < third!.y || second!.x < third!.x)).toBe(true)
    // Ask the agent keeps ⌘K.
    await page.keyboard.press("ControlOrMeta+k")
    await expect(page.getByRole("dialog", { name: "Ask the agent" })).toBeVisible()
    await page.keyboard.press("Escape")
    await page.screenshot({ path: testInfo.outputPath("splash.png") })
  })
})

test.describe("the agent's tour", () => {
  test("Learn more turns the page into the chat; the agent opens the docs, moves them and narrates, with the glow and Esc", async ({ page }, testInfo) => {
    await learnMore(page)
    await expect(page.getByRole("log", { name: "Conversation" })).toBeVisible()
    // The glow surrounds the whole screen, and never takes a click.
    const glow = page.locator(".vl-glow")
    await expect(glow).toBeVisible()
    const box = await glow.boundingBox()
    const viewport = page.viewportSize()!
    expect(box).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height })
    await expect(glow).toHaveCSS("pointer-events", "none")
    await expect(glow).toHaveCSS("animation-name", "vl-glow")
    await expect(page.getByRole("button", { name: "Esc" })).toBeVisible()

    await expect(frame(page)).toHaveAttribute("src", `${DOCS}/`)
    await expect(page.getByRole("region", { name: "Docs" })).toBeVisible()
    await expect(narration(page)).toContainText("VibeLang is Effect as its own language")
    // Esc never covers the top bar's links.
    const esc = (await page.getByRole("button", { name: "Esc" }).boundingBox())!
    const docs = (await page.getByRole("link", { name: "Docs" }).boundingBox())!
    expect(esc.x + esc.width <= docs.x || esc.y >= docs.y + docs.height).toBe(true)
    await settled(page)
    await page.screenshot({ path: testInfo.outputPath("tour.png") })
    await expect(frame(page)).toHaveAttribute("src", `${DOCS}/getting-started/002-why-effect`, { timeout: 10_000 })
    await expect(narration(page)).toContainText("Effect gives a program typed errors")

    // The tour ends on its own at the last stop: the agent hands control back, and the docs stay.
    await expect(frame(page)).toHaveAttribute("src", `${DOCS}/vips`, { timeout: 20_000 })
    await expect(narration(page)).toHaveAttribute("data-done", "true", { timeout: 10_000 })
    await expect(glow).toBeHidden()
    await expect(page.getByRole("button", { name: "Esc" })).toBeHidden()
    await expect(narration(page)).toContainText("open-source coding factory")
  })

  for (const how of ["Escape", "the Esc button"] as const) {
    test(`${how} ends the tour at once: the glow goes, the agent stops, the chat and the docs stay`, async ({ page }) => {
      await learnMore(page)
      await expect(narration(page)).toContainText("VibeLang is")
      if (how === "Escape") await page.keyboard.press("Escape")
      else await page.getByRole("button", { name: "Esc" }).click()
      await expect(page.locator(".vl-glow")).toBeHidden()
      await expect(page.getByRole("button", { name: "Esc" })).toBeHidden()
      await expect(narration(page)).toHaveAttribute("data-done", "true")
      const said = await narration(page).innerText()
      // Long past the next stop: the agent said nothing more and moved nothing.
      await page.waitForTimeout(2_500)
      expect(await narration(page).innerText()).toBe(said)
      await expect(frame(page)).toHaveAttribute("src", `${DOCS}/`)
      await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible()
    })
  }

  test("the docs pane maximizes and minimizes", async ({ page }) => {
    await learnMore(page)
    await expect(frame(page)).toBeVisible()
    await page.getByRole("button", { name: "Esc" }).click()
    await page.getByRole("button", { name: "Maximize the docs" }).click()
    const pane = page.getByRole("region", { name: "Docs" })
    await expect(pane).toHaveAttribute("data-maximized", "true")
    const viewport = page.viewportSize()!
    const box = (await pane.boundingBox())!
    expect(box.width).toBe(viewport.width)
    expect(box.y + box.height).toBeCloseTo(viewport.height, 0)
    await page.keyboard.press("Escape")
    await expect(pane).toHaveAttribute("data-maximized", "false")
  })

  test("reduced motion: the glow is still", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" })
    await learnMore(page)
    const glow = page.locator(".vl-glow")
    await expect(glow).toBeVisible()
    await expect(glow).toHaveCSS("animation-name", "none")
    await expect(glow).toHaveCSS("opacity", "1")
  })
})
