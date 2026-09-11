import { AppRoot } from "./AppRoot"
import { pathRepo } from "./RepoLink"
import { browserStartupWatchdog } from "./StartupWatchdog"
import { createAppFetch } from "./runtime/LocalSession"
import { createClientErrorReporter } from "./state/ClientErrors"

/*
 * The whole app as one React component, so every host mounts the same tree:
 * main.tsx renders it into `#root` for the Vite build the local origin and the
 * Electrobun shell serve, and the smithers.sh site renders it as a
 * `client:only` island at `/owner/name`. The startup watchdog is constructed
 * at module scope, as main.tsx always did, because a React that never runs
 * cannot report itself; importing this module arms it. (AppMount.tsx mounts
 * the same AppRoot into a page that is already showing, and arms its watchdog
 * at mount instead.)
 *
 * A repository path (`/owner/name`) opens that repository alone; any other
 * entry opens the tutorial alone.
 */

const watchdog = browserStartupWatchdog({ clientErrors: createClientErrorReporter({ fetchImpl: createAppFetch() }) })

export default function AppIsland() {
  return <AppRoot watchdog={watchdog} mode={pathRepo(window.location.pathname) === null ? "onboarding" : "repo"} />
}
