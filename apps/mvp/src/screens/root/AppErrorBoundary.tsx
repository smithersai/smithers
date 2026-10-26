import { Button, EmptyState } from "@smthrs/ui"
import { Component, type ReactNode } from "react"

// The app's last error boundary (docs/observability.md#render-errors): a render error no page or plugin caught shows
// this instead of a blank page. React reports the error to the app's records (main.tsx `onCaughtError`).
export class AppErrorBoundary extends Component<
  { readonly reload: () => void; readonly children: ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  override render() {
    return this.state.failed
      ? <main><EmptyState title="Couldn't show this page" action={<Button onClick={this.props.reload}>Reload</Button>} /></main>
      : this.props.children
  }
}
