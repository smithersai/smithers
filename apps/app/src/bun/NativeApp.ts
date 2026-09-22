/*
 * The Electrobun main process (LOCAL-APP.md, "Runtime topology"). The only
 * file that imports the Electrobun SDK. The packaging supervisor supplies the
 * shared Go backend origin; this process opens one window and exposes only
 * platform transport/configuration doors. Product behavior stays in the
 * common backend and browser application.
 */
import type { BrowserWindow as NativeBrowserWindow } from "electrobun/main"
import type { SmithersNativeRPC } from "@smthrs/rpc/NativeRPC"
import { encodeRgbaPng, startPackagedE2EBridge } from "./PackagedE2EBridge"
import { nativeBackendConfig } from "./NativeBackendConfig"
import { startNativeBackend } from "./NativeBackendProcess"
import { createNativeShutdown } from "./NativeShutdown"
import { defaultDistDir, startLocalServer } from "./server"
import { nativeStateDirectory } from "./NativeState"
import { startNativePlueServer } from "./NativePlueServer"

// This must stay dynamic: Bun hoists external static imports even from lazy
// local modules. A daemon must never dlopen/initialize Electrobun's native SDK.
const { default: Electrobun, BrowserView, BrowserWindow, BuildConfig, Screen, Utils } = await import("electrobun/main")

const headless = Bun.env.SMITHERS_LOCAL_HEADLESS === "1"
const port = Bun.env.SMITHERS_LOCAL_PORT === undefined ? undefined : Number(Bun.env.SMITHERS_LOCAL_PORT)

/** http(s) only: the page must not launch arbitrary local schemes through the privileged side. */
const openExternal = async (url: string): Promise<boolean> => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false
  return Utils.openExternal(parsed.toString())
}

/** Application state that outlives a launch: macOS Application Support, else XDG data. */
const stateDir = nativeStateDirectory()

/*
 * The packaged E2E tier (e2e/packaged/PackagedApp.ts) spawns the BUILT app
 * and asserts `stub: <message>` in its transcript, so the deterministic agent
 * has to be inside this bundle; there is no seam to inject one through once
 * the binary is spawned. It is reached only behind SMITHERS_CHAT_STUB, and
 * it lives in the test tree with the tier that owns it.
 */
const stubAgent = Bun.env.SMITHERS_CHAT_STUB === "1"
  ? (await import("../../e2e/support/ChatStub")).createChatStub
  : undefined

if (stubAgent === undefined && (Bun.env.SMITHERS_WEB_ROOT?.trim() ?? "") === "") {
  Bun.env.SMITHERS_WEB_ROOT = defaultDistDir(import.meta.dir)
}
const backendProcess = stubAgent === undefined
  ? await startNativeBackend({ stateDir })
  : undefined
const plueServer = backendProcess?.mode === "plue"
  ? startNativePlueServer(defaultDistDir(import.meta.dir), Bun.env.SMITHERS_API_ORIGIN ?? "")
  : undefined

// The retired Bun product host survives only as the deterministic packaged
// test fixture. Production receives the actual shared Go backend origin from
// the issue12 supervisor, or connects directly to Plue.
const testServer = stubAgent === undefined ? undefined : await startLocalServer({
  ...(port === undefined ? {} : { port }),
  distDir: defaultDistDir(import.meta.dir),
  stateDir,
  agent: stubAgent,
  cloudMode: "offline"
})
const backend = await (async () => {
  try {
    return testServer === undefined
      ? nativeBackendConfig(plueServer === undefined ? Bun.env : {
          SMITHERS_API_ORIGIN: plueServer.origin,
          SMITHERS_RENDERER_ORIGIN: plueServer.origin,
          SMITHERS_API_TOKEN: Bun.env.SMITHERS_API_TOKEN
        }, backendProcess!)
      : {
        rendererOrigin: testServer.origin,
        target: {
          apiVersion: 1,
          mode: "native-own",
          apiOrigin: testServer.origin,
          auth: { kind: "session" },
          cors: "same-origin",
          developerExternal: false
        } as const,
        token: null,
        bootstrapToken: null
      }
  } catch (error) {
    plueServer?.stop()
    await backendProcess?.stop()
    throw error
  }
})()

let mainWindow: NativeBrowserWindow | undefined
let bridge: ReturnType<typeof startPackagedE2EBridge>
let backendFailure: Error | undefined
const shutdown = createNativeShutdown({
  stop: async () => {
    bridge?.stop()
    plueServer?.stop()
    const results = await Promise.allSettled([
      testServer?.stop() ?? Promise.resolve(),
      backendProcess?.stop() ?? Promise.resolve()
    ])
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
    if (backendFailure !== undefined) failures.push(backendFailure)
    if (failures.length > 0) throw new AggregateError(failures, "Native runtime shutdown failed.")
  },
  quit: (code) => process.exit(code),
  onBeforeQuit: (handler) => { Electrobun.events.on("before-quit", handler) },
  log: (message) => console.error(message)
})
void backendProcess?.failure?.then((failure) => {
  if (failure === undefined) return
  backendFailure = failure
  console.error(failure.message)
  void shutdown()
})

if (headless) {
  console.log("SMITHERS_LOCAL_HEADLESS=1: serving without a window")
} else {
  const rpc = BrowserView.defineRPC<SmithersNativeRPC>({
    handlers: {
      requests: {
        openExternal: async ({ url }) => ({ opened: await openExternal(url) }),
        applicationTarget: async () => ({ target: backend.target }),
        applicationToken: async () => ({ token: backend.token }),
        applicationBootstrapToken: async () => ({ token: backend.bootstrapToken })
      },
      messages: {}
    }
  })

  // The local origin, never views:// and never a Vite dev server.
  mainWindow = new BrowserWindow({
    title: "Smithers",
    url: `${backend.rendererOrigin}/`,
    rpc,
    frame: {
      width: 1180,
      height: 800,
      x: 100,
      y: 60
    }
  })
}

interface RendererEvalResponse {
  readonly ok: boolean
  readonly json?: string
  readonly valueUndefined?: boolean
  readonly error?: string
}

interface RendererEvalRPC {
  readonly requestProxy?: {
    readonly evaluateJavascriptWithResponse: (
      params: { readonly script: string }
    ) => Promise<unknown>
  }
}

const evaluateInMainWindow = async (script: string): Promise<unknown> => {
  const window = mainWindow
  if (window === undefined) throw new Error("The main WebView is not available.")
  // WKWebView may defer animation-driven rendering while another application
  // is frontmost. Packaged E2E assertions and captures must observe this app,
  // not whichever window happened to have focus when the runner launched it.
  await window.activate()
  await Bun.sleep(50)
  const rpc = window.webview.rpc as RendererEvalRPC | undefined
  const evaluator = rpc?.requestProxy?.evaluateJavascriptWithResponse
  if (evaluator === undefined) throw new Error("The main WebView is not available.")
  const response = await evaluator({
    script: `
return (async () => {
  try {
    const value = await (async () => {
${script}
    })()
    const serialized = JSON.stringify(value)
    if (serialized === undefined && value !== undefined) {
      throw new Error("The evaluation result is not JSON-serializable.")
    }
    return { ok: true, json: serialized ?? "null", valueUndefined: value === undefined }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
})()
`
  })
  if (typeof response !== "object" || response === null || !("ok" in response)) {
    throw new Error(`Renderer evaluation failed: ${String(response)}`)
  }
  const result = response as RendererEvalResponse
  if (!result.ok) throw new Error(result.error ?? "Renderer evaluation failed.")
  if (result.valueUndefined === true) return undefined
  if (typeof result.json !== "string") throw new Error("Renderer evaluation returned no serialized value.")
  return JSON.parse(result.json)
}

bridge = startPackagedE2EBridge({
  state: () => {
    const build = BuildConfig.getSync()
    const window = mainWindow
    return {
      app: {
        pid: process.pid,
        origin: backend.rendererOrigin,
        packaged: build.isPackaged,
        channel: build.channel,
        defaultRenderer: build.defaultRenderer
      },
      window: window === undefined ? null : {
        id: window.id,
        webviewId: window.webviewId,
        renderer: window.renderer,
        url: window.url,
        frame: window.getFrame()
      }
    }
  },
  evaluate: evaluateInMainWindow,
  screenshot: async () => {
    const window = mainWindow
    if (window === undefined) return null
    await window.activate()
    await Bun.sleep(100)
    const frame = window.getFrame()
    if (frame === undefined) return null
    const width = Math.round(frame.width)
    const height = Math.round(frame.height)
    const pixels = Screen.captureRegion({ x: frame.x, y: frame.y, width, height })
    return pixels === null ? null : encodeRgbaPng(width, height, pixels)
  },
  quit: shutdown
})

process.on("SIGINT", () => void shutdown())
process.on("SIGTERM", () => void shutdown())

console.log("Smithers app started!")
