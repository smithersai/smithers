import type { BurnsTrayStatus } from "@burns/shared"
import Electrobun, { BrowserWindow, Tray, Utils } from "electrobun/bun"
import { appendFileSync } from "node:fs"

import { buildDesktopStartupErrorInitScript } from "@burns/shared"

import {
  DesktopDaemonAlreadyRunningError,
  resolveDesktopDaemonRuntime,
  type DesktopDaemonRuntimeHandle,
} from "./daemon-runtime"
import { resolveDesktopSourceUrl } from "./desktop-source"
import {
  buildRuntimeConfigInitScript,
  resolveRuntimeConfig,
} from "./runtime-config"
import { buildTrayMenu, resolveTrayActionOutcome, type TrayMenuItem } from "./tray-menu"
import {
  buildInAppNavigationScript,
  DEFAULT_TRAY_STATUS,
  fetchTrayStatus,
  resolveTrayIconPath,
} from "./tray-runtime"

type BeforeQuitEvent = {
  response?: {
    allow: boolean
  }
}

let daemonRuntime: DesktopDaemonRuntimeHandle | null = null
let daemonStopPromise: Promise<void> | null = null
let shouldQuitAfterCleanup = false
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let trayStatus: BurnsTrayStatus = DEFAULT_TRAY_STATUS
let trayRefreshTimer: ReturnType<typeof setInterval> | null = null
const debugLogEnabled = process.env.BURNS_DESKTOP_DEBUG_LOG === "1"
const debugLogPath = process.env.BURNS_DESKTOP_DEBUG_LOG_PATH ?? "/tmp/burns-desktop-debug.log"

function debugLog(message: string) {
  if (!debugLogEnabled) {
    return
  }

  const timestamp = new Date().toISOString()
  appendFileSync(debugLogPath, `${timestamp} ${message}\n`)
}

async function stopDaemonRuntime() {
  debugLog("stopDaemonRuntime: begin")
  if (daemonStopPromise) {
    debugLog("stopDaemonRuntime: reusing pending promise")
    return daemonStopPromise
  }

  daemonStopPromise = (async () => {
    if (!daemonRuntime) {
      debugLog("stopDaemonRuntime: no runtime to stop")
      return
    }

    try {
      debugLog("stopDaemonRuntime: calling daemonRuntime.stop()")
      await daemonRuntime.stop()
    } finally {
      debugLog("stopDaemonRuntime: runtime cleared")
      daemonRuntime = null
    }
  })().finally(() => {
    debugLog("stopDaemonRuntime: promise cleared")
    daemonStopPromise = null
  })

  return daemonStopPromise
}

function clearTrayRefreshTimer() {
  if (!trayRefreshTimer) {
    return
  }

  clearInterval(trayRefreshTimer)
  trayRefreshTimer = null
}

function teardownTray() {
  clearTrayRefreshTimer()
  trayStatus = DEFAULT_TRAY_STATUS

  if (!tray) {
    return
  }

  tray.remove()
  tray = null
}

function injectRuntimeConfig(window: BrowserWindow, daemonApiUrl: string) {
  debugLog(`injectRuntimeConfig: daemonApiUrl=${daemonApiUrl}`)
  const runtimeConfig = resolveRuntimeConfig({ daemonApiUrl })
  const script = buildRuntimeConfigInitScript(runtimeConfig)
  window.webview.executeJavascript(script)
}

function injectStartupError(window: BrowserWindow, error: DesktopDaemonAlreadyRunningError) {
  const script = buildDesktopStartupErrorInitScript({
    title: "Burns is already running",
    message:
      "Another Burns daemon is already listening on the configured desktop port. Close that instance and retry.",
    details: `Daemon URL: ${error.daemonUrl}`,
  })
  window.webview.executeJavascript(script)
}

function updateTrayMenu(nextTrayStatus: BurnsTrayStatus) {
  if (!tray) {
    return
  }

  tray.setImage(resolveTrayIconPath())
  tray.setMenu(buildTrayMenu(nextTrayStatus) as TrayMenuItem[] as never)
}

function navigateWindowToPath(window: BrowserWindow, pathname: string | null) {
  if (!pathname) {
    return
  }

  debugLog(`navigateWindowToPath: ${pathname}`)
  window.webview.executeJavascript(buildInAppNavigationScript(pathname))
}

function showMainWindow(window: BrowserWindow) {
  if (window.isMinimized()) {
    window.unminimize()
  }

  window.show()
  window.focus()
}

async function createMainWindow(initialPath: string | null = null) {
  const sourceUrl = await resolveDesktopSourceUrl()
  debugLog(`createMainWindow: sourceUrl=${sourceUrl} initialPath=${initialPath ?? "none"}`)

  const window = new BrowserWindow({
    title: "Burns",
    url: sourceUrl,
    renderer: "native",
    frame: {
      x: 160,
      y: 90,
      width: 1360,
      height: 900,
    },
  })
  mainWindow = window
  debugLog(`createMainWindow: window created id=${window.id}`)

  // Force a visible, focused frame in dev/runtime in case previous window state
  // or multi-display coordinates place it off-screen.
  window.setFrame(160, 90, 1360, 900)
  debugLog("createMainWindow: setFrame(160, 90, 1360, 900)")
  showMainWindow(window)

  window.webview.on("dom-ready", () => {
    debugLog("mainWindow.webview: dom-ready")
    if (!daemonRuntime) {
      debugLog("mainWindow.webview: dom-ready skipped (no daemon runtime)")
      return
    }

    injectRuntimeConfig(window, daemonRuntime.url)
    navigateWindowToPath(window, initialPath)
  })

  window.on("close", () => {
    debugLog("mainWindow: close event")
    if (mainWindow?.id === window.id) {
      mainWindow = null
    }
  })

  return window
}

async function openMainWindow(pathname: string | null = null) {
  if (mainWindow) {
    showMainWindow(mainWindow)
    navigateWindowToPath(mainWindow, pathname)
    return mainWindow
  }

  return createMainWindow(pathname)
}

async function refreshTrayState() {
  if (!tray || !daemonRuntime) {
    return
  }

  try {
    const nextTrayStatus = await fetchTrayStatus(daemonRuntime.url)
    trayStatus = nextTrayStatus
    updateTrayMenu(nextTrayStatus)
    debugLog(
      `refreshTrayState: pending=${nextTrayStatus.pendingCount} running=${nextTrayStatus.runningCount}`
    )
  } catch (error) {
    debugLog(`refreshTrayState: failed ${(error as Error)?.message ?? String(error)}`)
  }
}

async function handleTrayAction(action: string) {
  const outcome = resolveTrayActionOutcome(action, trayStatus)
  if (outcome.kind === "none") {
    return
  }

  if (outcome.kind === "quit") {
    Utils.quit()
    return
  }

  await openMainWindow(outcome.path)
  void refreshTrayState()
}

function initializeTray() {
  tray = new Tray({
    image: resolveTrayIconPath(),
    template: false,
    width: 16,
    height: 16,
  })

  updateTrayMenu(trayStatus)

  tray.on("tray-clicked", (event: unknown) => {
    const action = (event as { data?: { action?: unknown } })?.data?.action
    if (typeof action !== "string" || action.length === 0) {
      updateTrayMenu(trayStatus)
      void refreshTrayState()
      return
    }

    void handleTrayAction(action)
  })

  void refreshTrayState()
  clearTrayRefreshTimer()
  trayRefreshTimer = setInterval(() => {
    void refreshTrayState()
  }, 5000)
}

function handleBeforeQuit(event: unknown) {
  debugLog("handleBeforeQuit: event received")
  if (shouldQuitAfterCleanup || !daemonRuntime) {
    teardownTray()
    debugLog("handleBeforeQuit: skipped")
    return
  }

  const beforeQuitEvent = event as BeforeQuitEvent
  beforeQuitEvent.response = { allow: false }
  shouldQuitAfterCleanup = true
  clearTrayRefreshTimer()

  void stopDaemonRuntime().finally(() => {
    debugLog("handleBeforeQuit: cleanup complete, quitting")
    teardownTray()
    Utils.quit()
  })
}

async function startDesktopShell() {
  debugLog("startDesktopShell: begin")
  daemonRuntime = await resolveDesktopDaemonRuntime()
  debugLog(`startDesktopShell: daemon resolved source=${daemonRuntime.source} url=${daemonRuntime.url}`)

  Electrobun.events.on("before-quit", handleBeforeQuit)
  initializeTray()

  const window = await openMainWindow()
  debugLog(`startDesktopShell: window ready id=${window.id}`)

  console.log(`[desktop] Started with UI source: ${window.url ?? "unknown"}`)
  console.log(
    `[desktop] Daemon API URL: ${daemonRuntime.url} (${daemonRuntime.source === "spawned" ? "managed" : "attached"})`
  )
}

async function showDesktopStartupBlockedWindow(error: DesktopDaemonAlreadyRunningError) {
  const window = await createMainWindow()
  window.webview.on("dom-ready", () => {
    debugLog("showDesktopStartupBlockedWindow: dom-ready")
    injectStartupError(window, error)
  })
  console.error("[desktop] Burns is already running", { daemonUrl: error.daemonUrl })
}

startDesktopShell().catch(async (error: unknown) => {
  debugLog(`startDesktopShell: failed ${(error as Error)?.message ?? String(error)}`)
  if (error instanceof DesktopDaemonAlreadyRunningError) {
    await showDesktopStartupBlockedWindow(error)
    return
  }

  const message = error instanceof Error ? error.message : String(error)
  console.error("[desktop] Failed to start desktop shell", error)

  teardownTray()
  await stopDaemonRuntime()

  try {
    await Utils.showMessageBox({
      type: "error",
      title: "Burns failed to start",
      message,
      buttons: ["Close"],
      defaultId: 0,
      cancelId: 0,
    })
  } catch {
    // Ignore secondary dialog errors.
  }

  process.exitCode = 1
  Utils.quit()
})
