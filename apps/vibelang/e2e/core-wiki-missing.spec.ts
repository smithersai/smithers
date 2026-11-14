// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
// An address names a wiki page the build doesn't have: the mock's wiki tool finds no path for it
// (src/core/flows.vibe `openWiki`, "unknown-page"), the factory refuses the open (src/core/MockFactory.vibe `openWiki`),
// and the pane says the wiki didn't load; the index still opens.
import { expect, test } from "./coverage"

test("an address for a page the wiki doesn't have says the wiki didn't load", async ({ page }) => {
  await page.goto("/wiki/no-such-page?agent=mock")
  const wiki = page.getByRole("region", { name: "Wiki", exact: true })
  await expect(wiki.getByText("The wiki didn't load", { exact: true })).toBeVisible()
  await page.goto("/wiki/index?agent=mock")
  await expect(wiki.getByText("The wiki didn't load", { exact: true })).toHaveCount(0)
  await expect(wiki.locator(".vl-wiki-content a[href^='/wiki/']").first()).toBeVisible()
})
