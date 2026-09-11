import { lazy, StrictMode, Suspense } from "react"
import { controllerBootPromise, ControllerProvider } from "./ControllerProvider"
import { SessionShell } from "./SessionShell"
import { MountedSignal, StartupErrorBoundary } from "./StartupBoundary"
import type { StartupWatchdog } from "./StartupWatchdog"
import "@fontsource/inter/400.css"
import "@fontsource/inter/500.css"
import "@fontsource/inter/600.css"
import "@fontsource/ibm-plex-mono/400.css"
import "@fontsource/ibm-plex-mono/500.css"
import "./index.css"

/**
 * Which app a page opens. `onboarding` is the tutorial alone (GuidedApp) and
 * names no repository; `repo` is one repository's workspace alone (the bare
 * App) at `/owner/name`, with no tutorial beside it.
 */
export type AppMode = "onboarding" | "repo"

/*
 * The whole tree, without a watchdog of its own. AppIsland.tsx arms one at
 * module scope; AppMount.tsx arms one when it mounts, so the home page can
 * import this module ahead of time without starting the boot clock.
 */

// Fetch the view while the controller opens SQLite, before its provider suspends.
const appModule = import("./App")
// React's lazy boundary owns the error even if the download fails before render.
void appModule.catch(() => {})
const GuidedApp = lazy(() => appModule.then(({ GuidedApp }) => ({ default: GuidedApp })))
const RepoApp = lazy(() => appModule.then(({ default: App }) => ({ default: App })))

export function AppRoot({
  mode,
  watchdog
}: {
  readonly mode: AppMode
  readonly watchdog: Pick<StartupWatchdog, "markMounted" | "handleRenderFailure">
}) {
  const View = mode === "repo" ? RepoApp : GuidedApp
  return (
    <StrictMode>
      <StartupErrorBoundary onError={watchdog.handleRenderFailure}>
        <SessionShell>
          <Suspense fallback={null}>
            <ControllerProvider boot={controllerBootPromise()}>
              <MountedSignal onMounted={watchdog.markMounted} />
              <View />
            </ControllerProvider>
          </Suspense>
        </SessionShell>
      </StartupErrorBoundary>
    </StrictMode>
  )
}
