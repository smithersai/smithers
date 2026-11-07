import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { init, Message, update } from "../src/web/main.vibe"
import { transcriptViewport } from "../src/web/viewport.ts"

describe("native transcript scroll permission", () => {
  beforeEach(() => {
    document.body.innerHTML = `<div class="vl-app" data-surface="chat"><div data-following="true"><div id="vl-newest"></div></div><textarea></textarea><div contenteditable="true"><span></span></div><dialog id="vl-palette" data-state="closed"></dialog></div>`
  })
  afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = "" })

  test("upward intent vetoes an already authorized follow while the old DOM still says true", () => {
    const nativeScroll = vi.spyOn(Element.prototype, "scrollIntoView")
    const viewport = transcriptViewport(document)
    viewport.follow(0)
    expect(nativeScroll).toHaveBeenCalledTimes(1)
    viewport.wheel(new WheelEvent("wheel", { deltaY: -1 }))
    viewport.follow(0)
    expect(document.querySelector("[data-following]")?.getAttribute("data-following")).toBe("true")
    expect(nativeScroll).toHaveBeenCalledTimes(1)
  })

  test("a paused rendered transcript also vetoes a current revision", () => {
    const nativeScroll = vi.spyOn(Element.prototype, "scrollIntoView")
    const viewport = transcriptViewport(document)
    document.querySelector("[data-following]")!.setAttribute("data-following", "false")
    viewport.follow(0)
    expect(nativeScroll).not.toHaveBeenCalled()
  })

  for (const key of ["PageUp", "Home", "ArrowUp"]) {
    test(`${key} pauses on the page while editor navigation keeps following`, () => {
      const viewport = transcriptViewport(document)
      const nativeScroll = vi.spyOn(Element.prototype, "scrollIntoView")
      const listener = (event: Event) => { viewport.key(event as KeyboardEvent) }
      document.addEventListener("keydown", listener)
      try {
        for (const selector of ["textarea", "[contenteditable] span"]) {
          const editorKey = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
          document.querySelector(selector)!.dispatchEvent(editorKey)
          expect(editorKey.defaultPrevented).toBe(false)
          viewport.follow(0)
        }
        expect(nativeScroll).toHaveBeenCalledTimes(2)
        const pageKey = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
        document.body.dispatchEvent(pageKey)
        expect(pageKey.defaultPrevented).toBe(false)
        viewport.follow(0)
        expect(nativeScroll).toHaveBeenCalledTimes(2)
      } finally { document.removeEventListener("keydown", listener) }
    })
  }

  test("splash and palette input do not invalidate chat permission", () => {
    const viewport = transcriptViewport(document)
    const nativeScroll = vi.spyOn(Element.prototype, "scrollIntoView")
    const app = document.querySelector(".vl-app")!
    const palette = document.querySelector("dialog")!
    app.setAttribute("data-surface", "splash")
    expect(viewport.wheel(new WheelEvent("wheel", { deltaY: -1 }))).toBeUndefined()
    expect(viewport.scrolled()).toBeUndefined()
    app.setAttribute("data-surface", "chat")
    palette.setAttribute("data-state", "open")
    expect(viewport.key(new KeyboardEvent("keydown", { key: "Home" }))).toBeUndefined()
    expect(viewport.scrolled()).toBeUndefined()
    palette.setAttribute("data-state", "closed")
    viewport.follow(0)
    expect(nativeScroll).toHaveBeenCalledOnce()
  })

  for (const surface of ["palette", "splash"] as const) {
    test(`input during an uncommitted ${surface} transition cannot strand follow permission`, () => {
      const viewport = transcriptViewport(document)
      const nativeScroll = vi.spyOn(Element.prototype, "scrollIntoView")
      const model = { ...init({ session: "scope", name: "Ada", mode: "mock" }).model, surface: "chat" as const }
      // The model moves first; the held render still exposes chat to the native input handler.
      let next = update(model, Message.ReceivedEvent({ event: { type: "ReplyStarted", seq: 1, id: "r1" } })).model
      next = update(next, surface === "palette" ? Message.PressedCommandK() : Message.ClickedSplash()).model
      const intent = viewport.wheel(new WheelEvent("wheel", { deltaY: -1 }))!
      next = update(next, Message.ScrolledTranscript(intent)).model
      next = update(next, surface === "palette" ? Message.PressedEscape() : Message.ClickedChat()).model
      expect(next.following).toBe(true)
      viewport.follow(next.followIntent)
      expect(nativeScroll).toHaveBeenCalledOnce()
    })
  }

  test("downward and horizontal wheel input leave following enabled", () => {
    const viewport = transcriptViewport(document)
    const nativeScroll = vi.spyOn(Element.prototype, "scrollIntoView")
    expect(viewport.wheel(new WheelEvent("wheel", { deltaY: 1 }))).toBeUndefined()
    expect(viewport.wheel(new WheelEvent("wheel", { deltaY: 0, deltaX: -1 }))).toBeUndefined()
    viewport.follow(0)
    expect(nativeScroll).toHaveBeenCalledOnce()
  })
})
