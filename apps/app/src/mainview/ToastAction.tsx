import { Button } from "@smthrs/ui"
import type { Toast } from "./state/AppState"
import type { PressAction } from "./runtime/PressActions"
import { createPressActions } from "./runtime/PressActions"

export type ToastAction = NonNullable<Toast["action"]>

/** The shared notification action, through the existing flow door. */
export function ToastActionButton({ toast, onAction }: {
  toast: Toast
  onAction: (action: ToastAction) => void
}) {
  if (toast.answeredAction) return <p role="status">{toast.answeredAction.answer}</p>
  const action = toast.action
  if (!action) return null
  const signIn = action.flow === "auth.sign-in" || action.flow === "cloud.sign-in"
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
  return <Button type="button" size="sm" className="toast-action" data-flow={action.flow}
    data-toast-action={toast.updatedAt}
    aria-keyshortcuts={signIn ? "Meta+Shift+G Control+Shift+G" : undefined}
    onClick={() => onAction(action)}>
    {action.label}
    {signIn && <kbd aria-hidden="true">{mac ? "⌘⇧G" : "Ctrl⇧G"}</kbd>}
  </Button>
}

/** The newest visible sign-in action owns the chord, including while composing. */
export function toastActionShortcut(event: KeyboardEvent, root: ParentNode): PressAction | undefined {
  if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey || event.key.toLowerCase() !== "g") return
  const button = [...root.querySelectorAll<HTMLButtonElement>('[data-toast-action][aria-keyshortcuts]')]
    .filter(button => !button.disabled && !button.closest('[hidden], [inert], [aria-hidden="true"]'))
    .sort((a, b) => Number(b.dataset.toastAction) - Number(a.dataset.toastAction))[0]
  if (!button) return
  return { element: button, activate: () => { if (button.isConnected && !button.disabled) button.click() } }
}

/** The shared surface owns its recovery chord even when a modal owns focus. */
export function bindToastShortcut(root: HTMLElement): () => void {
  const doc = root.ownerDocument
  const held = createPressActions()
  const key = (event: KeyboardEvent) => event.code || event.key.toLowerCase()
  const down = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.repeat) return
    const action = toastActionShortcut(event, root)
    if (!action) return
    event.preventDefault()
    held.down(key(event), action)
  }
  const up = (event: KeyboardEvent) => {
    if (held.up(key(event), !event.isComposing)) {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
  }
  doc.addEventListener("keydown", down, true)
  doc.addEventListener("keyup", up, true)
  doc.defaultView?.addEventListener("blur", held.cancel)
  return () => {
    held.cancel()
    doc.removeEventListener("keydown", down, true)
    doc.removeEventListener("keyup", up, true)
    doc.defaultView?.removeEventListener("blur", held.cancel)
  }
}
