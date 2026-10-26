import { expect, type Page } from "@playwright/test"

// What a page painted, frame by frame, while it loaded (docs/features/navigation.md): the probes behind "nothing
// shows for the first 300 ms", "the previous page stays until the next is ready" and "a page is never blank". The
// recorder runs in the page, on every animation frame, so a state that lasted one frame is still seen.

/** One frame: where the tab was, and what of the loading pattern it painted. */
export interface Frame {
  /** Milliseconds since the recorder started. */
  readonly t: number
  readonly path: string
  /** The router's bar was painted: its opacity above 0. */
  readonly bar: boolean
  /** A skeleton was painted. */
  readonly skeleton: boolean
  /** A spinner, of any kind the app ever had, was in the page. */
  readonly spinner: boolean
  /** The page on screen: its main landmark's name. */
  readonly main: string | null
  /** The app's page (the conversation) was on screen. */
  readonly app: boolean
  /** The repository page was on screen, and the text of its body below its header, if it was. */
  readonly repository: string | undefined
  /** The repository page's body held a skeleton in place of what is still loading. */
  readonly placeholder: boolean
  /** The start of the repository page's body's markup, to say what a failing frame showed. */
  readonly markup: string | undefined
  /**
   * The repository header's box within the repository page, when it was on screen. Measured from the page's own top
   * left: live notices above the page (src/screens/app/Toasts.tsx) push the whole page down by design, which is not the
   * header moving.
   */
  readonly header: readonly [number, number, number, number] | undefined
}

declare global {
  interface Window {
    __frames?: Array<Frame>
  }
}

/** Starts recording every frame of `page`. */
export const recordFrames = (page: Page) =>
  page.evaluate(() => {
    const frames: Array<Frame> = []
    window.__frames = frames
    const startedAt = performance.now()
    const painted = (element: Element) => {
      if (element.getClientRects().length === 0) return false
      for (let node: Element | null = element; node !== null; node = node.parentElement) {
        if (Number(getComputedStyle(node).opacity) === 0) return false
      }
      return true
    }
    const frame = () => {
      if (window.__frames !== frames) return
      const bar = document.querySelector('[data-slot="loading-bar"][data-placement="page"]')
      const main = document.querySelector('main[aria-label="Repository"]')
      const header = main?.querySelector('header[aria-label="Repository"]') ?? null
      const box = header?.getBoundingClientRect()
      const origin = main?.getBoundingClientRect()
      const parts = main === null ? [] : [...main.children].filter((child) => child !== header)
      const body = main === null ? undefined : parts.map((child) => (child as HTMLElement).innerText).join(" ").trim()
      frames.push({
        t: performance.now() - startedAt,
        path: location.pathname,
        bar: bar !== null && painted(bar),
        skeleton: [...document.querySelectorAll('[data-slot="skeleton"]')].some(painted),
        spinner: document.querySelector('[data-slot="spinner"], .sui-spinner, .sui-chat-typing') !== null,
        main: document.querySelector("main[aria-label]")?.getAttribute("aria-label") ?? null,
        app: document.querySelector('main[aria-label="App"]') !== null,
        repository: body,
        placeholder: parts.some((child) => child.matches('[data-slot="skeleton"]') || child.querySelector('[data-slot="skeleton"]') !== null),
        markup: main === null ? undefined : parts.map((child) => child.outerHTML).join("").slice(0, 240),
        header: box === undefined || origin === undefined ? undefined : [box.x - origin.x, box.y - origin.y, box.width, box.height],
      })
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  })

/** The frames recorded since `recordFrames`, which keeps recording. */
export const framesOf = (page: Page): Promise<Array<Frame>> => page.evaluate(() => [...(window.__frames ?? [])])

/** Waits until the page has drawn `count` more frames: a wait on the page itself, never a fixed sleep. */
export const framesPass = async (page: Page, count: number) => {
  const start = await page.evaluate(() => window.__frames?.length ?? 0)
  await expect.poll(() => page.evaluate(() => window.__frames?.length ?? 0), { timeout: 30_000 }).toBeGreaterThanOrEqual(start + count)
}
