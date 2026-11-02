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

/** Make the page's video recording receive the page's current picture now. Chromium's screencast, which Playwright
 * records, sends a frame only when the compositor draws; a paint acknowledgment with nothing changed draws nothing.
 * A viewport screenshot always draws, so the recording holds this picture from here until the page next changes.
 * Measured on the Mac mini, 2026-11-01: after a full-page capture restored the viewport, no frame came until the
 * next draw, so the recording kept the tall surface's gray margin past the capture interval. */
export const recordCurrentPicture = async (page: Page, timeout?: number): Promise<void> => {
  await page.screenshot({ caret: "initial", ...(timeout === undefined ? {} : { timeout }) })
}

const captures = new WeakMap<Page, Array<Capture>>()

/** Screenshot work is evidence collection, rather than a person's action. Keep
 * its exact interval so the media editor can omit Chromium's temporary resize.
 * Original recordings and full-document PNGs remain unchanged. */
export const fullPageScreenshot = async (
  page: Page,
  path?: string,
  options: Pick<NonNullable<Parameters<Page["screenshot"]>[0]>, "clip" | "timeout"> = {},
): Promise<Buffer> => {
  // The viewport redraw shares the capture budget; a timed-out font wait must
  // not start a second wait with the original timeout. Zero keeps Playwright’s
  // explicit unbounded semantics.
  const deadline = options.timeout === undefined || options.timeout === 0 ? undefined : performance.now() + options.timeout
  const intervals = captures.get(page) ?? []
  captures.set(page, intervals)
  const capture = { start: Date.now(), end: Date.now() }
  intervals.push(capture)
  try {
    return await page.screenshot({ ...options, ...(path === undefined ? {} : { path }), fullPage: true, animations: "disabled" })
  } finally {
    // End the tool interval only after the recording holds the restored viewport, not the tall surface.
    try {
      const remaining = deadline === undefined ? undefined : deadline - performance.now()
      if (remaining === undefined || remaining > 0) {
        await recordCurrentPicture(page, remaining)
        await painted(page)
      }
    } finally {
      capture.end = Date.now()
    }
  }
}

export const capturesOf = (page: Page): ReadonlyArray<Capture> => captures.get(page) ?? []
