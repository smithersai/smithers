import { expect } from "@playwright/test"
import { persistent } from "./persistent"
import { strictTest as test } from "./watch"

// No app JavaScript: two real WebKit processes must give two devices separate OPFS, just as cookies and IndexedDB
// are separate. Otherwise a visitor can open a previous signed-in device's sealed engine and lose public Docs.
test("WebKit devices isolate OPFS as well as their session", async ({ playwright, baseURL, ignoreHTTPSErrors }) => {
  const marker = `smithers-isolation-${crypto.randomUUID()}`
  const seen: boolean[] = []
  for (const index of [0, 1]) {
    const device = await persistent(playwright.webkit, { baseURL, ignoreHTTPSErrors, headless: true })
    try {
      const page = await device.context.newPage()
      expect((await page.goto("/version.json"))?.ok()).toBe(true)
      seen.push(await page.evaluate(async ({ marker, index }) => {
        const root = await navigator.storage.getDirectory()
        const found = await root.getFileHandle(marker).then(() => true, (error: unknown) => {
          if (error instanceof DOMException && error.name === "NotFoundError") return false
          throw error
        })
        if (index === 0) await root.getFileHandle(marker, { create: true })
        // If the regression returns, remove only this test's marker, never the shared profile's other files.
        if (index === 1 && found) await root.removeEntry(marker)
        return found
      }, { marker, index }))
    } finally {
      await device.close()
    }
  }
  expect(seen).toEqual([false, false])
})
