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
    entryPoints: [fileURLToPath(new URL("./fixtures/mobile-layout.tsx", import.meta.url))],
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
    jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
  })
  const backCss = await readFile(new URL("../src/features/views/components/back-to-chat.css", import.meta.url), "utf8")
  const css = backCss + (await Promise.all(["conversations/conversations-screen", "repo/repo-screen", "root/root", "branch/branch-screen", "issues/issues-screen", "pulls/pulls-screen", "stack/stack-screen"].map((name) =>
    readFile(new URL(`../src/screens/${name}.css`, import.meta.url), "utf8")))).join("\n")
  server = createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/fixture.js" ? "text/javascript" : "text/html")
    response.end(request.url === "/fixture.js" ? bundle.outputFiles[0]!.text
      : `<!doctype html><style>body{margin:0;font:14px Arial,sans-serif}*{box-sizing:border-box}${css}</style><div id="app"></div><script type="module" src="/fixture.js"></script>`)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("No test server address")
  origin = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ headless: true })
}, 60_000)
afterAll(async () => {
  await browser?.close()
  await new Promise<void>((resolve) => server?.close(() => resolve()))
})

for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1280, height: 800 }]) {
  for (const file of ["README.md", "index.html"]) test(`${viewport.width}: ${file} has reachable controls and unclipped content`, async () => {
    const page = await browser.newPage({ viewport })
    page.setDefaultTimeout(5_000)
    try {
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      await page.goto(`${origin}?file=${file}`)
      if (file === "README.md") await page.locator(".ProseMirror").waitFor()
      else await page.locator("iframe").waitFor()
      const controls = page.locator('#files button, .sui-item-conv-external')
      expect(await controls.count()).toBeGreaterThan(4)
      const defects: string[] = []
      for (const control of await controls.all()) {
        if (!await control.isVisible()) continue
        const size = await control.boundingBox()
        if (viewport.width <= 960 && size && (size.height < 32 || size.width < 32)) defects.push(`${await control.getAttribute("aria-label") ?? await control.textContent()}: ${size.width}×${size.height}`)
      }
      expect(errors).toEqual([])
      expect.soft(defects).toEqual([])
      const article = page.getByRole("article", { name: file, exact: true })
      const bounds = await article.evaluate((element) => ({ client: element.clientHeight, scroll: element.scrollHeight }))
      expect(bounds.scroll).toBeLessThanOrEqual(bounds.client + 1)
      // Scrolling the editor to a link must leave the toolbar above the editor,
      // rather than scrolling it behind the article's overflow:hidden boundary.
      if (file === "README.md") {
        await page.getByRole("link", { name: "Read the guide" }).scrollIntoViewIfNeeded()
        expect(await article.evaluate((element) => {
          const toolbar = element.querySelector("header")!.getBoundingClientRect()
          return toolbar.top >= element.getBoundingClientRect().top
        })).toBe(true)
      }
    } finally { await page.close() }
  })
  test(`${viewport.width}: back, sign-in, notification and release targets meet the control height`, async () => {
    const page = await browser.newPage({ viewport })
    try {
      await page.goto(origin)
      const controls = page.locator("#tap-controls a, #tap-controls button")
      await controls.first().waitFor()
      expect(await controls.count()).toBeGreaterThanOrEqual(5)
      for (const control of await controls.all()) {
        const box = (await control.boundingBox())!
        expect.soft(box.height, await control.textContent() ?? "bell").toBeGreaterThanOrEqual(32)
        expect.soft(box.width).toBeGreaterThanOrEqual(32)
      }
    } finally { await page.close() }
  })
  test(`${viewport.width}: repository hero and install command do not widen the page`, async () => {
    const page = await browser.newPage({ viewport })
    try {
      await page.goto(origin)
      await page.locator(".sui-rh-install").waitFor()
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width)
      const install = page.locator(".sui-rh-install code")
      expect(await install.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(await install.evaluate((element) => element.clientWidth))
      const source = page.locator(".sui-rh-code-body")
      expect(await source.evaluate((element) => element.scrollWidth)).toBeGreaterThan(await source.evaluate((element) => element.clientWidth))
      await source.evaluate((element) => { element.scrollLeft = element.scrollWidth })
      expect(await source.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
      const copy = page.locator(".sui-rh-install button")
      const box = (await copy.boundingBox())!
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
      if (viewport.width <= 960) expect(box.height).toBeGreaterThanOrEqual(32)
    } finally { await page.close() }
  })
  test(`${viewport.width}: issue TODO links and TODO Watch links are reachable`, async () => {
    const page = await browser.newPage({ viewport })
    try {
      await page.goto(origin)
      const links = page.locator(".sui-item-aside-link")
      await links.first().waitFor()
      expect(await links.allTextContents()).toEqual(["T5", "T4", "Watch", "smithers/t13-mobile-layout-84a0f279-c5d2-4f47-bf1f-2d-9f58a66879c3"])
      for (const link of await links.all()) {
        await link.scrollIntoViewIfNeeded()
        const box = (await link.boundingBox())!
        if (viewport.width <= 960) {
          expect.soft(box.width).toBeGreaterThanOrEqual(32)
          expect.soft(box.height).toBeGreaterThanOrEqual(32)
        }
        expect(box.x).toBeGreaterThanOrEqual(0)
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
        expect(await link.evaluate((element) => {
          const box = element.getBoundingClientRect()
          return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
        })).toBe(true)
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width)
    } finally { await page.close() }
  })
  test(`${viewport.width}: conversation branch and repository labels remain readable`, async () => {
    const page = await browser.newPage({ viewport })
    page.setDefaultTimeout(5_000)
    try {
      await page.goto(origin)
      await page.locator(".conversation-list-branch").first().waitFor()
      const labels = await page.locator('.conversation-list-row a span').evaluateAll((elements) => elements.map((element) => ({ text: element.textContent, client: element.clientWidth, scroll: element.scrollWidth })))
      expect(labels).toHaveLength(4)
      expect(labels.filter((label) => label.scroll > label.client + 1)).toEqual([])
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width)
    } finally { await page.close() }
  })
}

test("a completed GitHub sync cannot show an empty pull list while the device is hydrating", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(`${origin}?list=pending`)
    await page.locator("#pulls [data-slot=issues-view]").waitFor()
    expect(await page.locator("#pulls [aria-busy=true]").count()).toBe(0)
    expect(await page.locator("#pulls").textContent()).not.toContain("No pull requests")
    await page.goto(`${origin}?list=empty`)
    await page.getByText("No pull requests", { exact: true }).waitFor()
  } finally { await page.close() }
})

for (const width of [390, 768, 1280]) {
  for (const screen of ["pulls", "stack", "branch", "issues"]) test(`${width}: ${screen} targets are unobstructed inside their scrollport`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 800 } })
    try {
      await page.goto(`${origin}?screen=${screen}`)
      const controls = page.locator("a, button")
      await controls.first().waitFor()
      for (const control of await controls.all()) {
        await control.scrollIntoViewIfNeeded()
        const result = await control.evaluate((element) => {
          const box = element.getBoundingClientRect()
          const points = [[box.left + 4, box.top + box.height / 2], [box.right - 4, box.top + box.height / 2], [box.left + box.width / 2, box.top + 4], [box.left + box.width / 2, box.bottom - 4]]
          let clipped = false
          for (let parent = element.parentElement; parent; parent = parent.parentElement) {
            const style = getComputedStyle(parent)
            const bounds = parent.getBoundingClientRect()
            if (["auto", "hidden", "scroll"].includes(style.overflowY) && (box.top < bounds.top || box.bottom > bounds.bottom)) clipped = true
          }
          return { height: box.height, width: box.width, clipped, covered: points.some(([x, y]) => !element.contains(document.elementFromPoint(x!, y!))) }
        })
        expect.soft(result, await control.textContent() ?? "bell").toMatchObject({ clipped: false, covered: false })
        if (width <= 960) {
          expect.soft(result.height).toBeGreaterThanOrEqual(32)
          expect.soft(result.width).toBeGreaterThanOrEqual(32)
        }
      }
    } finally { await page.close() }
  })
}
