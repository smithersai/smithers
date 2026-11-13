// Stays .ts: Istanbul's untyped CJS packages load through createRequire behind local interfaces, and workerd
// evidence collection is plain CDP over a WebSocket; the VibeLang pipeline imports this from workerd.vibe.
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { normalizeEndColumns, type FileCoverageJSON } from "./coverageUnion.ts"

const require = createRequire(import.meta.url)

interface Instrumenter {
  instrumentSync(code: string, filename: string, inputSourceMap?: Record<string, unknown>): string
}
interface InstrumentModule {
  createInstrumenter(options: Record<string, unknown>): Instrumenter
}
const { createInstrumenter } = require("istanbul-lib-instrument") as InstrumentModule
interface CoverageMap {
  files(): string[]
  fileCoverageFor(file: string): { toJSON(): Record<string, unknown> }
  merge(other: CoverageMap | Record<string, unknown>): void
  toJSON(): Record<string, unknown>
}
const libCoverage = require("istanbul-lib-coverage") as { createCoverageMap(data?: Record<string, unknown>): CoverageMap }
const libSourceMaps = require("istanbul-lib-source-maps") as {
  createSourceMapStore(): { transformCoverage(map: CoverageMap): Promise<CoverageMap> }
}

interface LoadArgs { readonly path: string }
interface LoadResult { readonly contents?: string | Uint8Array; readonly errors?: ReadonlyArray<unknown> }
interface PluginBuild { onLoad(options: unknown, callback: (args: LoadArgs) => unknown): void }
interface EsbuildPlugin { readonly name: string; setup(build: never): unknown }

/**
 * The compiler's map with each `file:` source as a path. A map's sources are URLs, and the VibeLang 0.0.13 compiler
 * writes absolute `file://` ones; Istanbul resolves every source as a path beside the module, so a URL would credit
 * `<dir>/file:/<path>` and the merge gate, which filters on the app's directories, would drop the module.
 */
function withPathSources(map: Record<string, unknown>): Record<string, unknown> {
  const sources = map.sources
  if (!Array.isArray(sources)) return map
  return { ...map, sources: sources.map((source: unknown) => typeof source === "string" && source.startsWith("file:") ? fileURLToPath(source) : source) }
}

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
        // A module that did not compile carries the compiler's diagnostics and a stub; esbuild must report them.
        if ((result.errors?.length ?? 0) > 0) return result
        const map = inlineMap.exec(result.contents)
        // Without the compiler's map the counters would sit at output lines and credit the wrong source.
        if (map === null) throw new Error(`workerd coverage: ${args.path} compiled without a source map`)
        const code = result.contents.slice(0, map.index)
        const sourceMap = JSON.parse(Buffer.from(map[1]!, "base64").toString("utf8")) as Record<string, unknown>
        return { ...result, contents: instrumenter.instrumentSync(code, args.path, withPathSources(sourceMap)) }
      }),
    } as never),
  }
}

interface RolldownLoad { readonly code: string; readonly map?: Record<string, unknown> | string | null; readonly moduleType?: string }
type LoadHook = (this: unknown, id: string) => unknown
interface RolldownPlugin { readonly name: string; readonly load?: LoadHook | { readonly handler: LoadHook } }

/**
 * The rolldown form of `instrumentModules`: VibeLang's rolldown plugin answers each `.vibe` module's `load` with its
 * compiled code and compiler map, and a module `instrumented` selects carries counters whose input map is that map.
 * Alchemy builds the API Worker with rolldown (test/workerd/api.vibe).
 */
export function instrumentRolldown<P extends RolldownPlugin>(plugin: P, instrumented: (path: string) => boolean): P {
  const instrumenter = createInstrumenter({ esModules: true, coverageGlobalScope: "globalThis", coverageGlobalScopeFunc: false })
  const original = plugin.load
  if (original === undefined) throw new Error("workerd coverage: the plugin has no load hook")
  const handler = typeof original === "function" ? original : original.handler
  const load: LoadHook = async function (this: unknown, id: string) {
    const result = await handler.call(this, id) as RolldownLoad | null | undefined
    if (result === null || result === undefined || typeof result.code !== "string" || !instrumented(id)) return result
    // Without the compiler's map the counters would sit at output lines and credit the wrong source.
    if (result.map === undefined || result.map === null) throw new Error(`workerd coverage: ${id} compiled without a source map`)
    const sourceMap = typeof result.map === "string" ? JSON.parse(result.map) as Record<string, unknown> : result.map
    return { code: instrumenter.instrumentSync(result.code, id, withPathSources(sourceMap)), moduleType: result.moduleType ?? "js" }
  }
  return { ...plugin, load: typeof original === "function" ? load : { ...original, handler: load } }
}

/** A dump's counters remapped to source through each module's own compiler map. */
export async function sourceCoverage(coverage: Record<string, unknown>): Promise<CoverageMap> {
  return libSourceMaps.createSourceMapStore().transformCoverage(libCoverage.createCoverageMap(coverage))
}

/**
 * Every workerd dump in `directory`, remapped to source and kept to the app's own `.vibe` sources under `appRoot`
 * (`src/`, `worker/`, `infra/`, `scripts/`), with end columns normalized as Vitest's provider writes them. Each
 * module's counters carry the VibeLang compiler's own map, the one Vitest's V8 remap uses, so a statement sits at the
 * same source start in both runtimes (0016, 0017). A missing directory is no evidence.
 */
export async function workerdEvidence(directory: string, appRoot: string): Promise<CoverageMap> {
  const merged = libCoverage.createCoverageMap()
  const names = await readdir(directory).catch((error: { code?: string }) => {
    if (error.code === "ENOENT") return []
    throw error
  })
  const roots = ["src", "worker", "infra", "scripts"].map((root) => `${appRoot}/${root}/`)
  for (const name of names.filter((name) => name.endsWith(".json")).sort()) {
    const dump = JSON.parse(await readFile(`${directory}/${name}`, "utf8")) as { coverage: Record<string, unknown> }
    const sourceLevel = await sourceCoverage(dump.coverage)
    const filtered = libCoverage.createCoverageMap()
    for (const file of sourceLevel.files()) {
      if (!file.endsWith(".vibe") || !roots.some((root) => file.startsWith(root))) continue
      const json = sourceLevel.fileCoverageFor(file).toJSON() as unknown as FileCoverageJSON
      filtered.merge({ [file]: normalizeEndColumns(json, await readFile(file, "utf8")) })
    }
    merged.merge(filtered)
  }
  return merged
}

/** Dumps written by this process, so each file name is unique. */
let dumps = 0

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
  const listing = await fetch(new URL("/json/list", inspector), { signal: AbortSignal.timeout(15000) })
  const targets = await listing.json() as ReadonlyArray<InspectorTarget>
  const target = targets.find((candidate) => candidate.title.includes(`core:user:${name}`))
  if (target === undefined) throw new Error(`workerd coverage: no inspector target for ${name}`)
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer)
        socket.onopen = null
        socket.onerror = null
        socket.onclose = null
        if (error === undefined) resolve()
        else reject(error)
      }
      const timer = setTimeout(() => finish(new Error("workerd coverage: timeout inspector socket open")), 15000)
      socket.onopen = () => finish()
      socket.onerror = () => finish(new Error("workerd coverage: inspector socket failed"))
      socket.onclose = () => finish(new Error("workerd coverage: inspector socket closed before opening"))
    })
    let next = 0
    let contextId: number | undefined
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { method?: string; params?: { context: { id: number } } }
      if (message.method === "Runtime.executionContextCreated") contextId = message.params!.context.id
    })
    const request = <T>(method: string, params: Record<string, unknown> = {}) => new Promise<T>((resolve, reject) => {
      const id = ++next
      const finish = (error?: Error, result?: T) => {
        clearTimeout(timer)
        socket.removeEventListener("message", listener)
        socket.removeEventListener("close", closed)
        socket.removeEventListener("error", closed)
        if (error !== undefined) reject(error)
        else resolve(result as T)
      }
      const listener = (event: MessageEvent) => {
        const message = JSON.parse(String(event.data)) as { id?: number; result?: T; error?: unknown }
        if (message.id !== id) return
        if (message.error !== undefined) finish(new Error(`workerd coverage: ${method}: ${JSON.stringify(message.error)}`))
        else finish(undefined, message.result)
      }
      const closed = () => finish(new Error(`workerd coverage: inspector socket closed during ${method}`))
      const timer = setTimeout(() => finish(new Error(`workerd coverage: timeout ${method}`)), 15000)
      socket.addEventListener("message", listener)
      socket.addEventListener("close", closed)
      socket.addEventListener("error", closed)
      if (socket.readyState !== WebSocket.OPEN) closed()
      else {
        try {
          socket.send(JSON.stringify({ id, method, params }))
        } catch (cause) {
          finish(new Error(`workerd coverage: inspector socket failed during ${method}`, { cause }))
        }
      }
    })
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
    // Unique per process and dump: two suite workers, or a reload and a dispose, can stop the same worker name in one millisecond.
    await writeFile(`${directory}/${name}-${process.pid}-${Date.now()}-${++dumps}.json`, JSON.stringify({ coverage }) + "\n")
  } finally {
    socket.close()
  }
}
