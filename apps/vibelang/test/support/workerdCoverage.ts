// Stays .ts: Istanbul's untyped CJS packages load through createRequire behind local interfaces, and workerd
// evidence collection is plain CDP over a WebSocket; the VibeLang pipeline imports this from workerd.vibe.
import { createRequire } from "node:module"
import { mkdir, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)

interface Instrumenter {
  instrumentSync(code: string, filename: string, inputSourceMap?: Record<string, unknown>): string
}
interface InstrumentModule {
  createInstrumenter(options: Record<string, unknown>): Instrumenter
}
const { createInstrumenter } = require("istanbul-lib-instrument") as InstrumentModule
interface CoverageMap { files(): string[]; fileCoverageFor(file: string): { toJSON(): Record<string, unknown> } }
const libCoverage = require("istanbul-lib-coverage") as { createCoverageMap(data?: Record<string, unknown>): CoverageMap }
const libSourceMaps = require("istanbul-lib-source-maps") as {
  createSourceMapStore(): { transformCoverage(map: CoverageMap): Promise<CoverageMap> }
}

interface LoadArgs { readonly path: string }
interface LoadResult { readonly contents?: string | Uint8Array }
interface PluginBuild { onLoad(options: unknown, callback: (args: LoadArgs) => unknown): void }
interface EsbuildPlugin { readonly name: string; setup(build: never): unknown }

const inlineMap = /\n\/\/# sourceMappingURL=data:application\/json;charset=utf-8;base64,([A-Za-z0-9+/=]+)\s*$/

/**
 * Wraps the VibeLang esbuild plugin so each compiled module that `instrumented` selects carries Istanbul counters
 * before bundling. The counters are in the compiler's own output coordinates, with the compiler's source map as
 * their input map: the same output and map Vitest's V8 remap reads in Node, so both runtimes locate a statement at
 * the same source range and the merge gate can credit workerd execution by exact location. Instrumenting the
 * finished bundle instead remapped through esbuild's map, which moved statement starts (`Effect.runSync` to
 * `runSync`) and lost every workerd hit in a file Node also loaded. workerd's inspector disables the Profiler
 * domain, so Vitest's V8 collection cannot see worker execution; these counters are the execution evidence (0017).
 */
export function instrumentModules<P extends EsbuildPlugin>(plugin: P, instrumented: (path: string) => boolean): P {
  const instrumenter = createInstrumenter({ esModules: true, coverageGlobalScope: "globalThis", coverageGlobalScopeFunc: false })
  return {
    ...plugin,
    setup: (build: PluginBuild) => plugin.setup({
      ...build,
      onLoad: (options: unknown, callback: (args: LoadArgs) => unknown) => build.onLoad(options, async (args) => {
        const result = await callback(args) as LoadResult | undefined
        if (result === undefined || typeof result.contents !== "string" || !instrumented(args.path)) return result
        const map = inlineMap.exec(result.contents)
        // Without the compiler's map the counters would sit at output lines and credit the wrong source.
        if (map === null) throw new Error(`workerd coverage: ${args.path} compiled without a source map`)
        const code = result.contents.slice(0, map.index)
        const sourceMap = JSON.parse(Buffer.from(map[1]!, "base64").toString("utf8")) as Record<string, unknown>
        // Map sources are URLs (ECMA-426) and the plugin writes absolute ones as file: URLs; Istanbul joins each
        // source to the map's directory as a path, so it needs the path the merge gate filters on.
        if (Array.isArray(sourceMap["sources"])) {
          sourceMap["sources"] = (sourceMap["sources"] as unknown[]).map((source) =>
            typeof source === "string" && source.startsWith("file:") ? fileURLToPath(source) : source)
        }
        return { ...result, contents: instrumenter.instrumentSync(code, args.path, sourceMap) }
      }),
    } as never),
  }
}

/** A dump's counters remapped to source through each module's own compiler map. */
export async function sourceCoverage(coverage: Record<string, unknown>): Promise<CoverageMap> {
  return libSourceMaps.createSourceMapStore().transformCoverage(libCoverage.createCoverageMap(coverage))
}

interface InspectorTarget {
  readonly title: string
  readonly webSocketDebuggerUrl: string
}

/**
 * Reads the user isolate's accumulated `globalThis.__coverage__` (each module's counters carry their own input
 * source map) and writes it into directory. Throws when the worker has no counters: a dump that records nothing would silently under-report.
 */
export async function dumpWorkerdCoverage(
  worker: { getInspectorURL(): Promise<URL> },
  name: string,
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
    await writeFile(`${directory}/${name}-${Date.now()}.json`, JSON.stringify({ coverage }) + "\n")
  } finally {
    socket.close()
  }
}
