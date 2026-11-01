import { execFileSync } from "node:child_process"
import { chromium } from "playwright"
import { expect, test } from "vitest"
import { isBlank, measure, MEASURE_HEIGHT, MEASURE_WIDTH } from "../e2e/frames"

// The router's sparse unavailable page used to disappear when recording analysis
// reduced a 1280px recording to 320px. Exercise real rasterization and downsampling.
for (const background of ["#f1f5f3", "#111111"]) test(`recording retains sparse unavailable content on ${background}`, async () => {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  try {
    await page.setContent(`<body style="margin:0;background:${background};color:${background === "#111111" ? "#eeeeee" : "#111111"};font:12px Arial"><p style="margin:0">Not Found</p></body>`)
    const sample = async () => {
      const png = await page.screenshot()
      const gray = execFileSync("ffmpeg", ["-v", "error", "-i", "pipe:0", "-vf", `scale=${MEASURE_WIDTH}:${MEASURE_HEIGHT}:flags=area,format=gray`, "-f", "rawvideo", "-"], { input: png })
      return measure(gray, undefined)
    }
    expect(isBlank(await sample())).toBe(false)
    await page.locator("p").evaluate((element) => element.remove())
    expect(isBlank(await sample())).toBe(true)
  } finally {
    await browser.close()
  }
})
