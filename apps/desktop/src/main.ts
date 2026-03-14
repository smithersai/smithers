import Electrobun, { BrowserWindow, Utils } from "electrobun/bun"
import { appendFileSync } from "node:fs"

import {
  buildDesktopStartupErrorInitScript,
} from "@burns/shared"

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

type BeforeQuitEvent = {
  response?: {
    allow: boolean
  }
}

let daemonRuntime: DesktopDaemonRuntimeHandle | null = null
let daemonStopPromise: Promise<void> | null = null
let shouldQuitAfterCleanup = false
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

function createMainWindow(sourceUrl: string) {
  const mainWindow = new BrowserWindow({
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
  debugLog(`createMainWindow: window created id=${mainWindow.id}`)

  // Force a visible, focused frame in dev/runtime in case previous window state
  // or multi-display coordinates place it off-screen.
  mainWindow.setFrame(160, 90, 1360, 900)
  debugLog("createMainWindow: setFrame(160, 90, 1360, 900)")
  mainWindow.show()
  debugLog("createMainWindow: show()")
  mainWindow.focus()
  debugLog("createMainWindow: focus()")

  return mainWindow
}

function handleBeforeQuit(event: unknown) {
  debugLog("handleBeforeQuit: event received")
  if (shouldQuitAfterCleanup || !daemonRuntime) {
    debugLog("handleBeforeQuit: skipped")
    return
  }

  const beforeQuitEvent = event as BeforeQuitEvent
  beforeQuitEvent.response = { allow: false }
  shouldQuitAfterCleanup = true

  void stopDaemonRuntime().finally(() => {
    debugLog("handleBeforeQuit: cleanup complete, quitting")
    Utils.quit()
  })
}

async function startDesktopShell() {
  debugLog("startDesktopShell: begin")
  const sourceUrl = await resolveDesktopSourceUrl()
  debugLog(`startDesktopShell: sourceUrl=${sourceUrl}`)
  daemonRuntime = await resolveDesktopDaemonRuntime()
  debugLog(`startDesktopShell: daemon resolved source=${daemonRuntime.source} url=${daemonRuntime.url}`)

  const mainWindow = createMainWindow(sourceUrl)

  mainWindow.webview.on("dom-ready", () => {
    debugLog("mainWindow.webview: dom-ready")
    if (!daemonRuntime) {
      debugLog("mainWindow.webview: dom-ready skipped (no daemon runtime)")
      return
    }

    injectRuntimeConfig(mainWindow, daemonRuntime.url)
  })

  mainWindow.on("close", () => {
    debugLog("mainWindow: close event")
    void stopDaemonRuntime()
  })

  Electrobun.events.on("before-quit", handleBeforeQuit)

  console.log(`[desktop] Started with UI source: ${sourceUrl}`)
  console.log(
    `[desktop] Daemon API URL: ${daemonRuntime.url} (${daemonRuntime.source === "spawned" ? "managed" : "attached"})`
  )
}

async function showDesktopStartupBlockedWindow(error: DesktopDaemonAlreadyRunningError) {
  const sourceUrl = await resolveDesktopSourceUrl()
  debugLog(`showDesktopStartupBlockedWindow: sourceUrl=${sourceUrl}`)
  const mainWindow = createMainWindow(sourceUrl)
  mainWindow.webview.on("dom-ready", () => {
    debugLog("showDesktopStartupBlockedWindow: dom-ready")
    injectStartupError(mainWindow, error)
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
