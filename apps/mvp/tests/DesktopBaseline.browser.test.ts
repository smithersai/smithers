import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import { chromium, errors, type Browser, type Page, type Locator, type TestInfo } from "@playwright/test"
import { afterAll, beforeAll, expect, test } from "vitest"
import { captureHeight, captureTimeout, CaptureDeadline, comparisonFailure, desktopBaseline } from "../e2e/mobile-baseline"

let browser: Browser
beforeAll(async () => { browser = await chromium.launch({ headless: true }) })
afterAll(async () => { await browser.close() })

const fixture = async (body: string, use: (page: Page, directory: string, info: TestInfo) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "desktop-capture-"))
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  try {
    await page.setContent(`<!doctype html><style>body{margin:0;font:14px Arial}*{box-sizing:border-box}@media(max-width:960px){.app-shell-header { flex-wrap: wrap; }}</style>${body}`, { waitUntil: "domcontentloaded" })
    await use(page, directory, { outputPath: (file: string) => join(directory, file) } as TestInfo)
  } finally { await page.close(); await rm(directory, { recursive: true, force: true }) }
}

const withFontGate = async (use: (url: string, release: () => void) => Promise<void>) => {
  const font = await readFile(new URL("../node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2", import.meta.url))
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const server = createServer(async (_request, response) => {
    await gate
    response.writeHead(200, { "content-type": "font/woff2", "access-control-allow-origin": "*" })
    response.end(font)
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as import("node:net").AddressInfo).port
  try { await use(`http://127.0.0.1:${port}/font.woff2`, release) }
  finally { release(); await new Promise<void>(resolve => server.close(() => resolve())) }
}

const elementPixels = async (page: Page, element: Locator, actual: Buffer, origin: { x: number; y: number }) => {
  const bounds = await element.evaluate(el => { const box = el.getBoundingClientRect(); return { x: box.x + scrollX, y: box.y + scrollY } })
  const reference = await element.screenshot()
  return page.evaluate(async ({ actual, reference, x, y }) => {
    const load = async (data: string) => { const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode(); return image }
    const [tile, expected] = await Promise.all([load(actual), load(reference)])
    const canvas = document.createElement("canvas")
    canvas.width = expected.width; canvas.height = expected.height
    const context = canvas.getContext("2d")!
    context.drawImage(tile, -x, -y)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.drawImage(expected, 0, 0)
    const result = context.getImageData(0, 0, canvas.width, canvas.height).data
    const differences = [...result].flatMap((value, index) => value === pixels[index] ? [] : [{ index, actual: pixels[index], expected: value }])
    return { count: differences.length, first: differences.slice(0, 8), width: expected.width, height: expected.height }
  }, { actual: actual.toString("base64"), reference: reference.toString("base64"), x: bounds.x - origin.x, y: bounds.y - origin.y })
}

test("the desktop comparison captures every row in bounded PNGs on a 254435px document", async () => {
  await fixture(`<main style="height:254435px;background:repeating-linear-gradient(#fff 0 31px,#ddd 31px 32px)">Start<span style="position:absolute;left:0;top:103640px;width:300px;height:20px;line-height:20px">The omitted stripe must be captured</span><span style="position:absolute;left:0;top:254410px;width:300px;height:20px;line-height:20px">Last row</span></main>`, async (page, directory, info) => {
    await desktopBaseline(page, info, "screen", true)
    const pngs = (await readdir(directory)).filter(name => name.endsWith(".png"))
    for (const name of pngs) {
      const png = await readFile(join(directory, name))
      expect(png.readUInt32BE(16)).toBe(1280)
      expect(png.readUInt32BE(20), `${name} must fit the bounded capture`).toBeLessThanOrEqual(8192)
    }
    expect(pngs.length).toBeGreaterThan(2)
    const receipt = JSON.parse(await readFile(join(directory, "screen-tiles.json"), "utf8")) as { width: number; height: number; durationMs: number; tiles: Array<{ x: number; y: number; width: number; height: number }> }
    expect(receipt.width).toBe(1280)
    expect(receipt.height).toBe(254435)
    expect(receipt).toMatchObject({ capturedCurrent: 32, capturedBaseline: 32, compared: 32 })
    expect(receipt.durationMs).toBeGreaterThan(0)
    let covered = 0
    for (const tile of receipt.tiles) {
      expect(tile).toEqual({ x: 0, y: covered, width: 1280, height: Math.min(8192, 254435 - covered) })
      covered += tile.height
    }
    expect(covered).toBe(254435)
    // Read the retained images through the browser's real PNG decoder. A manifest
    // alone cannot prove the raster contains every line, including the last tile.
    for (const tile of receipt.tiles) {
      const png = await readFile(join(directory, `screen-${tile.x}-${tile.y}.png`))
      const wrong = await page.evaluate(async ({ data, top }) => {
        const image = new Image()
        image.src = `data:image/png;base64,${data}`
        await image.decode()
        const canvas = document.createElement("canvas")
        canvas.width = image.width; canvas.height = image.height
        const context = canvas.getContext("2d")!
        context.drawImage(image, 0, 0)
        const pixels = context.getImageData(1000, 0, 1, image.height).data
        return Array.from({ length: image.height }, (_, y) => y).filter(y => pixels[y * 4] !== ((top + y) % 32 === 31 ? 221 : 255))
      }, { data: png.toString("base64"), top: tile.y })
      expect(wrong, `every scanline of tile ${tile.y} must contain the real document`).toEqual([])
    }
    expect(await page.evaluate(() => [scrollX, scrollY])).toEqual([0, 0])
    for (const marker of ["The omitted stripe must be captured", "Last row"]) {
      const element = page.getByText(marker, { exact: true })
      const top = await element.evaluate(el => el.getBoundingClientRect().y + scrollY)
      const tile = receipt.tiles.find(tile => tile.y <= top && tile.y + tile.height > top)!
      const actual = await readFile(join(directory, `screen-${tile.x}-${tile.y}.png`))
      const equal = await elementPixels(page, element, actual, tile)
      expect(equal, `${marker} must paint identically to its visible viewport capture`).toMatchObject({ count: 0 })
    }
  })
}, 180_000)

test("a desktop pixel change deep in the document fails exact comparison and restores CSS", async () => {
  await fixture(`<main style="height:12000px"><style>.app-shell-header { flex-wrap: wrap; }</style><div class="app-shell-header" style="position:absolute;top:8500px;width:100px;display:flex"><span style="flex:none;width:80px">One</span><span style="flex:none;width:80px">Two</span></div></main>`, async (page, _directory, info) => {
    await expect(desktopBaseline(page, info, "changed", true)).rejects.toThrow("mobile CSS must not change any desktop pixels")
    expect(await page.locator(".app-shell-header").evaluate(el => getComputedStyle(el).flexWrap)).toBe("wrap")
    expect(await page.evaluate(() => [scrollX, scrollY])).toEqual([0, 0])
  })
})

test("the stable-window comparison remains available for pages without an applied snapshot", async () => {
  await fixture("<main>Settled page</main>", async (page, _directory, info) => {
    await desktopBaseline(page, info, "small")
    expect(await page.locator("main").innerText()).toBe("Settled page")
  })
})

test("full-width clips capture horizontal overflow and restore the original scroll position", async () => {
  await fixture('<main style="width:1400px;height:8300px;background:#ddd">Wide page<div id="overflow" class="app-shell-header" style="position:absolute;left:1280px;top:8260px;width:80px;height:20px;line-height:20px;display:flex"><span style="flex:none;width:50px">Right</span><span style="flex:none;width:50px">edge</span></div></main>', async (page, directory, info) => {
    await page.evaluate(() => window.scrollTo(50, 20))
    await desktopBaseline(page, info, "wide", true)
    const receipt = JSON.parse(await readFile(join(directory, "wide-tiles.json"), "utf8"))
    expect(receipt.tiles).toEqual([
      { x: 0, y: 0, width: 1400, height: 8192 },
      { x: 0, y: 8192, width: 1400, height: 108 },
    ])
    expect(await page.evaluate(() => [scrollX, scrollY])).toEqual([50, 20])
    const png = await readFile(join(directory, "wide-0-8192.png"))
    expect(png.readUInt32BE(16)).toBe(1400)
    expect(await elementPixels(page, page.locator("#overflow"), png, { x: 0, y: 8192 })).toMatchObject({ count: 0 })
  })
})

test("a settled page changing its content remains a failure", async () => {
  await fixture('<main style="height:10000px"><span id="status" style="position:absolute;top:9900px">Before</span></main>', async (page, _directory, info) => {
    await page.evaluate(() => {
      let count = 0
      const change = () => { document.querySelector("#status")!.textContent = `Update ${++count}`; requestAnimationFrame(change) }
      requestAnimationFrame(change)
    })
    await expect(desktopBaseline(page, info, "content", true)).rejects.toThrow(/mobile CSS must not change any desktop pixels|content must remain stable across the CSS comparison/)
    expect(await page.evaluate(() => [scrollX, scrollY])).toEqual([0, 0])
  })
})

test("changing the document's extent in the baseline remains a failure", async () => {
  await fixture('<style>.app-shell-header{height:900px}.app-shell-header { flex-wrap: wrap; }.app-shell-header:has(>span){display:flex}.app-shell-header>span{width:80px;flex:none}</style><main class="app-shell-header" style="width:100px;height:auto"><span style="height:450px">One</span><span style="height:450px">Two</span></main>', async (page, _directory, info) => {
    await expect(desktopBaseline(page, info, "extent", true)).rejects.toThrow("document dimensions must remain stable")
    expect(await page.locator(".app-shell-header").evaluate(el => getComputedStyle(el).flexWrap)).toBe("wrap")
  })
})

test("a comparison without an indexed mobile rule cannot certify the baseline", async () => {
  await fixture('<main>Missing rule</main>', async (page, _directory, info) => {
    await page.locator("style").evaluate(el => el.remove())
    await expect(desktopBaseline(page, info, "missing", true)).rejects.toThrow("baseline must remove the sweep's actual CSS rules")
  })
})

test("only Chromium splits the huge document raster", () => {
  expect(captureHeight("chromium", 254435)).toBe(8192)
  expect(captureHeight("webkit", 254435)).toBe(254435)
})

test("fixed overlays cannot hide a CSS defect at a clip boundary", async () => {
  await fixture('<main style="height:10000px"><div style="position:fixed;inset:0 0 auto;height:200px;background:white;z-index:2">Fixed header</div><style>.app-shell-header { flex-wrap: wrap; }</style><div class="app-shell-header" style="position:absolute;top:8192px;width:100px;display:flex"><span style="flex:none;width:80px">One</span><span style="flex:none;width:80px">Two</span></div></main>', async (page, _directory, info) => {
    await expect(desktopBaseline(page, info, "fixed", true)).rejects.toThrow("mobile CSS must not change any desktop pixels")
    expect(await page.evaluate(() => scrollY)).toBe(0)
  })
})

test("the stable-window deadline finishes cleanup and prevents late captures", async () => {
  await withFontGate(async (url, release) => {
    await fixture(`<style>@font-face{font-family:Gate;src:url(${url})}body{font-family:Gate}.app-shell-header { flex-wrap: wrap; }</style><main class="app-shell-header" style="height:10000px">Waiting for a real font</main>`, async (page, directory, info) => {
      const started = performance.now()
      await expect(desktopBaseline(page, info, "deadline")).rejects.toThrow(/Timeout|deadline expired/)
      expect(performance.now() - started).toBeLessThan(15_000)
      const files = await readdir(directory)
      expect(await page.locator(".app-shell-header").evaluate(el => getComputedStyle(el).flexWrap)).toBe("wrap")
      release()
      await page.evaluate(() => document.fonts.ready)
      // Give an abandoned screenshot time to resume after the real font arrives.
      await page.evaluate(async () => {
        for (let frame = 0; frame < 60; frame++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      })
      expect(await readdir(directory), "no abandoned callback may produce later captures").toEqual(files)
      expect(await page.locator(".app-shell-header").evaluate(el => getComputedStyle(el).flexWrap)).toBe("wrap")
      expect(await page.evaluate(() => [scrollX, scrollY])).toEqual([0, 0])
    })
  })
}, 30_000)


test("expired capture budgets refuse work without changing the stable-window duration", () => {
  expect(captureTimeout()).toBeUndefined()
  const remaining = captureTimeout(performance.now() + 10_000)!
  expect(remaining).toBeGreaterThan(0)
  expect(remaining).toBeLessThanOrEqual(10_000)
  expect(() => captureTimeout(performance.now() - 1)).toThrow("desktop comparison deadline expired")
})

test("expiry preserves the last substantive comparison failure", () => {
  const pixel = new Error("mobile CSS must not change any desktop pixels")
  const expired = new CaptureDeadline()
  expect(comparisonFailure(expired, pixel)).toBe(pixel)
  expect(comparisonFailure(expired, undefined)).toBe(expired)
  expect(comparisonFailure(pixel, expired)).toBe(pixel)
  const timeout = new errors.TimeoutError("budgeted screenshot timed out")
  expect(comparisonFailure(timeout, pixel)).toBe(pixel)
  expect(comparisonFailure(timeout, undefined)).toBe(timeout)
})

test("the stable-window path reports the actual persistent pixel defect", async () => {
  await fixture('<style>.app-shell-header { flex-wrap: wrap; }</style><main class="app-shell-header" style="width:100px;display:flex"><span style="width:80px;flex:none">One</span><span style="width:80px;flex:none">Two</span></main>', async (page, _directory, info) => {
    await expect(desktopBaseline(page, info, "persistent")).rejects.toThrow("mobile CSS must not change any desktop pixels")
    expect(await page.locator(".app-shell-header").evaluate(el => getComputedStyle(el).flexWrap)).toBe("wrap")
  })
}, 20_000)


test("a pixel mismatch survives a subsequent in-flight font timeout", async () => {
  await withFontGate(async (url, release) => {
    await fixture(`<style>@font-face{font-family:Gate;src:url(${url})}.app-shell-header { flex-wrap: wrap; }</style><main id="mismatch" class="app-shell-header" style="width:100px;display:flex"><span style="width:80px;flex:none">One</span><span style="width:80px;flex:none">Two</span></main>`, async (page, _directory, info) => {
      await page.evaluate(() => {
        let removed = false
        const watch = () => {
          const wrap = getComputedStyle(document.querySelector("#mismatch")!).flexWrap
          if (wrap === "nowrap") removed = true
          else if (removed) { document.body.style.fontFamily = "Gate"; return }
          requestAnimationFrame(watch)
        }
        requestAnimationFrame(watch)
      })
      try {
        await expect(desktopBaseline(page, info, "mismatch-timeout")).rejects.toThrow("mobile CSS must not change any desktop pixels")
        expect(await page.locator("body").evaluate(el => el.style.fontFamily)).toBe("Gate")
      } finally {
        release()
        await page.evaluate(() => document.fonts.ready)
      }
    })
  })
}, 30_000)
