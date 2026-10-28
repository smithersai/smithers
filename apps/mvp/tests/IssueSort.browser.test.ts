import { build } from "esbuild"
import { readFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { fileURLToPath } from "node:url"
import { chromium, webkit, type Browser } from "playwright"
import { afterAll, beforeAll, expect, test } from "vitest"

let server: Server
let origin: string
const browsers: Browser[] = []
beforeAll(async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL("./fixtures/issue-sort.tsx", import.meta.url))], bundle: true, write: false, format: "esm", platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } })
  const css = await readFile(new URL("../src/screens/issues/issues-screen.css", import.meta.url), "utf8")
  server = createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/fixture.js" ? "text/javascript" : "text/html")
    response.end(request.url === "/fixture.js" ? bundle.outputFiles[0]!.text : `<!doctype html><style>*{box-sizing:border-box}body{margin:0}${css}</style><div id="app"></div><script type="module" src="/fixture.js"></script>`)
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`
  browsers.push(await chromium.launch())
  browsers.push(await webkit.launch())
})
afterAll(async () => {
  await Promise.all(browsers.map(browser => browser.close()))
  await new Promise<void>(resolve => server.close(() => resolve()))
})

for (const engine of ["chromium", "webkit"]) for (const width of [320, 390, 768, 960, 961, 1280]) test(`${engine} ${width}: native Sort is reachable at the house height and sorts`, async () => {
  const page = await browsers[engine === "chromium" ? 0 : 1]!.newPage({ viewport: { width, height: 800 } })
  try {
    await page.goto(origin)
    const sort = page.getByRole("combobox", { name: "Sort", exact: true })
    await sort.waitFor()
    const bounds = (await sort.boundingBox())!
    expect(bounds.height).toBeGreaterThanOrEqual(32)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
    expect(await sort.evaluate(element => { const b = element.getBoundingClientRect(); return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) === element })).toBe(true)
    await sort.selectOption("oldest")
    expect(await page.locator("html").getAttribute("data-sort")).toBe("oldest")
    // Honor the theme's control-height setting rather than fixing one browser's pixel size.
    await page.locator("html").evaluate(element => (element as HTMLElement).style.setProperty("--ctl-h", "40px"))
    expect((await sort.boundingBox())!.height).toBeGreaterThanOrEqual(40)
  } finally { await page.close() }
})
