// Stays .ts: Playwright collects test files through its JS/TS loader.
// Chromium keeps a document's coverage only while that document's scripts live. A test that loads a second document
// (page.goto, a reload, a full-load link) must still report the first one's counts, or every journey that visits two
// pages under-credits the browser gate (vl-coverage session 21: the history page's viewer arm read 0 after the
// viewer-then-contributor journey). The projects' launch flags (playwright.config.ts) keep them.
import { expect, test } from "./coverage"

test("coverage keeps every document a test loaded, not only the last", async ({ context }) => {
  test.skip(process.env.E2E_BASE_URL !== undefined, "it reads the local build's fixture page")
  const page = await context.newPage()
  try {
    await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: false })
    for (const visit of ["first", "second"]) {
      await page.goto(`/e2e/coverage-fixtures/index.html?visit=${visit}`)
      await expect.poll(() => page.evaluate(() => Reflect.get(window, "coverageAnswer"))).toBe(7)
    }
    const scripts = (await page.coverage.stopJSCoverage()).filter((script) => new URL(script.url).pathname.endsWith(".js"))
    const loads = new Map<string, number>()
    for (const script of scripts) loads.set(script.url, (loads.get(script.url) ?? 0) + 1)
    expect(loads.size).toBeGreaterThan(0)
    expect([...loads.values()]).toEqual([...loads.keys()].map(() => 2))
  } finally {
    await page.close()
  }
})
