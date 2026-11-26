import { Button, MessageResponse } from "@smthrs/ui"
import type { PinMessage } from "./store.vibe"
import { PinControl } from "./PinControl"
import "./pins.css"

/** Outside the transcript's scrollport, with its own bounded scrollport. */
export function PinnedMessage({ message, collapsed, onUnpin, onCollapse }: {
  readonly message: PinMessage; readonly collapsed: boolean; readonly onUnpin: () => void; readonly onCollapse: () => void
}) {
  return <section className="mvp-pinned-message" aria-label="Pinned message" data-message-id={message.id} data-collapsed={collapsed}>
    <div className="mvp-pin-actions">
      <Button variant="ghost" size="sm" aria-label={collapsed ? "Expand pinned message" : "Collapse pinned message"} aria-expanded={!collapsed} aria-controls={`pin-content-${message.id}`} onClick={onCollapse}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d={collapsed ? "m4 6 4 4 4-4" : "m4 10 4-4 4 4"} /></svg>
      </Button>
      <PinControl pinned onClick={onUnpin} />
    </div>
    <div id={`pin-content-${message.id}`} className="mvp-pin-content" tabIndex={collapsed ? -1 : 0} hidden={collapsed}>
      {message.role === "assistant" ? <MessageResponse content={message.text} streaming={message.status === "streaming"} /> : message.text}
    </div>
  </section>
}
