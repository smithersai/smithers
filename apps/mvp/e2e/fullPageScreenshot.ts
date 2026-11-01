import type { Page } from "@playwright/test"
import { FPS, type Capture } from "./frames"

/** Await paint acknowledgments spanning two media sample slots. This waits on
 * the renderer's paint clock; a timer alone cannot establish that it painted. */
export const waitForRecordingPaints = (fps: number): Promise<void> => new Promise((resolve) => {
  const from = performance.now()
  const frame = (at: number) => {
    if (at - from >= 2 * 1000 / fps) resolve()
    else requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
})

export const painted = (page: Page): Promise<void> => page.evaluate(waitForRecordingPaints, FPS)

const captures = new WeakMap<Page, Array<Capture>>()

/** Screenshot work is evidence collection, rather than a person's action. Keep
 * its exact interval so the media editor can omit Chromium's temporary resize.
 * Original recordings and full-document PNGs remain unchanged. */
export const fullPageScreenshot = async (
  page: Page,
  path?: string,
  options: Pick<NonNullable<Parameters<Page["screenshot"]>[0]>, "clip" | "timeout"> = {},
): Promise<Buffer> => {
  const intervals = captures.get(page) ?? []
  captures.set(page, intervals)
  const capture = { start: Date.now(), end: Date.now() }
  intervals.push(capture)
  try {
    return await page.screenshot({ ...options, ...(path === undefined ? {} : { path }), fullPage: true, animations: "disabled" })
  } finally {
    // End the tool interval only after the restored viewport has painted.
    await painted(page)
    capture.end = Date.now()
  }
}

export const capturesOf = (page: Page): ReadonlyArray<Capture> => captures.get(page) ?? []
