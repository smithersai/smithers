import { expect, test } from "./fixtures"
import { requires } from "./target"

for (const path of ["issues/4432", "pull/4436"]) {
  test(`${path}: detail shapes contain only the selected item`, async ({ page }) => {
    requires("githubApp")
    const number = path.split("/")[1]!
    const batches: Array<Promise<void>> = []
    const seen = new Set<string>()
    page.on("response", (response) => {
      const url = new URL(response.url())
      if (!["/api/shapes/items", "/api/shapes/comments"].includes(url.pathname) || url.searchParams.has("live")) return
      batches.push((async () => {
        expect(response.status()).toBe(200)
        expect(url.searchParams.get("number")).toBe(number)
        seen.add(url.pathname)
        const rows = await response.json() as Array<{ value?: { number?: number | string; item_id?: string } }>
        for (const row of rows) {
          if (!row.value) continue
          if (url.pathname.endsWith("/items")) expect(String(row.value.number)).toBe(number)
          else expect(row.value.item_id).toBe(`github/smithersai/smithers#${number}`)
        }
      })())
    })
    await page.goto(`/smithersai/smithers/${path}`)
    await expect(page.getByRole("heading", { level: 1 }).filter({ hasText: `#${number}` })).toContainText(`#${number}`, { timeout: 60_000 })
    await expect.poll(() => seen.size).toBe(2)
    await Promise.all(batches)
  })
}
