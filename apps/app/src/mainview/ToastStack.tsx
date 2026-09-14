import { Alert, AlertDescription, AlertTitle, Button, Spinner } from "@smthrs/ui"
import { Check, X } from "lucide-react"
import { ModalPopover } from "./ModalPopover"
import type { Toast } from "./state/AppState"
import { bindToastShortcut, ToastActionButton, type ToastAction } from "./ToastAction"

/*
 * The one shared toast surface (the 300ms law): a corner stack over the chat,
 * driven entirely by the toasts collection — transitions dispatched like
 * everything else. Running work shows what is running; a resolved ok toast
 * dismisses itself; a failure toast stays honest until dismissed (the dismiss
 * affordance routes through the registered toast.dismiss command).
 */
export function ToastStack({
  toasts,
  onDismiss,
  onAction
}: {
  readonly toasts: ReadonlyArray<Toast>
  readonly onDismiss: (id: string) => void
  readonly onAction: (action: ToastAction) => void
}) {
  if (toasts.length === 0) return null
  return (
    <ModalPopover className="toast-stack" label="Notifications" onMount={bindToastShortcut}>
      {[...toasts].sort((a, b) => b.createdAt - a.createdAt).map((toast) => (
        <Alert
          key={toast.id}
          className="toast"
          data-toast-status={toast.status}
          variant={toast.status === "failed" ? "destructive" : "default"}
          /*
           * B-6: role="alert" is an assertive error landmark — only a FAILED
           * toast is one. A running/ok toast is a calm status note; rendering
           * it as an alert made an ordinary notification (repositories ready
           * to choose) read as an error surface mid-correction.
           */
          role={toast.status === "failed" ? "alert" : "status"}
        >
          {toast.status === "running" ? <Spinner size="sm" className="toast-icon" aria-label="Working" />
            : toast.status === "ok" ? <Check size={17} className="toast-icon" aria-hidden="true" />
            : <X size={17} className="toast-icon" aria-hidden="true" />}
          <div className="toast-body">
            <AlertTitle className="toast-title">{toast.title}</AlertTitle>
            {toast.detail !== "" ? <AlertDescription className="toast-detail">{toast.detail}</AlertDescription> : null}
            <ToastActionButton toast={toast} onAction={action => { onDismiss(toast.id); onAction(action) }} />
          </div>
          {toast.status === "failed" ?
            (
              <Button
                variant="ghost"
                size="icon"
                className="toast-dismiss"
                data-flow="toast.dismiss"
                aria-label={`Dismiss: ${toast.title}`}
                title="Dismiss"
                onClick={() => onDismiss(toast.id)}
              >
                <X size={12} />
              </Button>
            ) :
            null}
        </Alert>
      ))}
    </ModalPopover>
  )
}
