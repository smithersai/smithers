import { useCallback, useRef, type ReactNode } from "react"
import { X } from "lucide-react"
import "./HelpBubble.css"

export type HelpBubbleProps = {
  /** The content ID can be included in the target control's aria-describedby. */
  id: string
  open: boolean
  content: ReactNode
  onDismiss: () => void
  /** Footer controls can float guidance above themselves without growing the bar. */
  placement?: "flow" | "above"
  /** The control being explained. It remains mounted when guidance is dismissed. */
  children: ReactNode
}

/**
 * Flow guidance reserves space above its target. Footer guidance floats above
 * the whole bar and clamps to the viewport, keeping every control reachable.
 * The caller owns when to show it; no tutorial, timer, or permission policy
 * belongs here. Opening guidance neither moves focus nor traps the keyboard.
 */
export function HelpBubble({ id, open, content, onDismiss, children, placement = "flow" }: HelpBubbleProps) {
  const target = useRef<HTMLDivElement>(null)
  const bubble = useRef<HTMLDivElement>(null)
  const anchor = useCallback((node: HTMLDivElement | null) => {
    if (!node || !open || placement !== "above") return
    const measure = () => {
      const tip = bubble.current
      if (!tip) return
      const bounds = node.getBoundingClientRect()
      const width = tip.getBoundingClientRect().width
      const center = bounds.left + bounds.width / 2
      const left = Math.max(16, Math.min(center - width / 2, document.documentElement.clientWidth - width - 16))
      tip.style.left = `${left - bounds.left}px`
      tip.style.setProperty("--help-tip-x", `${center - left}px`)
      // A wrapped footer may have other controls above this target. Clear the
      // whole bar so the guidance never hides those controls on narrow screens.
      const footer = node.closest("footer")?.getBoundingClientRect()
      tip.style.bottom = `calc(100% + ${footer ? Math.max(0, bounds.top - footer.top) : 0}px)`
    }
    measure()
    const frame = requestAnimationFrame(measure)
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    const footer = node.closest("footer")
    if (footer) observer.observe(footer)
    if (bubble.current) observer.observe(bubble.current)
    window.addEventListener("resize", measure)
    window.addEventListener("scroll", measure, true)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener("resize", measure)
      window.removeEventListener("scroll", measure, true)
    }
  }, [open, placement])
  const dismiss = () => {
    if (bubble.current?.contains(document.activeElement)) {
      target.current?.querySelector<HTMLElement>("button, a[href], input, select, textarea, [tabindex]")?.focus()
    }
    onDismiss()
  }
  return (
    <div className="help-anchor" ref={anchor} data-placement={placement} data-help-open={open || undefined} onKeyDown={event => {
      if (!open || event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      dismiss()
    }}>
      {open && (
        <div className="help-bubble" ref={bubble} role="note" aria-label="Help">
          <div id={id} className="help-bubble-content">{content}</div>
          <button className="help-bubble-dismiss" type="button" aria-label="Dismiss help" onClick={dismiss}>
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      )}
      <div className="help-anchor-target" ref={target}>{children}</div>
    </div>
  )
}
