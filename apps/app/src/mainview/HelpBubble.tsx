import { useRef, type ReactNode } from "react"
import { X } from "lucide-react"
import "./HelpBubble.css"

export type HelpBubbleProps = {
  /** The content ID can be included in the target control's aria-describedby. */
  id: string
  open: boolean
  content: ReactNode
  onDismiss: () => void
  /** The control being explained. It remains mounted when guidance is dismissed. */
  children: ReactNode
}

/**
 * Guidance is anchored in normal layout, reserving its own space above the
 * target. It cannot cover that control or depend on viewport measurements.
 * The caller owns when to show it; no tutorial, timer, or permission policy
 * belongs here. Opening guidance neither moves focus nor traps the keyboard.
 */
export function HelpBubble({ id, open, content, onDismiss, children }: HelpBubbleProps) {
  const target = useRef<HTMLDivElement>(null)
  const bubble = useRef<HTMLDivElement>(null)
  const dismiss = () => {
    if (bubble.current?.contains(document.activeElement)) {
      target.current?.querySelector<HTMLElement>("button, a[href], input, select, textarea, [tabindex]")?.focus()
    }
    onDismiss()
  }
  return (
    <div className="help-anchor" data-help-open={open || undefined} onKeyDown={event => {
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
