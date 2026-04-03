import { Button } from "@/components/ui/button"

type AppCrashScreenProps = {
  title?: string
  message?: string
  details?: string | null
  showGoHomeButton?: boolean
}

export function AppCrashScreen({
  title = "Burns hit an unexpected error",
  message = "The app could not finish rendering. Reload the window to try again.",
  details = null,
  showGoHomeButton = true,
}: AppCrashScreenProps) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <div className="w-full max-w-xl rounded-2xl border bg-card p-6 shadow-sm">
        <div className="space-y-2">
          <h1 className="text-xl font-semibold">{title}</h1>
          <p className="text-sm text-muted-foreground">{message}</p>
        </div>
        {details ? (
          <pre className="mt-4 overflow-x-auto rounded-lg border bg-muted p-3 text-xs text-muted-foreground">
            {details}
          </pre>
        ) : null}
        <div className="mt-6 flex items-center gap-2">
          <Button onClick={() => window.location.reload()}>Reload</Button>
          {showGoHomeButton ? (
            <Button variant="outline" onClick={() => window.location.assign("/")}>
              Go Home
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
