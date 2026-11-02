import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { expect, test } from "vitest"
import { capturesOf, fullPageScreenshot, painted, recordCurrentPicture } from "../e2e/fullPageScreenshot"
import { isBlank, measure, MEASURE_HEIGHT, MEASURE_WIDTH, withoutCaptures, changedBetween, problems } from "../e2e/frames"

// A real recorder catches compositor resizing that innerWidth and resize events
// cannot see. Full-document evidence must preserve the person's recorded window.
test("full-document screenshots keep tall pages stable in their recorded viewport", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobile-recording-"))
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir, size: { width: 1280, height: 800 } } })
  const page = await context.newPage()
  const video = page.video()!
  const startedAt = Date.now()
  try {
    expect(capturesOf(page)).toEqual([])
    await page.setContent(`<body style="margin:0;background:#eee;font:24px Arial"><header style="height:100px;background:#334155;color:white">Repository</header>${Array.from({ length: 40 }, (_, index) => `<div style="height:80px;border-bottom:2px solid #111">Document section ${index}</div>`).join("")}</body>`)
    // The recording starts at its first frame, and Chromium sends one only when
    // it draws: a static page can send none before the first capture. Draw now,
    // so the recording's clock is the test's. Then hold the page for ten sample
    // slots (2 per painted) on each side of evidence collection.
    await recordCurrentPicture(page)
    const hold = async () => { for (let slot = 0; slot < 5; slot++) await painted(page) }
    await hold()
    for (let index = 0; index < 3; index++) {
      if (index === 2) await page.evaluate(() => { document.body.style.background = "#82aaff" })
      const image = await fullPageScreenshot(page, index === 0 ? join(dir, "document.png") : undefined)
      expect(image.readUInt32BE(16)).toBe(1280)
      expect(image.readUInt32BE(20)).toBeGreaterThan(3000)
    }
    await hold()
    const finalPng = await page.screenshot()
    await painted(page)
    await context.close()
    const finalGray = execFileSync("ffmpeg", ["-v", "error", "-i", "pipe:0", "-vf", `scale=${MEASURE_WIDTH}:${MEASURE_HEIGHT}:flags=area,format=gray`, "-f", "rawvideo", "-"], { input: finalPng })
    const raw = execFileSync("ffmpeg", ["-v", "error", "-i", await video.path(), "-vf", `fps=10,scale=${MEASURE_WIDTH}:${MEASURE_HEIGHT}:flags=area,format=gray`, "-f", "rawvideo", "-"], { maxBuffer: 16 * 1024 * 1024 })
    const bytes = MEASURE_WIDTH * MEASURE_HEIGHT
    const frames = Array.from({ length: raw.length / bytes }, (_, index) => raw.subarray(index * bytes, (index + 1) * bytes))
    expect(capturesOf(page)).toHaveLength(3)
    const eligible = withoutCaptures(frames.map((frame, index) => measure(frame, frames[index - 1])), capturesOf(page), startedAt)
    const shown = frames.filter((frame, index) => !isBlank(eligible[index]!) && !isBlank(measure(frame, undefined)))
    expect(shown.length).toBeGreaterThan(3)
    const sample = MEASURE_WIDTH * 120 + MEASURE_WIDTH - 10
    expect(Math.abs(shown.at(-1)![sample]! - finalGray[sample]!)).toBeLessThan(5)
    const inspected = shown.map((frame, index) => ({ ...measure(frame, shown[index - 1]),
      skip: index > 0 && index < shown.length - 1 ? changedBetween(shown[index + 1]!, shown[index - 1]) : 0,
    }))
    expect(problems(inspected, 1).filter((problem) => problem.startsWith("glitched"))).toEqual([])
    const results = join(dir, "results")
    await mkdir(results)
    await writeFile(join(results, "flow.json"), JSON.stringify({
      flow: "tall-document", spec: "mobile-recording", test: "tall-document", title: "Tall document: retains its viewport",
      describe: ["Mobile recording"], summary: "Full-page evidence preserves the recorded window.", status: "passed", startedAt,
      videos: [{ name: "", video: await video.path(), openedAt: 0 }], captures: capturesOf(page),
      marks: [{ start: startedAt, label: "Open document" }, { start: capturesOf(page).at(-1)!.end, label: "Read document" }],
    }))
    const output = execFileSync(process.execPath, [fileURLToPath(new URL("../e2e/gifs.mjs", import.meta.url)), results, join(dir, "gifs"), join(dir, "videos")], { encoding: "utf8", timeout: 30_000 })
    expect(output).toContain("0 fail the check; 0 flows failed to build")
    const edited = execFileSync("ffmpeg", ["-v", "error", "-i", join(dir, "videos/mobile-recording/tall-document.mp4"), "-vf", `fps=10,crop=1280:800:0:0,scale=${MEASURE_WIDTH}:${MEASURE_HEIGHT}:flags=area,format=gray`, "-f", "rawvideo", "-"], { maxBuffer: 16 * 1024 * 1024 })
    // Beyond the title card, the right edge must stay the real page's color.
    // Chromium's temporary tall surface leaves this edge gray in the recording.
    const samples = Array.from({ length: edited.length / bytes }, (_, index) => edited[index * bytes + sample]!).slice(20)
    expect(samples.length).toBeGreaterThan(3)
    expect(Math.min(...samples)).toBeGreaterThan(finalGray[sample]! - 10)
    expect(Math.abs(samples.at(-1)! - finalGray[sample]!)).toBeLessThan(5)
  } finally {
    await browser.close()
    await rm(dir, { recursive: true, force: true })
  }
})

// Chromium's screencast, which Playwright records, sends a frame only when the
// compositor draws. Restoring the viewport after a tall capture draws nothing,
// so without a forced draw the recording keeps the capture's picture (or a
// stale one) until the page next changes. Each capture must end on a recorded
// frame of the restored viewport.
test("a full-page capture ends with the recording on the restored viewport", async () => {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const frames: Array<{ at: number; data: Buffer }> = []
  try {
    await page.screencast.start({ onFrame: ({ timestamp, data }) => { frames.push({ at: timestamp, data }) } })
    await page.setContent(`<body style="margin:0;background:#eee">${Array.from({ length: 40 }, (_, index) => `<div style="height:80px;border-bottom:2px solid #111">${index}</div>`).join("")}</body>`)
    const gray = (image: Buffer) => execFileSync("ffmpeg", ["-v", "error", "-i", "pipe:0", "-vf", `scale=${MEASURE_WIDTH}:${MEASURE_HEIGHT}:flags=area,format=gray`, "-f", "rawvideo", "-"], { input: image })
    const sample = MEASURE_WIDTH * 120 + MEASURE_WIDTH - 10
    const expected: Array<number> = []
    for (const background of ["#eee", "#eee", "#82aaff"]) {
      await page.evaluate((color) => { document.body.style.background = color }, background)
      expected.push(gray(await page.screenshot())[sample]!)
      await fullPageScreenshot(page)
    }
    // The last frame each capture interval sent, at the right edge the tall surface leaves gray; JPEG may shift it.
    const last = capturesOf(page).map(({ start, end }) => frames.filter(({ at }) => at >= start && at <= end).at(-1))
    const seen = last.map((frame) => frame === undefined ? "no frame" : gray(frame.data)[sample]!)
    expect(seen.map((value, index) => typeof value === "number" && Math.abs(value - expected[index]!) < 6), `recorded ${seen.join(", ")}; page ${expected.join(", ")}`).toEqual([true, true, true])
  } finally {
    await browser.close()
  }
})
