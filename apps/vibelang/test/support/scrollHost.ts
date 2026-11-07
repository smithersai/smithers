// A controlled animation-frame boundary in happy-dom. The application, update and subscriptions remain real.
// happy-dom has no layout; observing scrollIntoView records whether a follow write was attempted after intent.
import { vi } from "vitest"
import type { Message } from "../../src/web/main.vibe"

export function scrollHost() {
  const node = document.createElement("div")
  node.id = "scroll-runtime"
  document.body.append(node)
  let next = 0
  const frames = new Map<number, FrameRequestCallback>()
  let intent = false
  let scrolls = 0
  const raf = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(callback => {
    const id = ++next
    frames.set(id, callback)
    return id
  })
  const cancel = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id) })
  const scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => { if (intent) scrolls++ })
  return {
    node,
    page: document,
    target: node as EventTarget,
    up: () => { document.dispatchEvent(new WheelEvent("wheel", { deltaY: -10000, bubbles: true })) },
    scrolled: () => { document.dispatchEvent(new Event("scroll")) },
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
    dispose: () => { raf.mockRestore(); cancel.mockRestore(); scroll.mockRestore(); node.remove() },
  }
}
