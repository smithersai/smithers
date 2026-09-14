import { expect, test } from "bun:test"
import { transcriptScrollTop } from "./transcriptScroll"

test("anchors the current Smithers message above a tall card, not the card tail", () => {
  expect(transcriptScrollTop({ scrollTop: 800, viewportTop: 100, messageTop: 250, cardTop: 400 })).toBe(950)
})
test("empty-copy beats anchor the fresh card header; an empty transcript starts at zero", () => {
  expect(transcriptScrollTop({ scrollTop: 500, viewportTop: 100, cardTop: 150 })).toBe(550)
  expect(transcriptScrollTop({ scrollTop: 500, viewportTop: 100 })).toBe(0)
})
