import { build } from "esbuild"
import { createServer, type Server } from "node:http"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { afterAll, beforeAll, expect, test } from "vitest"
import vibelang from "vibelang-unplugin/esbuild"

let server: Server
let browser: Browser
let origin: string
beforeAll(async () => {
  const bundle = await build({ plugins: [vibelang()],
    entryPoints: [fileURLToPath(new URL("./fixtures/file-tabs.tsx", import.meta.url))],
    bundle: true, write: false, format: "iife", platform: "browser", target: "es2022",
    jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
  })
  server = createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/fixture.js" ? "text/javascript" : "text/html")
    response.end(request.url === "/fixture.js" ? bundle.outputFiles[0]!.text
      : '<!doctype html><div id="app"></div><script src="/fixture.js"></script>')
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("No test server address")
  origin = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ headless: true })
})
afterAll(async () => {
  await browser?.close()
  await new Promise<void>((resolve) => server?.close(() => resolve()))
})

test.each(["tab", "outside-before-pending", "outside-during-pending", "removed-during-pending"] as const)(
  "slow file-close navigation preserves keyboard ownership: %s", async (focus) => {
    const page = await browser.newPage()
    page.setDefaultTimeout(5_000)
    const errors: Array<string> = []
    page.on("pageerror", (error) => errors.push(error.message))
    try {
      await page.goto(origin)
      const readme = page.getByRole("tab", { name: "README.md" })
      const index = page.getByRole("tab", { name: "index.html" })
      await readme.focus()
      await page.keyboard.press("Delete")
      await index.waitFor({ state: "visible" })
      if (focus === "outside-before-pending") await page.locator("#outside").focus()
      await page.locator("#pending").waitFor({ state: "visible" })
      if (focus === "tab") expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true)
      if (focus === "outside-during-pending") await page.locator("#outside").focus()
      if (focus === "removed-during-pending") {
        await page.evaluate(() => (window as unknown as { closeRemaining: () => void }).closeRemaining())
      }
      await page.evaluate(() => (window as unknown as { releaseNavigation: () => void }).releaseNavigation())
      await page.locator("#pending").waitFor({ state: "hidden" })
      expect(errors).toEqual([])
      if (focus === "removed-during-pending") {
        expect(await page.getByRole("tab").count()).toBe(0)
        expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true)
        return
      }
      await index.waitFor({ state: "visible" })
      expect(await page.getByRole("tab").allTextContents()).toEqual(["index.html"])
      expect(await index.getAttribute("aria-selected")).toBe("true")
      expect(await index.getAttribute("href")).toBe("/index.html?L=2-4")
      const expected = focus === "tab" ? index : page.locator("#outside")
      expect(await expected.evaluate((element) => element === document.activeElement)).toBe(true)
    } finally {
      await page.close()
    }
  },
)
