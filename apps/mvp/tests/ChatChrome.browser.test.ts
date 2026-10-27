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

for (const entries of [120, 1200]) for (const width of [390, 1180, 1280]) test(`${width}, ${entries} entries: timeline labels stay inside their boxes and pins stay above the transcript`, async () => {
  const page = await browser.newPage({ viewport: { width, height: 844 } })
  try {
    await page.goto(`${origin}?entries=${entries}`)
    await page.locator(".mvp-pinned-message").waitFor()
    if (width === 390) await page.getByText("Timeline", { exact: true }).click()
    await page.locator(".sui-chat-timeline button").first().waitFor()
    const labels = await page.locator(".sui-chat-timeline button > span").evaluateAll(elements => elements.map(element => ({
      whiteSpace: getComputedStyle(element).whiteSpace,
      overflow: getComputedStyle(element).overflow,
      bottom: element.getBoundingClientRect().bottom,
      parentBottom: element.parentElement!.getBoundingClientRect().bottom,
    })))
    expect(labels.length).toBeGreaterThan(0)
    for (const label of labels) {
      expect.soft(label.whiteSpace).toBe("nowrap")
      expect.soft(label.overflow).toBe("hidden")
      expect.soft(label.bottom).toBeLessThanOrEqual(label.parentBottom)
    }
    const columns = await page.locator(".sui-chat-timeline ol").evaluateAll(elements => elements.map(element => getComputedStyle(element, "::before").content))
    expect(columns.every(label => label.includes("Zoom level"))).toBe(true)
    {
      const transcript = (await page.locator(".sui-chat-transcript").boundingBox())!
      for (const column of await page.locator(".sui-chat-timeline ol").all()) {
        const button = column.locator("button").first()
        await button.focus()
        const preview = column.locator("li").first().locator(".sui-timeline-preview")
        const box = (await preview.boundingBox())!
        expect(box.x).toBeGreaterThanOrEqual(0)
        expect(box.x + box.width).toBeLessThanOrEqual(width >= 1180 ? transcript.x : width)
      }
    }
    const pin = (await page.locator(".mvp-pinned-message").boundingBox())!
    const transcript = (await page.locator(".sui-chat-transcript").boundingBox())!
    expect(pin.y + pin.height).toBeLessThanOrEqual(transcript.y)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
  } finally { await page.close() }
})
