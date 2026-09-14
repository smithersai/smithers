import { expect, test } from "bun:test"
import { transcriptScrollTop } from "./transcriptScroll"

test("anchors the current Smithers message above a tall card, not the card tail", () => {
  expect(transcriptScrollTop({ scrollTop: 800, viewportTop: 100, messageTop: 250, cardTop: 400 })).toBe(950)
})
test("empty-copy beats anchor the fresh card header; an empty transcript starts at zero", () => {
  expect(transcriptScrollTop({ scrollTop: 500, viewportTop: 100, cardTop: 150 })).toBe(550)
  expect(transcriptScrollTop({ scrollTop: 500, viewportTop: 100 })).toBe(0)
})

test("an explicit chat answer takes precedence over the current lesson line", async () => {
  const { scrollToGuideRead } = await import("./transcriptScroll")
  let target: number | undefined
  const prompt = { dataset: { chatMessageId: "sign-in" }, getBoundingClientRect: () => ({ top: 850 }) }
  const viewport = {
    scrollTop: 200,
    getBoundingClientRect: () => ({ top: 100 }),
    querySelectorAll: () => [prompt],
    querySelector: () => ({ getBoundingClientRect: () => ({ top: 150 }) }),
    scrollTo: (options: ScrollToOptions) => { target = options.top },
  } as unknown as HTMLElement
  scrollToGuideRead(viewport, 3, "sign-in")
  expect(target).toBe(940)
})
