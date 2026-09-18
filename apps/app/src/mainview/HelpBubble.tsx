import { useCallback, useRef, type ReactNode } from "react"
import { Lightbulb, X } from "lucide-react"
import "./HelpBubble.css"
import { type FlowBindingProps } from "./flows/FlowAction"

export type HelpBubbleProps = {
  /** The content ID can be included in the target control's aria-describedby. */
  id: string
  dismissBinding?: FlowBindingProps
  dismissOnEscape?: boolean
  restoreFocusOnDismiss?: boolean
  open: boolean
  content: ReactNode
  onDismiss: () => void
  /** Footer controls can float guidance above themselves without growing the bar. */
  placement?: "flow" | "above"
  /** Nearby controls that floating guidance must clear (a CSS selector). */
  avoid?: string
  /** Keep floating guidance below this content, shrinking the tip if necessary. */
  below?: string
  /** Draw attention to the target while awaiting its action. */
  pulse?: boolean
  /** The control being explained. It remains mounted when guidance is dismissed. */
  children: ReactNode
}

/**
 * Flow guidance reserves space above its target. Footer guidance floats above
 * the whole bar and clamps to the viewport, keeping every control reachable.
 * The caller owns when to show it; no tutorial, timer, or permission policy
 * belongs here. Opening guidance neither moves focus nor traps the keyboard.
 */
export function HelpBubble({ id, open, content, onDismiss, children, placement = "flow", avoid, below, pulse = false, dismissBinding, dismissOnEscape = true, restoreFocusOnDismiss = true }: HelpBubbleProps) {
  const target = useRef<HTMLDivElement>(null)
  const bubble = useRef<HTMLDivElement>(null)
  const anchor = useCallback((node: HTMLDivElement | null) => {
    if (!node || !open || placement !== "above") return
    const obstacles = avoid ? Array.from(node.ownerDocument.querySelectorAll<HTMLElement>(avoid)) : []
    const boundary = below ? node.ownerDocument.querySelector<HTMLElement>(below) : null
    const measure = () => {
      const tip = bubble.current
      if (!tip) return
      const bounds = node.getBoundingClientRect()
      const { width, height } = tip.getBoundingClientRect()
      const center = bounds.left + bounds.width / 2
      const left = Math.max(16, Math.min(center - width / 2, document.documentElement.clientWidth - width - 16))
      tip.style.left = `${left - bounds.left}px`
      tip.style.setProperty("--help-tip-x", `${center - left}px`)
      // A wrapped footer may have other controls above this target. Clear the
      // whole bar so the guidance never hides those controls on narrow screens.
      const footer = node.closest("footer")?.getBoundingClientRect()
      let edge = Math.min(bounds.top, footer?.top ?? bounds.top)
      const gap = parseFloat(getComputedStyle(tip).marginBottom) || 18
      // Short screens can put an actions row directly above the footer.
      // Move above intersecting controls, keeping the target's horizontal anchor.
      const nearby = obstacles.map(element => element.getBoundingClientRect()).sort((a, b) => b.top - a.top)
      for (const rect of nearby) {
        if (rect.width > 0 && rect.height > 0 && rect.left < left + width && rect.right > left &&
          rect.top < edge && rect.bottom > edge - gap - height) edge = rect.top
      }
      tip.style.bottom = `calc(100% + ${bounds.top - edge}px)`
      const top = Math.max(16, boundary ? boundary.getBoundingClientRect().bottom + 8 : 16)
      const availableHeight = Math.max(0, edge - gap - top)
      tip.style.maxHeight = `${availableHeight}px`
      tip.style.overflowY = tip.scrollHeight > availableHeight ? "auto" : ""
    }
    measure()
    const frame = requestAnimationFrame(measure)
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    const footer = node.closest("footer")
    if (footer) observer.observe(footer)
    for (const obstacle of obstacles) observer.observe(obstacle)
    if (boundary) observer.observe(boundary)
    if (bubble.current) observer.observe(bubble.current)
    window.addEventListener("resize", measure)
    window.addEventListener("scroll", measure, true)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener("resize", measure)
      window.removeEventListener("scroll", measure, true)
    }
  }, [open, placement, avoid, below])
  const dismiss = () => {
    if (restoreFocusOnDismiss && bubble.current?.contains(document.activeElement)) {
      target.current?.querySelector<HTMLElement>("button, a[href], input, select, textarea, [tabindex]")?.focus()
    }
    onDismiss()
  }
  return (
    <div className="help-anchor" ref={anchor} data-placement={placement} data-help-open={open || undefined} data-help-pulse={open && pulse || undefined} onKeyDown={event => {
      if (!dismissOnEscape || !open || event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      dismiss()
    }}>
      {open && (
        <div className="help-bubble" ref={bubble} role="note" aria-label="Help">
          <Lightbulb className="help-bubble-icon" size={17} aria-hidden="true" />
          <div id={id} className="help-bubble-content">{content}</div>
          <button {...dismissBinding} className="help-bubble-dismiss" type="button" aria-label="Dismiss help" onClick={dismiss}>
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      )}
      <div className="help-anchor-target" ref={target}>{children}</div>
    </div>
  )
}
