import { expect, test } from "bun:test"
import { placeToast, type Rect } from "./ToastPlacement"

const bounds = { x: 16, y: 60, width: 1248, height: 724 }
const size = { width: 320, height: 160 }
const place = (modal: Rect, controls: Rect[] = [], viewport = bounds) => placeToast(viewport, size, modal, controls, 16)

test("prefers the right gutter when the whole stack fits", () => {
  expect(place({ x: 200, y: 100, width: 600, height: 400 })).toEqual({ x: 944, y: 60, ...size })
})

test("uses the bottom edge before the top edge", () => {
  expect(place({ x: 190, y: 96, width: 900, height: 246 })).toEqual({ x: 944, y: 358, ...size })
})

test("uses the top edge when there is no space below", () => {
  expect(place({ x: 190, y: 500, width: 900, height: 284 })).toEqual({ x: 944, y: 324, ...size })
})

test("a full-screen modal overlays only space without controls", () => {
  expect(place(bounds, [{ x: 0, y: 60, width: 1280, height: 200 }])).toEqual({ x: 944, y: 276, ...size })
})

test("also avoids controls outside a full-screen shell's measured content child", () => {
  const result = place({ x: 190, y: 96, width: 900, height: 246 }, [{ x: 900, y: 350, width: 364, height: 434 }])!
  expect(result.y + result.height <= 334 || result.x + result.width <= 884).toBe(true)
})

test("a crowded modal scrolls the stack in remaining free space", () => {
  expect(place(bounds, [{ x: 0, y: 160, width: 1280, height: 640 }])).toEqual({ x: 944, y: 60, width: 320, height: 84 })
})

test("a modal made entirely of controls leaves notifications pending", () => {
  expect(place(bounds, [bounds])).toBeNull()
})

test("mobile placement keeps the toast within the viewport below the content", () => {
  expect(placeToast({ x: 16, y: 60, width: 358, height: 768 }, size,
    { x: 12, y: 56, width: 366, height: 286 }, [], 16)).toEqual({ x: 54, y: 358, ...size })
})
