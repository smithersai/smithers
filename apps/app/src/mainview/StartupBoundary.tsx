import { Component } from "react"
import type { ErrorInfo, ReactNode } from "react"
import { StartupErrorPanel } from "./StartupError"

/**
 * Catches a boot failure that reaches React.
 *
 * `use(bootPromise)` rethrows a rejected boot into the render, and apps/app has
 * no other boundary: without this the tree unmounts and the user gets a blank
 * page. `onError` hands the failure to the watchdog, which stands down so the
 * two never render competing panels.
 */
export class StartupErrorBoundary extends Component<
  { readonly onError: (error: unknown) => void; readonly children: ReactNode },
  { readonly failure: { readonly reason: unknown } | null }
> {
  override state: { readonly failure: { readonly reason: unknown } | null } = { failure: null }

  static getDerivedStateFromError(error: unknown): { readonly failure: { readonly reason: unknown } } {
    return { failure: { reason: error } }
  }

  override componentDidCatch(error: unknown, _info: ErrorInfo): void {
    this.props.onError(error)
  }

  override render(): ReactNode {
    const { failure } = this.state
    return failure === null ? this.props.children : <StartupErrorPanel reason={failure.reason} />
  }
}

/**
 * Reports that the app actually mounted.
 *
 * A class is deliberate: apps/app bans `useEffect`, and `componentDidMount` is
 * the one signal that fires after the real mount rather than during a render
 * the boundary may still reject.
 */
export class MountedSignal extends Component<{ readonly onMounted: () => void }> {
  override componentDidMount(): void {
    this.props.onMounted()
  }

  override render(): ReactNode {
    return null
  }
}
