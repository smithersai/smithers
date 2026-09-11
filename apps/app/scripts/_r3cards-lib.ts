import { chromium, type Page } from "playwright"

export const BASE = "https://canary.smithers.sh"
export const PROFILE = "/tmp/round3-cards-profile"

export const open = async (opts: { width?: number; height?: number } = {}) => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: true,
    viewport: { width: opts.width ?? 1280, height: opts.height ?? 900 }
  })
  const page = ctx.pages()[0] ?? (await ctx.newPage())
  const consoleErrors: string[] = []
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text())
  })
  page.on("pageerror", (e) => consoleErrors.push(String(e)))
  await page.goto(BASE, { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(4500)
  return { ctx, page, consoleErrors }
}

/** Type a slash flow into the composer and send it. */
export const runFlow = async (page: Page, text: string, waitMs = 6000) => {
  const box = page.locator("textarea").first()
  await box.click({ force: true })
  await box.fill(text)
  await page.waitForTimeout(900)
  await box.press("Enter")
  await page.waitForTimeout(waitMs)
}

export const cards = async (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll(".smithers-card")).map((el) => ({
      kind: el.getAttribute("data-kind"),
      status: el.getAttribute("data-status"),
      maximized: el.getAttribute("data-maximized"),
      pill: (el.querySelector(".smithers-status-pill,[class*='status-pill']") as HTMLElement | null)?.innerText ?? "",
      title: (el.querySelector(".smithers-card-title") as HTMLElement | null)?.innerText ?? "",
      text: (el as HTMLElement).innerText.replace(/\s+/g, " ").slice(0, 700),
      flows: Array.from(el.querySelectorAll("[data-flow]")).map((b) => b.getAttribute("data-flow"))
    }))
  )

export const lastCard = async (page: Page, kind: string) =>
  page.evaluate((k) => {
    const list = Array.from(document.querySelectorAll(`.smithers-card[data-kind="${k}"]`))
    const el = list[list.length - 1] as HTMLElement | undefined
    if (!el) return null
    return {
      kind: el.getAttribute("data-kind"),
      status: el.getAttribute("data-status"),
      pill: (el.querySelector(".smithers-status-pill,[class*='status-pill']") as HTMLElement | null)?.innerText ?? "",
      title: (el.querySelector(".smithers-card-title") as HTMLElement | null)?.innerText ?? "",
      text: el.innerText.replace(/\s+/g, " ").slice(0, 1200),
      flows: Array.from(el.querySelectorAll("[data-flow]")).map((b) => b.getAttribute("data-flow"))
    }
  }, kind)
