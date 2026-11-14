// Stays .ts: Playwright loads fixtures and their imports through its JS/TS loader.
import { test as base, expect } from "@playwright/test"
import { mkdir, writeFile } from "node:fs/promises"

/** Chromium's own precise coverage; each test retains its own data, including failed tests and navigations. */
export const test = base.extend<{ sourceCoverage: void }>({
  sourceCoverage: [async ({ page, browserName }, use, info) => {
    if (browserName !== "chromium") throw new Error("Source coverage requires Chromium")
    const maps = new Map<string, Promise<{ value?: unknown; error?: unknown }>>()
    page.on("response", (response) => {
      if (!/\.js(?:\?|$)/.test(response.url())) return
      const url = response.url()
      // Embedded documentation belongs to another site; only this app's scripts enter its denominator.
      if (!response.ok() || new URL(url).origin !== new URL(page.url()).origin) return
      // Vite's generated preload helper and Rolldown's module loader contains no application source and has no source map.
      if (/\/(?:rolldown-runtime|preload-helper)-[^/]+\.js$/.test(new URL(url).pathname)) return
      maps.set(url, response.text().then(async (code) => {
        const reference = /\/\/# sourceMappingURL=(\S+)/.exec(code)?.[1]
        // A generated re-export facade has no executable statements or application source of its own.
        if (!reference && /^\s*export\s*\{[^}]*\}\s*from\s*["'][^"']+["'];?\s*$/.test(code)) return { value: null }
        if (!reference) throw new Error(`Missing source map: ${url}`)
        const response = await page.request.get(new URL(reference, url).href)
        if (!response.ok()) throw new Error(`Source map answered ${response.status()}: ${url}`)
        return { value: await response.json() }
      }).catch((error) => ({ error })))
    })
    await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: false })
    try {
      await use()
    } finally {
      const scripts = await page.coverage.stopJSCoverage()
      const entries = (await Promise.all(scripts.filter((script) => maps.has(script.url)).map(async (script) => {
        const map = (await maps.get(script.url))!
        if (map.error) throw map.error
        if (map.value === null) return null
        return { ...script, sourceMap: map.value }
      }))).filter((entry) => entry !== null)
      // A function V8 ran without block counters reports only its call count; merged with other tests' block
      // coverage its branch evidence is dropped (@bcoe/v8-coverage), so a branch it took would read as never taken.
      const lost = entries.flatMap((entry) => entry.functions.filter((fn) => !fn.isBlockCoverage && fn.ranges[0]!.count > 0).map(() => entry.url))
      if (lost.length > 0) throw new Error(`Block coverage lost for ${lost.length} executed functions in ${new Set(lost).size} scripts, first ${lost[0]}`)
      const directory = info.outputPath("coverage")
      await mkdir(directory, { recursive: true })
      const path = info.outputPath("coverage", "chromium.json")
      await writeFile(path, JSON.stringify(entries))
      await info.attach("chromium-coverage", { path, contentType: "application/json" })
    }
  }, { auto: true }],
})

export { expect }
