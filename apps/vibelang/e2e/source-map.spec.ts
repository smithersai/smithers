// Stays .ts: Playwright collects test files through its JS/TS loader.
import { expect, test } from "./coverage"
import { measure, readBuild, sourcesIn } from "./coverage-reporter"
import { resolve } from "node:path"

test("Chromium remapping retains a tree-shaken export and an unvisited nested Effect branch, and credits what Rolldown leaves unmapped", async ({ context }, info) => {
  // Cold compiler startup and bundle remapping exceed the UI deadline on the shared lane host.
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
    const coverage = await measure(entries, await sourcesIn(["e2e/coverage-fixtures"]), await readBuild())
    const file = coverage.fileCoverageFor(resolve("e2e/coverage-fixtures/fixture.vibe"))
    const misses = Object.entries(file.s).filter(([, count]) => count === 0).map(([id]) => file.statementMap[id].start.line)
    expect(misses).toContain(9)
    expect(file.toSummary().branches.pct).toBeLessThan(100)
    expect(file.toSummary().functions.pct).toBeLessThan(100)
    // The e2e build is unminified (decision 0016), so the unvisited `return 9` keeps its own statement. A minified
    // bundle folds both returns into one and credits it: test/browserCoverageMerge.test.vibe keeps that case.
    expect(misses).toContain(4)
    expect(file.getLineCoverage()[3]).toBeGreaterThan(0)
    // Rolldown prints no map segment where `(serial ?? 0) + 1` starts; the build's structure still credits the line.
    expect(await page.evaluate(() => Reflect.get(window, "coverageScrolled"))).toBe(2)
    const built = coverage.fileCoverageFor(resolve("e2e/coverage-fixtures/initializer.vibe"))
    const unrun = Object.entries(built.s).filter(([, count]) => count === 0).map(([id]) => built.statementMap[id].start.line)
    expect(unrun).toEqual([10])
  } finally {
    await page.close()
  }
})
