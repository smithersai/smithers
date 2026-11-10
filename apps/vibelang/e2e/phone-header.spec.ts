// Stays .ts: Playwright collects browser tests by JS/TS extension only.
// On a phone the site header wraps to two rows. Every surface placed below it must start below its real height, or
// the header covers the surface's own header and its back link.
import { expect, test, type Page } from "./coverage"

/** Whether a tap at the center of the "‹ Issues" link reaches the link, not something drawn over it. */
async function backLinkReachable(page: Page) {
  const link = page.getByRole("link", { name: "‹ Issues", exact: true })
  await expect(link).toBeVisible()
  return link.evaluate((element) => {
    const box = element.getBoundingClientRect()
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    return hit !== null && (hit === element || element.contains(hit))
  })
}

for (const [mode, url] of [
  ["mock", "/?agent=mock"],
  ["live", `http://127.0.0.1:${Number(process.env.E2E_PORT ?? 4173)}/e2e/runtime/index.html?fault=live-header`],
] as const) {
  test(`an open issue's back link is not under the site header (${mode})`, async ({ page }) => {
    await page.goto(url)
    await page.getByRole("button", { name: "Issues", exact: true }).click()
    await page.getByRole("link", { name: "Case branches on tuples", exact: true }).click()
    await expect(page.getByRole("heading", { name: "#42", exact: true })).toBeVisible()
    expect(await backLinkReachable(page)).toBe(true)
    await page.getByRole("link", { name: "‹ Issues", exact: true }).click()
    await expect(page.getByRole("link", { name: "Case branches on tuples", exact: true })).toBeVisible()
  })
}
