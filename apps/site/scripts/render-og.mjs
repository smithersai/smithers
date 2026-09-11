/**
 * Renders public/media/og.png, the 1200x630 social card that Base.astro
 * references from og:image and twitter:image. The card uses the site's dark
 * palette from src/styles/site.css so it reads as the same brand as the page.
 * Playwright's Chromium comes from apps/app's own dependency, as record-ui.mjs.
 *
 * Usage: node scripts/render-og.mjs
 */
import { createRequire } from "node:module"
import { readFileSync, statSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"

const here = fileURLToPath(new URL(".", import.meta.url))
const root = resolve(here, "../../..")
const uiRequire = createRequire(resolve(root, "apps/app/package.json"))
const { chromium } = uiRequire("@playwright/test")

const OUT = resolve(here, "../public/media/og.png")
const SIZE = { width: 1200, height: 630 }
const MAX_BYTES = 300 * 1024
const icon = readFileSync(resolve(here, "../public/icon.png")).toString("base64")

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@500;600;700&family=IBM+Plex+Mono:wght@500&display=swap" />
<style>
  html, body { margin: 0; width: ${SIZE.width}px; height: ${SIZE.height}px; }
  body {
    background: #011627;
    color: #d6deeb;
    font-family: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 72px 84px;
    box-sizing: border-box;
  }
  .mark { display: flex; align-items: center; gap: 20px; font-size: 40px; font-weight: 600; letter-spacing: -0.01em; }
  .mark img { width: 56px; height: 56px; border-radius: 14px; }
  h1 { margin: 0; font-size: 104px; line-height: 1.02; letter-spacing: -0.035em; font-weight: 700; }
  h1 em { font-style: normal; color: #c792ea; }
  .domain { font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 34px; font-weight: 500; color: #8badc1; }
</style>
</head>
<body>
  <div class="mark"><img src="data:image/png;base64,${icon}" alt="" /> Smithers</div>
  <h1><em>Smithers</em> your repo</h1>
  <div class="domain">smithers.sh</div>
</body>
</html>`

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: SIZE, deviceScaleFactor: 1 })
  await page.setContent(html, { waitUntil: "load" })
  // The webfont is a nicety; render with the fallback stack when offline.
  await Promise.race([page.evaluate(() => document.fonts.ready), new Promise((r) => setTimeout(r, 3000))])
  await page.screenshot({ path: OUT, type: "png", clip: { x: 0, y: 0, ...SIZE } })
} finally {
  await browser.close()
}
const bytes = statSync(OUT).size
if (bytes > MAX_BYTES) throw new Error(`${OUT} is ${bytes} bytes, above the ${MAX_BYTES} byte budget`)
console.log(`render-og: wrote ${OUT} (${SIZE.width}x${SIZE.height}, ${bytes} bytes)`)
