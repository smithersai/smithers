import { expect, type Page } from "@playwright/test"

// What a page painted, frame by frame, while it loaded (docs/features/navigation.md): the probes behind "nothing
// shows for the first 300 ms", "the previous page stays until the next is ready" and "a page is never blank". The
// recorder runs in the page, on every animation frame, so a state that lasted one frame is still seen.

/** One frame: where the tab was, and what of the loading pattern it painted. */
export interface Frame {
  /** Milliseconds since recording started (the click, when armed with fromClick). */
  readonly t: number
  readonly path: string
  /** The router's bar was painted: its opacity above 0. */
  readonly bar: boolean
  /** A skeleton was painted within the measured route main. */
  readonly skeleton: boolean
  /** A spinner was painted within the measured route main. */
  readonly spinner: boolean
  /** The page on screen: its main landmark's name. */
  readonly main: string | null
  /** The visible route main has content, without retaining that content. */
  readonly content: boolean
  /** Painted loading elements, identified without text, attributes containing content or HTML. */
  readonly indicators: ReadonlyArray<{ readonly tag: string; readonly slot: string | null; readonly role: string | null; readonly region: string | null; readonly element: string }>
  /** The app's page (the conversation) was on screen. */
  readonly app: boolean
  /** Whether the repository page's body below its header had content, if it was on screen. */
  readonly repository: boolean | undefined
  /** The repository page's body held a skeleton in place of what is still loading. */
  readonly placeholder: boolean
  /**
   * The repository header's box within the repository page, when it was on screen. Measured from the page's own top
   * left, so only the header's own movement within its page counts.
   */
  readonly header: readonly [number, number, number, number] | undefined
}

declare global {
  interface Window {
    __frames?: Array<Frame>
  }
}

/** Record the route main. With `fromClick`, arm now but sample only from the real click's capture event. */
export const recordFrames = (page: Page, options: { readonly region?: string; readonly fromClick?: boolean } = {}) =>
  page.evaluate(({ region, fromClick }) => {
    const frames: Array<Frame> = []
    window.__frames = frames
    let startedAt = performance.now()
    let recording = !fromClick
    const painted = (element: Element) => {
      if (element.getClientRects().length === 0) return false
      for (let node: Element | null = element; node !== null; node = node.parentElement) {
        const style = getComputedStyle(node)
        if (Number(style.opacity) === 0 || style.visibility === "hidden" || style.visibility === "collapse") return false
      }
      return true
    }
    const hasContent = (element: Element | null) => {
      if (element === null) return false
      const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      for (let node = text.nextNode(); node !== null; node = text.nextNode()) {
        if (!node.textContent?.trim() || node.parentElement === null || !painted(node.parentElement)) continue
        const range = document.createRange()
        range.selectNodeContents(node)
        if ([...range.getClientRects()].some(box => box.width > 0 && box.height > 0)) return true
      }
      return false
    }
    const sample = () => {
      const t = performance.now() - startedAt
      const route = [...document.querySelectorAll("main[aria-label]")].find(painted) ?? null
      const name = route?.getAttribute("aria-label") ?? null
      const scope = region === undefined || name === region ? route : null
      const skeletons = [...(scope?.querySelectorAll('[data-slot="skeleton"]') ?? [])].filter(painted)
      const spinners = [...(scope?.querySelectorAll('[data-slot="spinner"], .sui-spinner, .sui-chat-typing') ?? [])].filter(painted)
      const elementPath = (element: Element) => {
        const parts: string[] = []
        for (let node: Element | null = element; node !== null && node !== route; node = node.parentElement) {
          parts.unshift(node.parentElement === null ? node.localName : `${node.localName}:nth-child(${Array.from(node.parentElement.children).indexOf(node) + 1})`)
        }
        return parts.join(" > ")
      }
      if (window.__frames !== frames) return
      const bar = document.querySelector('[data-slot="loading-bar"][data-placement="page"]')
      const main = name === "Repository" ? route : null
      const header = main?.querySelector('header[aria-label="Repository"]') ?? null
      const box = header?.getBoundingClientRect()
      const origin = main?.getBoundingClientRect()
      const parts = main === null ? [] : [...main.children].filter((child) => child !== header)
      frames.push({
        t,
        path: location.pathname,
        bar: bar !== null && painted(bar),
        skeleton: skeletons.length > 0,
        spinner: spinners.length > 0,
        main: name,
        content: hasContent(route),
        indicators: [...new Set([...skeletons, ...spinners, ...(bar !== null && painted(bar) ? [bar] : [])])].map(element => ({
          tag: element.localName, slot: element.getAttribute("data-slot"), role: element.getAttribute("role"),
          region: element.closest("main[aria-label]")?.getAttribute("aria-label") ?? null, element: elementPath(element),
        })),
        app: name === "App",
        repository: main === null ? undefined : parts.some(hasContent),
        placeholder: parts.some((child) => [child, ...child.querySelectorAll('[data-slot="skeleton"]')].some(element => element.matches('[data-slot="skeleton"]') && painted(element))),
        header: box === undefined || origin === undefined ? undefined : [box.x - origin.x, box.y - origin.y, box.width, box.height],
      })
    }
    if (fromClick) document.addEventListener("click", () => {
      if (window.__frames !== frames) return
      startedAt = performance.now()
      recording = true
      sample()
    }, { capture: true, once: true })
    const frame = () => {
      if (window.__frames !== frames) return
      if (recording) sample()
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }, options)

/** The frames recorded since `recordFrames`, which keeps recording. */
export const framesOf = (page: Page): Promise<Array<Frame>> => page.evaluate(() => [...(window.__frames ?? [])])

/** Waits until the page has drawn `count` more frames: a wait on the page itself, never a fixed sleep. */
export const framesPass = async (page: Page, count: number) => {
  const start = await page.evaluate(() => window.__frames?.length ?? 0)
  await expect.poll(() => page.evaluate(() => window.__frames?.length ?? 0), { timeout: 30_000 }).toBeGreaterThanOrEqual(start + count)
}
