import { RecoveryShell } from "./RecoveryShell"
import { Button, EmptyState } from "@smthrs/ui"
import { type ErrorComponentProps, useRouter } from "@tanstack/react-router"

// A page that failed to load or render (docs/observability.md#render-errors): the shell around it stays, and Retry
// loads it again. React reports the error to the app's records (main.tsx `onCaughtError`); never its message here.
export function RouteError({ reset }: ErrorComponentProps) {
  const router = useRouter()
  return (
    <RecoveryShell>
      <EmptyState
        title="Couldn't show this page"
        action={<Button onClick={() => {
          reset()
          void router.invalidate()
        }}>Retry</Button>}
      />
    </RecoveryShell>
  )
}
