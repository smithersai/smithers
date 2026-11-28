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
    entryPoints: [fileURLToPath(new URL("./fixtures/repo-flow-branch.tsx", import.meta.url))],
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

test("the first native click after editing Branch reaches Run", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(origin)
    const branch = page.getByLabel("Branch", { exact: true })
    await branch.fill("stack/audit-evidence-repair")
    await page.getByRole("button", { name: "Run", exact: true }).click()
    await page.locator('.repo-flows[aria-busy="true"]').waitFor()
    expect(await page.locator("output").textContent()).toBe("read stack/audit-evidence-repair")
    await page.evaluate(() => (window as unknown as { releaseInputs: () => void }).releaseInputs())
    await page.waitForFunction(() => document.querySelector("output")?.textContent?.includes("run "))
    expect(await page.locator("output").textContent()).toBe("read stack/audit-evidence-repair\nrun stack/audit-evidence-repair")
  } finally { await page.close() }
})

test("Enter loads the edited branch without starting it", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(origin)
    const branch = page.getByLabel("Branch", { exact: true })
    await branch.fill("next")
    await branch.press("Enter")
    await page.locator('.repo-flows[aria-busy="true"]').waitFor()
    await page.evaluate(() => (window as unknown as { releaseInputs: () => void }).releaseInputs())
    await page.locator('.repo-flows[aria-busy="false"]').waitFor()
    expect(await page.locator("output").textContent()).toBe("read next")
  } finally { await page.close() }
})
