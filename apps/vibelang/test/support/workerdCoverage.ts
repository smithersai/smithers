// Stays .ts: Istanbul's untyped CJS packages load through createRequire behind local interfaces, and workerd
// evidence collection is plain CDP over a WebSocket; the VibeLang pipeline imports this from workerd.vibe.
import { createRequire } from "node:module"
import { mkdir, writeFile } from "node:fs/promises"

const require = createRequire(import.meta.url)

interface Instrumenter {
  instrumentSync(code: string, filename: string): string
}
interface InstrumentModule {
  createInstrumenter(options: Record<string, unknown>): Instrumenter
}
const { createInstrumenter } = require("istanbul-lib-instrument") as InstrumentModule

/** The workerd bundle's fixed virtual name, shared by instrumentation, collection and the merge gate. */
export const bundleFilename = "/bundle/worker.js"

/**
 * Adds statement/branch/function counters to the bundle workerd runs. The counters' location maps stay in bundle
 * coordinates (the instrumenter's input-file coordinates), so the bundler's own map remaps them to source in one
 * step at the gate. workerd's inspector disables the Profiler domain, so Vitest's V8 collection cannot see worker
 * execution; these counters are the execution evidence (0017).
 */
export function instrumentBundle(code: string): string {
  const instrumenter = createInstrumenter({
    esModules: true, coverageGlobalScope: "globalThis", coverageGlobalScopeFunc: false,
  })
  return instrumenter.instrumentSync(code, bundleFilename)
}

interface InspectorTarget {
  readonly title: string
  readonly webSocketDebuggerUrl: string
}

/**
 * Reads the user isolate's accumulated `globalThis.__coverage__` and writes it with the bundle's source map into
 * directory. Throws when the worker has no counters: a dump that records nothing would silently under-report.
 */
export async function dumpWorkerdCoverage(
  worker: { getInspectorURL(): Promise<URL> },
  name: string,
  bundleMap: Record<string, unknown>,
  directory: string,
): Promise<void> {
  const inspector = await worker.getInspectorURL()
  inspector.protocol = "http:"
  const listing = await fetch(new URL("/json/list", inspector))
  const targets = await listing.json() as ReadonlyArray<InspectorTarget>
  const target = targets.find((candidate) => candidate.title.includes(`core:user:${name}`))
  if (target === undefined) throw new Error(`workerd coverage: no inspector target for ${name}`)
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onerror = () => reject(new Error("workerd coverage: inspector socket failed"))
  })
  let next = 0
  let contextId: number | undefined
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { method?: string; params?: { context: { id: number } } }
    if (message.method === "Runtime.executionContextCreated") contextId = message.params!.context.id
  })
  const request = <T>(method: string, params: Record<string, unknown> = {}) => new Promise<T>((resolve, reject) => {
    const id = ++next
    const timer = setTimeout(() => reject(new Error(`workerd coverage: timeout ${method}`)), 15000)
    const listener = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: T; error?: unknown }
      if (message.id !== id) return
      socket.removeEventListener("message", listener)
      clearTimeout(timer)
      if (message.error !== undefined) reject(new Error(`workerd coverage: ${method}: ${JSON.stringify(message.error)}`))
      else resolve(message.result as T)
    }
    socket.addEventListener("message", listener)
    socket.send(JSON.stringify({ id, method, params }))
  })
  try {
    await request("Runtime.enable")
    const deadline = Date.now() + 5000
    while (contextId === undefined) {
      if (Date.now() > deadline) throw new Error("workerd coverage: no execution context reported")
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const snapshot = await request<{ result: { value?: string } }>("Runtime.evaluate", {
      contextId, expression: "JSON.stringify(globalThis.__coverage__ ?? null)", returnByValue: true,
    })
    const coverage: unknown = JSON.parse(snapshot.result.value ?? "null")
    if (coverage === null) throw new Error(`workerd coverage: ${name} has no counters`)
    await mkdir(directory, { recursive: true })
    await writeFile(`${directory}/${name}-${Date.now()}.json`, JSON.stringify({ coverage, bundleMap }) + "\n")
  } finally {
    socket.close()
  }
}
