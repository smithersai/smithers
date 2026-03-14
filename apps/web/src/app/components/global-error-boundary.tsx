import { Component, type ErrorInfo, type ReactNode } from "react"

import { AppCrashScreen } from "@/app/components/app-crash-screen"
import { DesktopStartupBlockedError } from "@/app/errors/desktop-startup-blocked-error"

type GlobalErrorBoundaryProps = {
  children: ReactNode
}

type GlobalErrorBoundaryState = {
  error: Error | null
}

export class GlobalErrorBoundary extends Component<
  GlobalErrorBoundaryProps,
  GlobalErrorBoundaryState
> {
  state: GlobalErrorBoundaryState = {
    error: null,
  }

  static getDerivedStateFromError(error: Error): GlobalErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Unhandled application error", error, errorInfo)
  }

  render() {
    if (this.state.error) {
      if (this.state.error instanceof DesktopStartupBlockedError) {
        return (
          <AppCrashScreen
            title={this.state.error.title}
            message={this.state.error.message}
            details={this.state.error.details}
            showGoHomeButton={false}
          />
        )
      }

      return (
        <AppCrashScreen
          message="The app crashed while rendering. Reload the window to try again."
          details={this.state.error.stack ?? this.state.error.message}
        />
      )
    }

    return this.props.children
  }
}
