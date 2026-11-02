import { build } from "esbuild"
import { createServer, type Server } from "node:http"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { afterAll, beforeAll, expect, test } from "vitest"

let server: Server
let browser: Browser
let origin: string
beforeAll(async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("./fixtures/chrome-chat.tsx", import.meta.url))],
    bundle: true, write: false, outdir: "out", format: "esm", platform: "browser", target: "es2022",
    jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
  })
  const css = (await Promise.all(["../src/screens/app/app-shell.css", "../src/features/pins/pins.css"].map(path => readFile(new URL(path, import.meta.url), "utf8")))).join("\n")
  server = createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/fixture.js" ? "text/javascript" : "text/html")
    response.end(request.url === "/fixture.js" ? bundle.outputFiles.find(file => file.path.endsWith(".js"))?.text ?? bundle.outputFiles[0]!.text
      : `<!doctype html><style>body{margin:0}*{box-sizing:border-box}${css}</style><div id="app"></div><script type="module" src="/fixture.js"></script>`)
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("No test server address")
  origin = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ headless: true })
}, 60_000)
afterAll(async () => {
  await browser?.close()
  await new Promise<void>(resolve => server?.close(() => resolve()))
})

for (const entries of [120, 1200]) for (const width of [390, 1180, 1280]) test(`${width}, ${entries} entries: timeline labels read inside the rail and pins stay above the transcript`, async () => {
  const page = await browser.newPage({ viewport: { width, height: 844 } })
  try {
    await page.goto(`${origin}?entries=${entries}`)
    await page.locator(".mvp-pinned-message").waitFor()
    if (width === 390) await page.getByText("Timeline", { exact: true }).click()
    await page.locator(".sui-chat-timeline button").first().waitFor()
    // FE-16/FE-19/FE-22: entry labels may sit away from their short marks,
    // and phase titles wrap. Measure the words the rail actually shows.
    await page.waitForFunction(() => [...document.querySelectorAll(".sui-tl-clip")].every(clip => clip.hasAttribute("data-window-end")))
    await page.locator(".sui-chat-timeline").evaluate(async rail => {
      // The rail animates columns after its first real size measurement.
      await Promise.all(rail.getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished))
    })
    expect((await page.locator(".sui-chat-timeline").boundingBox())!.width).toBeGreaterThan(0)
    const reading = await page.locator(".sui-chat-timeline").evaluate(rail => {
      const inside = (rect: DOMRect, box: DOMRect) => rect.left >= box.left - .5 && rect.right <= box.right + .5 && rect.top >= box.top - .5 && rect.bottom <= box.bottom + .5
      const faults: string[] = []
      let visible = 0
      for (const span of rail.querySelectorAll<HTMLElement>("button > .sui-tl-tx")) {
        const style = getComputedStyle(span), box = span.getBoundingClientRect()
        const clip = span.closest(".sui-tl-clip")!.getBoundingClientRect()
        if (style.visibility === "hidden" || style.display === "none" || box.bottom <= clip.top || box.top >= clip.bottom) continue
        visible++
        const title = span.textContent ?? ""
        if (!inside(box, rail.getBoundingClientRect()) || !inside(box, clip)) faults.push(`outside rail window: ${title}`)
        const text = span.firstChild!
        const words = [...title.matchAll(/\S+/g)].map(match => {
          const range = document.createRange()
          range.setStart(text, match.index); range.setEnd(text, match.index + match[0].length)
          return [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0)
        })
        const shown = words.filter(rects => rects.length > 0 && rects.every(rect => inside(rect, box) && inside(rect, clip)))
        if (span.closest("ol")!.dataset.level === "0") {
          const missing = words.findIndex(rects => rects.length === 0 || !rects.every(rect => inside(rect, box) && inside(rect, clip)))
          const leading = missing === -1 ? words.length : missing
          if (leading < Math.min(4, words.length)) faults.push(`entry shows only ${leading} leading words: ${title}`)
        } else {
          if (style.hyphens === "auto") faults.push(`hyphenated phase: ${title}`)
          const lines = new Set(shown.flatMap(rects => rects.map(rect => Math.round(rect.top)))).size
          const room = Math.min(span.closest("button")!.getBoundingClientRect().height, clip.bottom - box.top)
          if (shown.length === 0 || (shown.length < words.length && (lines + 1) * parseFloat(style.lineHeight) <= room + .5)) faults.push(`phase cut with room to read: ${title}`)
        }
      }
      return { visible, faults }
    })
    expect(reading.visible).toBeGreaterThan(0)
    expect(reading.faults, JSON.stringify(reading)).toEqual([])
    const columns = await page.locator(".sui-chat-timeline ol").evaluateAll(elements => elements.map(element => element.getAttribute("aria-label")))
    expect(columns).toEqual(["Messages", "Phases", "Arcs"].slice(0, columns.length))
    {
      const transcript = (await page.locator(".sui-chat-transcript").boundingBox())!
      const rail = (await page.locator(".sui-chat-timeline").boundingBox())!
      for (const column of await page.locator(".sui-chat-timeline ol").all()) {
        const button = column.locator("button").first()
        await button.focus()
        const preview = page.getByRole("tooltip")
        await preview.waitFor({ state: "visible" })
        expect(await preview.locator("strong").textContent()).toBe(await button.locator(".sui-tl-tx").textContent())
        const box = (await preview.boundingBox())!
        expect(box.x).toBeGreaterThanOrEqual(0)
        expect(box.x + box.width).toBeLessThanOrEqual(width >= 1180 ? transcript.x : width)
        expect(box.x + box.width).toBeLessThanOrEqual(rail.x + rail.width)
      }
    }
    const pin = (await page.locator(".mvp-pinned-message").boundingBox())!
    const transcript = (await page.locator(".sui-chat-transcript").boundingBox())!
    expect(pin.y + pin.height).toBeLessThanOrEqual(transcript.y)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
  } finally { await page.close() }
})
