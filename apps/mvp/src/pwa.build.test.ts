// The production build (`vite build`, which `pnpm run deploy` runs): it succeeds, and its service worker precaches
// the app's bundle and the engine worker, so an offline reload has both, and leaves the docs site's paths alone. Workbox skips a file over its size limit and
// fails the build; on 2026-10-20 both files outgrew its 2 MiB default and the first production deploy failed here.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { build } from "vite"
import { afterAll, expect, test } from "vitest"
import { DOCS_SITE } from "./pwa"

const root = join(import.meta.dirname, "..")
const outDir = mkdtempSync(join(tmpdir(), "smithers-mvp-build-"))
afterAll(() => rmSync(outDir, { recursive: true, force: true }))

test("the production build succeeds and precaches the app's bundle and the engine worker", async () => {
  await build({ root, configFile: join(root, "vite.config.ts"), logLevel: "silent", build: { outDir, emptyOutDir: true } })
  const assets = readdirSync(join(outDir, "assets"))
  const bundle = assets.find((name) => /^index-.*\.js$/.test(name))
  const engine = assets.find((name) => /^engine\.worker-.*\.js$/.test(name))
  expect(bundle).toBeDefined()
  expect(engine).toBeDefined()
  const serviceWorker = readFileSync(join(outDir, "sw.js"), "utf8")
  expect(serviceWorker).toContain(`assets/${bundle}`)
  expect(serviceWorker).toContain(`assets/${engine}`)
  // A newly installed worker must take control of already-open tabs. The registration module in the app bundle
  // observes activation and reloads them; a bare registerSW.js leaves the old bundle active after a normal reload.
  expect(serviceWorker).toContain("self.skipWaiting()")
  expect(serviceWorker).toContain("clientsClaim()")
  expect(readdirSync(outDir)).not.toContain("registerSW.js")
  // The docs site's paths, which share the app's hostname, are left to the network: by the shell's fallback for a
  // navigation and by its cache (src/pwa.ts DOCS_SITE).
  expect(serviceWorker.split(DOCS_SITE.source).length - 1).toBe(2)
  // The deployment's longest command is written in where the run tool reads it (src/features/sandbox/flows.ts): no
  // bundle reads it at run time, where a browser has no deployment setting.
  for (const asset of assets.filter((name) => name.endsWith(".js"))) {
    expect(readFileSync(join(outDir, "assets", asset), "utf8"), asset).not.toContain("__SANDBOX_COMMAND_MAX_SECONDS__")
  }
}, 180_000)
