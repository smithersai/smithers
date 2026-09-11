import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { AppRoot, type AppMode } from "./AppRoot"
import { configureControllerBoot } from "./ControllerProvider"
import { browserStartupWatchdog } from "./StartupWatchdog"
import { createAppFetch } from "./runtime/LocalSession"
import { createClientErrorReporter } from "./state/ClientErrors"

/*
 * Mount the app into a page that is already showing something else: the
 * smithers.sh home page imports this module after its `load` event and calls
 * `mountApp` on Start Here, so the app arrives in the same document without a
 * navigation. Importing arms nothing; the startup watchdog and the boot start
 * at the call.
 */

export interface MountAppOptions {
  readonly mode: AppMode
  /** Keep the address bar on the current URL instead of frame paths (runtime/FrameHistory.ts). */
  readonly keepUrl?: boolean
}

export interface MountedApp {
  readonly unmount: () => void
}

/**
 * The appearance the app paints with: the stored theme and palette, else the
 * viewer's scheme. The same reading apps/site's AppShell.astro and
 * mainview/index.html run inline before first paint.
 */
export const applyAppearance = (root: HTMLElement = document.documentElement): void => {
  let theme: string | null = null
  let palette: string | null = null
  try {
    theme = window.localStorage.getItem("smithers-mvp.theme")
    palette = window.localStorage.getItem("smithers-mvp.palette")
  } catch {
    // A refused storage is not a reason to paint nothing: the scheme decides.
  }
  if (theme !== "light" && theme !== "dark") {
    theme = window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  }
  root.setAttribute("data-theme", theme)
  if (typeof palette === "string" && /^[a-z][a-z-]*$/.test(palette)) root.setAttribute("data-palette", palette)
}

/**
 * Render the app into `container` synchronously: the entrance wordmark
 * (SessionShell) is in the DOM when this returns, so a caller's view
 * transition can capture it; the rest of the app follows its boot.
 */
export function mountApp(container: HTMLElement, options: MountAppOptions): MountedApp {
  applyAppearance()
  configureControllerBoot({ keepUrl: options.keepUrl === true })
  const watchdog = browserStartupWatchdog({ clientErrors: createClientErrorReporter({ fetchImpl: createAppFetch() }) })
  const root = createRoot(container)
  flushSync(() => root.render(<AppRoot mode={options.mode} watchdog={watchdog} />))
  return { unmount: () => root.unmount() }
}
