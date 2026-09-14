import { Button } from "@smthrs/ui"
import type { Toast } from "./state/AppState"
import type { PressAction } from "./runtime/PressActions"

export type ToastAction = NonNullable<Toast["action"]>

/** The same action in both notification surfaces, through the existing flow door. */
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
