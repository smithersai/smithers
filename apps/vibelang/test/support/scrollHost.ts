// Stays .ts: it drives happy-dom through DOM globals, which VibeLang rejects as host code (EK4402) and no Effect
// service provides (upstream-bugs/vibelang-dom-test-globals).
// A controlled animation-frame boundary in happy-dom. The application, update and subscriptions remain real.
// happy-dom has no layout; observing scrollIntoView records whether a follow write was attempted after intent.
import { vi } from "vitest"
import type { Message } from "../../src/web/main.vibe"

export type UpwardInput = "wheel" | "touch" | "PageUp" | "Home" | "ArrowUp"

export function scrollHost() {
  const node = document.createElement("div")
  node.id = "scroll-runtime"
  document.body.append(node)
  let next = 0
  const frames = new Map<number, FrameRequestCallback>()
  let intent = false
  let scrolls = 0
  let y = 600
  const position = vi.spyOn(window, "scrollY", "get").mockImplementation(() => y)
  const height = vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(1000)
  const viewport = vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(400)
  const raf = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(callback => {
    const id = ++next
    frames.set(id, callback)
    return id
  })
  const cancel = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id) })
  const scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => { if (intent) scrolls++ })
  const scrolled = () => { document.dispatchEvent(new Event("scroll")) }
  return {
    node,
    page: document,
    target: node as EventTarget,
    up: (kind: UpwardInput = "wheel") => {
      if (kind === "wheel") document.dispatchEvent(new WheelEvent("wheel", { deltaY: -10000, bubbles: true }))
      else if (kind === "touch") {
        const start = new Touch({ identifier: 1, target: node, clientY: 100 })
        const move = new Touch({ identifier: 1, target: node, clientY: 200 })
        document.dispatchEvent(new TouchEvent("touchstart", { touches: [start], bubbles: true }))
        document.dispatchEvent(new TouchEvent("touchmove", { touches: [move], bubbles: true }))
      } else document.dispatchEvent(new KeyboardEvent("keydown", { key: kind, bubbles: true }))
    },
    scrolled,
    moveTo: (value: number) => { y = value; scrolled() },
    latest: () => { document.querySelector<HTMLButtonElement>(".vl-latest")!.click() },
    emit: (message: Message) => { node.dispatchEvent(new CustomEvent("delta", { detail: message })) },
    message: (event: Event): Message => (event as CustomEvent<Message>).detail,
    pending: () => frames.size,
    frame: () => {
      const ready = [...frames.values()]
      frames.clear()
      for (const callback of ready) callback(performance.now())
    },
    markIntent: () => { intent = true },
    scrollsAfterIntent: () => scrolls,
    dispose: () => {
      raf.mockRestore(); cancel.mockRestore(); scroll.mockRestore()
      position.mockRestore(); height.mockRestore(); viewport.mockRestore(); node.remove()
    },
  }
}
