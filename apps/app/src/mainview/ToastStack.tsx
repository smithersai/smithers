import { Alert, AlertDescription, AlertTitle, Button, Spinner } from "@smthrs/ui"
import { X } from "lucide-react"
import type { Toast } from "./state/AppState"

/*
 * The one shared toast surface (the 300ms law): a corner stack over the chat,
 * driven entirely by the toasts collection — transitions dispatched like
 * everything else. Running work shows what is running; a resolved ok toast
 * dismisses itself; a failure toast stays honest until dismissed (the dismiss
 * affordance routes through the registered toast.dismiss command).
 */
export function ToastStack({
  toasts,
  onDismiss
}: {
  readonly toasts: ReadonlyArray<Toast>
  readonly onDismiss: (id: string) => void
}) {
  if (toasts.length === 0) return null
  return (
    <div className="toast-stack" aria-label="Notifications">
      {toasts.map((toast) => (
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
          {toast.status === "running" ? <Spinner size="sm" className="toast-spinner" aria-label="Working" /> : null}
          <div className="toast-body">
            <AlertTitle className="toast-title">{toast.title}</AlertTitle>
            {toast.detail !== "" ? <AlertDescription className="toast-detail">{toast.detail}</AlertDescription> : null}
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
    </div>
  )
}
