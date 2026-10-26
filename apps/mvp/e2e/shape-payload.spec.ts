import { expect, test } from "./fixtures"
import { ShapeSync } from "./sync"
import { baseURL, requires, signedOut, target } from "./target"

// Real initial response bodies, without intercepting traffic. This runs on local stacks and deployments.
// Before the summary split, both lists downloaded every issue body and every comment in the repository.
for (const repo of ["smithersai/smithers", "smithersai/vibelang"]) {
  for (const suffix of ["", "/issues", "/pulls"]) {
    test(`${repo}${suffix}: signed-out initial shapes contain no detail text or comment rows`, async ({ browser }) => {
      requires("codeStorage")
      test.setTimeout(180_000)
      const context = await browser.newContext({ ...signedOut, recordVideo: { dir: test.info().outputPath("videos") } })
      if (target === "local") {
        const secure = baseURL.startsWith("https:")
        await context.addCookies([{ name: `${secure ? "__Host-" : ""}smithers_dev_signed_out`, value: "1", url: baseURL, secure }])
      }
      const page = await context.newPage()
      const sync = new ShapeSync()
      const asked = new Set<string>()
      const batches: Array<{ name: string; bytes: number; rows: Array<{ value?: Record<string, unknown> }> }> = []
      const pending: Array<Promise<void>> = []
      page.on("request", (request) => {
        sync.requested(request.url())
        const url = new URL(request.url())
        if (url.pathname.startsWith("/api/shapes/")) asked.add(url.pathname.slice("/api/shapes/".length))
      })
      page.on("response", (response) => {
        sync.answered(response.url(), response.status(), response.headers())
        const url = new URL(response.url())
        if (!url.pathname.startsWith("/api/shapes/") || url.searchParams.has("live")) return
        pending.push((async () => {
          const bytes = await response.body()
          const rows = JSON.parse(bytes.toString()) as Array<{ value?: Record<string, unknown> }>
          batches.push({ name: url.pathname.slice("/api/shapes/".length), bytes: bytes.length, rows })
        })())
      })
      try {
        await page.goto(`/${repo}${suffix}`)
        await expect(page.locator("main").first()).toBeVisible({ timeout: 60_000 })
        if (repo === "smithersai/smithers" && suffix !== "") {
          await expect.poll(() => batches.filter((batch) => batch.name === "item-summaries").length, { timeout: 90_000 }).toBeGreaterThan(0)
        }
        let seen = -1
        await expect(() => {
          const stable = sync.count === seen
          seen = sync.count
          expect(sync.behind()).toEqual([])
          expect(stable).toBe(true)
        }).toPass({ intervals: [1_000, 2_000], timeout: 90_000 })
        await Promise.all(pending)
        expect([...asked].filter((name) => ["items", "comments"].includes(name))).toEqual([])
        const summaries = batches.filter((batch) => batch.name === "item-summaries")
        const rows = summaries.flatMap((batch) => batch.rows.flatMap((row) => row.value === undefined ? [] : [row.value]))
        if (summaries.length > 0) expect(rows.length).toBeGreaterThan(0)
        expect(rows.every((row) => !("body" in row))).toBe(true)
        // A regression budget, above current summary size and below the former body+comments transfer.
        expect(summaries.reduce((bytes, batch) => bytes + batch.bytes, 0)).toBeLessThan(3_000_000)
        test.info().annotations.push({ type: "shape-payload", description: JSON.stringify(batches.map(({ name, bytes, rows }) => ({ name, bytes, rows: rows.filter((row) => row.value !== undefined).length }))) })
      } finally {
        await context.close()
      }
    })
  }
}
