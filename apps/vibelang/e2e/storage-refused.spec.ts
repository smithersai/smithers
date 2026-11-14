// Stays .ts: Playwright collects test files by JS/TS extension only.
// A browser that refuses storage, as a private window may: both pages start, choose mock or live from the address
// alone and remember nothing (src/web/startup.vibe `askedForMock` and its tour state, src/web/historyStartup.vibe
// `askedForMock` and `mockRole`).
import { expect, test } from "./coverage"

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    for (const name of ["localStorage", "sessionStorage"] as const) {
      Object.defineProperty(window, name, { configurable: true, get() { throw new DOMException("Storage is refused.", "SecurityError") } })
    }
  })
})

test("with storage refused the chat starts as a first visit, with the tour", async ({ page }) => {
  const errors: Array<string> = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto("/")
  // Nothing can remember a finished tour, so the page starts it as it does on a first visit.
  await expect(page.locator(".vl-theatre-bar")).toBeVisible({ timeout: 20_000 })
  expect(errors).toEqual([])
})

test("with storage refused the history page shows its outline", async ({ page }) => {
  const errors: Array<string> = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto("/history")
  await expect(page.getByRole("button", { name: /The compiler/ })).toBeVisible({ timeout: 20_000 })
  expect(errors).toEqual([])
})
