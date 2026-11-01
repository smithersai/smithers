import { expect, type Page } from "@playwright/test"
import { strictTest as test } from "./watch"
import { requires, syncedRepository } from "./target"

// The mock look (ruling FE-20, docs/work/ui-polish.md), held as computed styles so a page that drifts back to the
// browser's defaults fails: links are the brand, never the user agent's blue; every full page wears the shared
// PageHeader; tables are cards on the paper; nothing overflows a phone.

const USER_AGENT_BLUE = "rgb(0, 0, 238)"

async function lookOf(page: Page) {
  return page.evaluate(() => {
    const links = [...document.querySelectorAll("a[href]")].filter((link) => (link as HTMLElement).offsetParent !== null)
    const header = document.querySelector("[data-slot='page-header']")
    const tables = [...document.querySelectorAll("[data-slot='table-container']")]
    return {
      linkColors: [...new Set(links.map((link) => getComputedStyle(link).color))],
      underlined: links.filter((link) => getComputedStyle(link).textDecorationLine.includes("underline") && link.closest("article,.sui-md") === null).length,
      header: header === null ? null : getComputedStyle(header).position,
      tableRadii: tables.map((table) => (table as HTMLElement).dataset.variant === "plain" ? "plain" : getComputedStyle(table).borderTopLeftRadius),
      overflow: document.scrollingElement!.scrollWidth - window.innerWidth,
    }
  })
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px look`, () => {
    test.use({ viewport })

    test("Runs: brand links, the shared header, card tables, no sideways scroll", async ({ page }) => {
      await page.goto("/app/runs")
      await expect(page.getByRole("table", { name: "Flows" })).toBeVisible({ timeout: 30_000 })
      const look = await lookOf(page)
      expect(look.linkColors).not.toContain(USER_AGENT_BLUE)
      expect(look.underlined).toBe(0)
      expect(look.header).toBe("sticky")
      expect(look.tableRadii.length).toBeGreaterThan(0)
      for (const radius of look.tableRadii) expect(radius === "plain" || parseFloat(radius) > 0).toBe(true)
      expect(look.overflow).toBeLessThanOrEqual(0)
    })

    test("a repository's issues: the shared header with its sections, no sideways scroll", async ({ page }) => {
      requires("githubApp", "syncedRepository")
      await page.goto(`/${syncedRepository()}/issues`)
      const header = page.locator("header[aria-label='Repository'][data-slot='page-header']")
      await expect(header).toBeVisible({ timeout: 30_000 })
      await expect(header.getByRole("navigation", { name: "Repository sections" }).getByRole("link", { name: "Issues", exact: true }))
        .toHaveAttribute("aria-current", "page")
      const look = await lookOf(page)
      expect(look.linkColors).not.toContain(USER_AGENT_BLUE)
      expect(look.overflow).toBeLessThanOrEqual(0)
    })

    test("an issue: its back link starts at the title's left edge", async ({ page }) => {
      requires("githubApp", "syncedRepository")
      await page.goto(`/${syncedRepository()}/issues/1`)
      const back = page.locator("[data-slot='page-body'] > .sui-button")
      await expect(back).toBeVisible({ timeout: 30_000 })
      await expect(page.locator(".sui-item-conv-title")).toBeVisible({ timeout: 30_000 })
      const [link, title] = await Promise.all([back.boundingBox(), page.locator(".sui-item-conv-title").boundingBox()])
      const label = await back.evaluate((button) => parseFloat(getComputedStyle(button).paddingLeft))
      expect(link!.x + label).toBe(title!.x)
      // The meta row wraps rather than squeezing its words: the author reads as one line box.
      expect(await page.locator(".sui-item-conv-meta .sui-item-conv-author").evaluate((author) => author.getClientRects().length)).toBe(1)
    })
  })
}
