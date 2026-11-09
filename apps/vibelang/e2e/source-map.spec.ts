// Stays .ts: Playwright collects test files through its JS/TS loader.
import { expect, test } from "./coverage"
import { measure } from "./coverage-reporter"
import { resolve } from "node:path"

test("Chromium remapping retains a tree-shaken export and an unvisited nested Effect branch", async ({ context }, info) => {
  // Cold compiler startup and bundle remapping exceed the UI deadline on the shared lane host.
  // Keep every positive control before the known mapping-defect assertion.
  test.skip(process.env.E2E_BASE_URL !== undefined, "it remaps the local build's source maps, which a deployment does not serve")
  test.setTimeout(120_000)
  const page = await context.newPage()
  const maps = new Map<string, Promise<unknown>>()
  page.on("response", (response) => {
    if (!response.url().endsWith(".js")) return
    maps.set(response.url(), response.text().then(async (source) => {
      const reference = /\/\/# sourceMappingURL=(\S+)/.exec(source)?.[1]
      if (!reference) return undefined
      return (await page.request.get(new URL(reference, response.url()).href)).json()
    }))
  })
  try {
    await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: false })
    await page.goto("/e2e/coverage-fixtures/index.html")
    await expect.poll(() => page.evaluate(() => Reflect.get(window, "coverageAnswer"))).toBe(7)
    const scripts = await page.coverage.stopJSCoverage()
    const entries = []
    for (const script of scripts) {
      const sourceMap = await maps.get(script.url)
      if (sourceMap) entries.push({ ...script, sourceMap })
    }
    await info.attach("chromium-map-control", { body: JSON.stringify(entries), contentType: "application/json" })
    const coverage = await measure(entries, ["e2e/coverage-fixtures"])
    const file = coverage.fileCoverageFor(resolve("e2e/coverage-fixtures/fixture.vibe"))
    const misses = Object.entries(file.s).filter(([, count]) => count === 0).map(([id]) => file.statementMap[id].start.line)
    expect(misses).toContain(9)
    expect(file.toSummary().branches.pct).toBeLessThan(100)
    expect(file.toSummary().functions.pct).toBeLessThan(100)
    // Earlier setup, unused-export and branch checks must pass independently of the known line defect.
    test.fail(true, "Known bundled statement mapping defect; ~/vl/vibelang-bugs/coverage-source-ranges, decision 0016")
    expect(misses).toContain(4)
    expect(file.getLineCoverage()[3]).toBeGreaterThan(0)
  } finally {
    await page.close()
  }
})
