// Stays .ts: Playwright loads fixtures and their imports through its JS/TS loader.
import { test as base, expect } from "@playwright/test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const buildFiles = new Map<string, Promise<string>>()
const maps = new Map<string, Promise<unknown>>()
function builtFile(path: string) {
  let content = buildFiles.get(path)
  if (!content) { content = readFile(path, "utf8"); buildFiles.set(path, content) }
  return content
}

/** Chromium's actual scripts and ranges, retained per test, including failures and navigations. */
export const test = base.extend<{ sourceCoverage: void }>({
  sourceCoverage: [async ({ page, browserName }, use, info) => {
    if (browserName !== "chromium") throw new Error("Source coverage requires Chromium")
    await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: false })
    try {
      await use()
    } finally {
      const scripts = await page.coverage.stopJSCoverage()
      const origin = new URL(page.url()).origin
      const entries = []
      for (const script of scripts) {
        if (!/\.js(?:\?|$)/.test(script.url) || new URL(script.url).origin !== origin) continue
        // Vite's generated runtime/preload helpers and pure export facades contain no application source.
        if (/\/(?:rolldown-runtime|preload-helper)-[^/]+\.js$/.test(new URL(script.url).pathname)) continue
        const code = script.source
        if (code === undefined) throw new Error(`Missing executed source: ${script.url}`)
        const reference = /\/\/# sourceMappingURL=(\S+)/.exec(code)?.[1]
        if (!reference && /^\s*export\{[^}]*\}from["'][^"']+["'];?\s*$/.test(code)) continue
        if (!reference) throw new Error(`Missing source map: ${script.url}`)
        const mapUrl = new URL(reference, script.url)
        if (process.env.E2E_BASE_URL === undefined) {
          if (mapUrl.origin !== origin) throw new Error(`Unexpected source map origin: ${script.url}`)
          const scriptPath = resolve(root, "dist", new URL(script.url).pathname.slice(1))
          if (!scriptPath.startsWith(resolve(root, "dist") + "/")) throw new Error("Executed script escapes the build")
          if (await builtFile(scriptPath) !== code) throw new Error(`Executed script differs from the build: ${script.url}`)
        }
        let pending = maps.get(mapUrl.href)
        if (!pending) {
          pending = (async () => {
            if (process.env.E2E_BASE_URL === undefined) {
              const mapPath = resolve(root, "dist", mapUrl.pathname.slice(1))
              if (!mapPath.startsWith(resolve(root, "dist") + "/")) throw new Error("Source map escapes the build")
              return JSON.parse(await builtFile(mapPath))
            }
            const response = await page.request.get(mapUrl.href)
            if (!response.ok()) throw new Error(`Source map answered ${response.status()}: ${script.url}`)
            return response.json()
          })()
          maps.set(mapUrl.href, pending)
        }
        entries.push({ ...script, sourceMap: await pending })
      }
      const directory = info.outputPath("coverage")
      await mkdir(directory, { recursive: true })
      const path = info.outputPath("coverage", "chromium.json")
      await writeFile(path, JSON.stringify(entries))
      await info.attach("chromium-coverage", { path, contentType: "application/json" })
    }
  }, { auto: true }],
})

export { expect }
export type * from "@playwright/test"
