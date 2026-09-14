import { expect, test } from "bun:test"
import { transcriptScrollTop } from "./transcriptScroll"

test("anchors the current Smithers message above a tall card, not the card tail", () => {
  expect(transcriptScrollTop({ scrollTop: 800, viewportTop: 100, viewportHeight: 500, messageTop: 250, cardTop: 400 })).toBe(950)
})
test("empty-copy beats anchor the fresh card header; an empty transcript starts at zero", () => {
  expect(transcriptScrollTop({ scrollTop: 500, viewportTop: 100, viewportHeight: 500, cardTop: 150 })).toBe(550)
  expect(transcriptScrollTop({ scrollTop: 500, viewportTop: 100, viewportHeight: 500 })).toBe(0)
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

// A card preview includes its header and first row; tall cards still scroll internally.
test("a short viewport anchors the card when the message would crowd out its preview", () => {
  expect(transcriptScrollTop({ scrollTop: 800, viewportTop: 100, viewportHeight: 164,
    messageTop: 250, cardTop: 390, cardHeight: 750 })).toBe(1090)
})
test("desktop keeps the message and card preview together even for a tall card", () => {
  expect(transcriptScrollTop({ scrollTop: 800, viewportTop: 100, viewportHeight: 500,
    messageTop: 250, cardTop: 390, cardHeight: 750 })).toBe(950)
})
test("a small card that fits with its message keeps the message anchor", () => {
  expect(transcriptScrollTop({ scrollTop: 800, viewportTop: 100, viewportHeight: 164,
    messageTop: 250, cardTop: 350, cardHeight: 40 })).toBe(950)
})


test("a streaming chat turn follows its reply once the turn outgrows the viewport", () => {
  expect(transcriptScrollTop({ scrollTop: 800, viewportTop: 100, viewportHeight: 400, messageTop: 100,
    viewportBottom: 500, contentBottom: 650 })).toBe(950)
  // A short turn keeps the user's question in view with the reply.
  expect(transcriptScrollTop({ scrollTop: 800, viewportTop: 100, viewportHeight: 400, messageTop: 150,
    viewportBottom: 500, contentBottom: 350 })).toBe(850)
})
