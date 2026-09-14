import { lazy, StrictMode, Suspense } from "react"
import { prepareControllerBoot, ControllerProvider } from "./ControllerProvider"
import { SessionNavigation, SessionNavigationFallback } from "./SessionNavigation"
import { SessionShell } from "./SessionShell"
import { MountedSignal, StartupErrorBoundary } from "./StartupBoundary"
import type { StartupWatchdog } from "./StartupWatchdog"
import type { ControllerBootOptions } from "./ControllerBoot.client"
import "@fontsource/inter/400.css"
import "@fontsource/inter/500.css"
import "@fontsource/inter/600.css"
import "@fontsource/ibm-plex-mono/400.css"
import "@fontsource/ibm-plex-mono/500.css"
import "./index.css"

/**
 * Which app a page opens. `onboarding` is the tutorial alone (GuidedApp) and
 * names no repository; `repo` is one repository's workspace at `/owner/name`
 * (RepositoryApp), which does not start a tutorial — but it does show one
 * already in flight, and its footer's Replay introduction door mounts the
 * guide over it without a navigation (three-door law, App.tsx).
 */
export type AppMode = "onboarding" | "repo"

/*
 * The whole tree, without a watchdog of its own. AppIsland.tsx arms one at
 * module scope; AppMount.tsx arms one when it mounts, so the home page can
 * import this module ahead of time without starting the boot clock.
 */

// Fetch the view while the controller opens SQLite, before its provider suspends.
const appModule = import("./App")
let preparedViews: typeof import("./App") | undefined
void appModule.then(views => { preparedViews = views }, () => {})
// React's lazy boundary owns the error even if the download fails before render.
void appModule.catch(() => {})
const GuidedApp = lazy(() => appModule.then(({ GuidedApp }) => ({ default: GuidedApp })))
const RepoApp = lazy(() => appModule.then(({ RepositoryApp }) => ({ default: RepositoryApp })))

/** Resolve the real controller and view before a homepage entrance swaps its DOM. */
export const prepareAppRoot = async (mode: AppMode, options: Omit<ControllerBootOptions, "mode"> = {}): Promise<void> => {
  await Promise.all([prepareControllerBoot({ ...options, mode }), appModule])
}

export function AppRoot({
  mode,
  watchdog
}: {
  readonly mode: AppMode
  readonly watchdog: Pick<StartupWatchdog, "markMounted" | "handleRenderFailure">
}) {
  const View = preparedViews === undefined
    ? (mode === "repo" ? RepoApp : GuidedApp)
    : (mode === "repo" ? preparedViews.RepositoryApp : preparedViews.GuidedApp)
  const boot = prepareControllerBoot({ mode })
  return (
    <StrictMode>
      <StartupErrorBoundary onError={watchdog.handleRenderFailure}>
        <SessionShell navigation={<Suspense fallback={<SessionNavigationFallback />}><ControllerProvider boot={boot}><SessionNavigation /></ControllerProvider></Suspense>}>
          <Suspense fallback={null}>
            <ControllerProvider boot={boot}>
              <MountedSignal onMounted={watchdog.markMounted} />
              <View />
            </ControllerProvider>
          </Suspense>
        </SessionShell>
      </StartupErrorBoundary>
    </StrictMode>
  )
}
