// @vitest-environment happy-dom
import { afterEach, expect, test } from "vitest"
import { captureState, paintAt, removeMobileStyles, restoreMobileStyles, scrollTo } from "./baseline-dom"

afterEach(() => { document.head.replaceChildren(); document.body.replaceChildren() })

test("the browser snapshot reads the document and scroll", () => {
  expect(captureState()).toEqual({
    document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
    scroll: { x: scrollX, y: scrollY },
  })
  scrollTo({ x: 0, y: 0 })
  expect(captureState().scroll).toEqual({ x: 0, y: 0 })
})

test("painting waits for both frame boundaries", async () => {
  const frames: number[] = []
  requestAnimationFrame(() => { frames.push(1); requestAnimationFrame(() => frames.push(2)) })
  await paintAt({ x: 0, y: 0 })
  expect(frames).toEqual([1, 2])
})

test("indexed rules are removed recursively and restored at their original positions", () => {
  const first = document.createElement("style")
  first.textContent = '.before{color:blue}@media (max-width:960px){.target{flex-wrap:wrap}.middle{color:red}}.target{flex-wrap:wrap}@font-face{font-family:Fixture;src:url(fixture.woff)}.after{color:green}'
  const second = document.createElement("style")
  second.textContent = '.target{flex-wrap:wrap}.keep{display:block}'
  document.head.append(first, second)
  const css = () => [...document.styleSheets].map(sheet => [...sheet.cssRules].map(rule => rule.cssText))
  const before = css()
  expect(removeMobileStyles(['.target { flex-wrap: wrap; }'])).toBe(3)
  expect(css().flat().join("\n")).not.toContain("flex-wrap")
  expect(css().flat().join("\n")).toContain(".keep")
  restoreMobileStyles()
  expect(css()).toEqual(before)
})

test("a sheet without matching rules is left intact", () => {
  const style = document.createElement("style")
  style.textContent = '.keep{display:block}'
  document.head.append(style)
  const before = style.sheet!.cssRules[0]!.cssText
  expect(removeMobileStyles(['.target{flex-wrap:wrap}'])).toBe(0)
  restoreMobileStyles()
  expect(style.sheet!.cssRules[0]!.cssText).toBe(before)
})
