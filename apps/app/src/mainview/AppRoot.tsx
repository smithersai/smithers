import { StartupErrorPanel } from "./StartupError"
import { subscribeStorageFailure, storageFailure } from "./state/StorageFailure"
import { ViewSkeleton } from "./ViewSkeleton"
import { lazy, StrictMode, Suspense, useSyncExternalStore } from "react"
import { prepareControllerBoot, ControllerProvider } from "./ControllerProvider"
import { SessionNavigation, SessionNavigationFallback } from "./SessionNavigation"
import { SessionShell } from "./SessionShell"
import { MountedSignal, StartupErrorBoundary } from "./StartupBoundary"
import type { StartupWatchdog } from "./StartupWatchdog"
import "@fontsource/inter/400.css"
import "@fontsource/inter/500.css"
import "@fontsource/inter/600.css"
import "@fontsource/ibm-plex-mono/400.css"
import "@fontsource/ibm-plex-mono/500.css"
import "./index.css"

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

const RepoApp = lazy(() => appModule.then(({ default: App }) => ({ default: App })))

export function AppRoot({
  watchdog
}: {
  readonly watchdog: Pick<StartupWatchdog, "markMounted" | "handleRenderFailure">
}) {
  const View = preparedViews?.default ?? RepoApp
  const failure = useSyncExternalStore(subscribeStorageFailure, storageFailure, storageFailure)
  if (failure !== undefined) return <StartupErrorPanel reason={failure} />
  const boot = prepareControllerBoot({})
  return (
    <StrictMode>
      <StartupErrorBoundary onError={watchdog.handleRenderFailure}>
        <SessionShell navigation={<Suspense fallback={<SessionNavigationFallback />}><ControllerProvider boot={boot}><SessionNavigation /></ControllerProvider></Suspense>}>
          <Suspense fallback={<ViewSkeleton />}>
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
