import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@smthrs/ui"
import { X } from "lucide-react"
import type { ReactNode } from "react"

export function SurfaceHeader({
  icon,
  title,
  subtitle,
  closeCommand,
  onClose,
  children
}: {
  readonly icon: ReactNode
  readonly title: string
  readonly subtitle: string
  /**
   * The registered command the close affordance runs. A pane inside the
   * chat-first shell never "exits" to somewhere else — closing it is the
   * back-to-conversation command — and naming it here makes the binding
   * legible in the DOM (data-flow), which is the surface the launch
   * checklist reads.
   */
  readonly closeCommand: string
  readonly onClose: () => void
  readonly children?: ReactNode
}) {
  return (
    <header className="surface-header">
      <div className="surface-header-title">
        <div className="surface-header-icon" aria-hidden="true">{icon}</div>
        <div>
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
      </div>
      <div className="surface-header-actions">
        {children}
        <Button
          variant="ghost"
          size="icon"
          data-flow={closeCommand}
          aria-label="Back to the conversation"
          title="Back to the conversation"
          onClick={onClose}
        >
          <X size={16} />
        </Button>
      </div>
    </header>
  )
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  onCancel
}: {
  readonly open: boolean
  readonly title: string
  readonly body: string
  readonly confirmLabel: string
  readonly cancelLabel?: string
  readonly destructive?: boolean
  readonly onConfirm: () => void
  readonly onCancel: () => void
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onCancel()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{body}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button variant={destructive ? "destructive" : "default"} size="sm" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
