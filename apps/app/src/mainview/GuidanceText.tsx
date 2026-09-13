import { useCallback, type CSSProperties } from "react"

export const guidanceTypingMs = (text: string) => Array.from(text).length * 20

/** Transient presentation only. The caller owns the sequence and its targets. */
export function GuidanceText({ text, onRead }: { text: string; onRead?: () => void }) {
  const mount = useCallback((node: HTMLSpanElement | null) => {
    if (!node || !onRead) return
    const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
    // Leave the complete sentence on screen long enough to read after typing.
    const delay = (reduced ? 0 : guidanceTypingMs(text)) + Math.max(3500, text.split(/\s+/).length * 260)
    let timer: ReturnType<typeof setTimeout>
    const start = () => { clearTimeout(timer); timer = setTimeout(onRead, delay) }
    const pause = () => clearTimeout(timer)
    const bubble = node.closest(".help-bubble") ?? node
    start()
    bubble.addEventListener("pointerenter", pause)
    bubble.addEventListener("pointerleave", start)
    bubble.addEventListener("focusin", pause)
    bubble.addEventListener("focusout", start)
    return () => {
      pause()
      bubble.removeEventListener("pointerenter", pause)
      bubble.removeEventListener("pointerleave", start)
      bubble.removeEventListener("focusin", pause)
      bubble.removeEventListener("focusout", start)
    }
  }, [text, onRead])
  return <span ref={mount} className="guidance-text">
    <span className="guidance-text-accessible">{text}</span>
    <span aria-hidden="true" className="guidance-text-visual">{Array.from(text).map((character, i) =>
      <span key={i} style={{ "--character-delay": `${i * 20}ms` } as CSSProperties}>{character}</span>
    )}</span>
  </span>
}
