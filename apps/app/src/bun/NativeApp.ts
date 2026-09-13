/*
 * The Electrobun main process (LOCAL-APP.md, "Runtime topology"). The only
 * file that imports the Electrobun SDK: it starts the local origin, then
 * opens one window at it. The origin is the only transport between the SPA
 * and this process; RPC carries just the two native doors (the folder dialog
 * and the system browser). Neither privileged operation has an HTTP fallback.
 */
import type { BrowserWindow as NativeBrowserWindow } from "electrobun/main"
import type { SmithersNativeRPC } from "@smthrs/rpc/NativeRPC"
import { encodeRgbaPng, startPackagedE2EBridge } from "./PackagedE2EBridge"
import { createNativeShutdown } from "./NativeShutdown"
import { defaultDistDir } from "./server"
import { attachLocalDaemon } from "./LocalDaemonClient"
import { daemonBuild } from "./LocalDaemonProtocol"
import { nativeStateDirectory } from "./NativeState"

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

const entrypoint = process.argv[1]!
const server = await attachLocalDaemon({
  port,
  distDir: defaultDistDir(import.meta.dir),
  stateDir,
  chatStub: Bun.env.SMITHERS_CHAT_STUB === "1",
  cloudMode: Bun.env.SMITHERS_LOCAL_MODE === "offline" ? "offline" : "hybrid",
  allowManualRepositoryPaths: headless,
  build: await daemonBuild(entrypoint)
}, { entrypoint })
console.log(`SMITHERS_LOCAL_ORIGIN=${server.origin}`)

let mainWindow: NativeBrowserWindow | undefined
let bridge: ReturnType<typeof startPackagedE2EBridge>
const queuedRepositorySelections: Array<{ readonly path: string | null }> = []
const shutdown = createNativeShutdown({
  stop: async () => {
    bridge?.stop()
    await server.detach()
  },
  quit: (code) => process.exit(code),
  onBeforeQuit: (handler) => { Electrobun.events.on("before-quit", handler) },
  log: (message) => console.error(message)
})

if (headless) {
  console.log("SMITHERS_LOCAL_HEADLESS=1: serving without a window")
} else {
  const rpc = BrowserView.defineRPC<SmithersNativeRPC>({
    handlers: {
      requests: {
        pickLocalRepository: async ({ access }) => {
          const queued = queuedRepositorySelections.shift()
          const selectedPath = queued === undefined
            ? (await Utils.openFileDialog({
              canChooseFiles: false,
              canChooseDirectory: true,
              allowsMultipleSelection: false
            })).find((path) => path.trim() !== "")
            : queued.path ?? undefined
          if (selectedPath === undefined) return { status: "cancelled" } as const
          return server.authorizeRepository(selectedPath, access)
        },
        openExternal: async ({ url }) => ({ opened: await openExternal(url) })
      },
      messages: {}
    }
  })

  // The local origin, never views:// and never a Vite dev server.
  mainWindow = new BrowserWindow({
    title: "Smithers",
    url: `${server.origin}/`,
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
        origin: server.origin,
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
  queueRepositorySelection: (path) => {
    if (queuedRepositorySelections.length > 0) {
      throw new Error("A repository picker answer is already queued.")
    }
    queuedRepositorySelections.push({ path })
  },
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
