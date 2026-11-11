// The API Worker's startup, measured as Cloudflare judges it before accepting a deploy (wiki/decisions/0033-worker-startup.md).
//
//   worker/Api.vibe ──Alchemy's WorkerBundle, the deploy's props──▶ modules ──workerd, V8 profiler──▶ startup CPU
//
// The build is the one `alchemy deploy` uploads: Alchemy's rolldown options (minified), its Cloudflare plugins, the
// Worker's own `build` (vibelang-unplugin, deferred), its compatibility and its Effect entry with the Durable Object
// bridges. The measurement is `wrangler check startup`'s: a probe entry imports the main module inside a request while
// the inspector's profiler runs, and the active (non-idle) sampled time is the startup cost. Profiled time is wall time
// between samples, so it also counts time workerd waits for a CPU: on Linux the sample also reads workerd's own CPU time
// from /proc, which a loaded host does not inflate (nyc-01 at load 250: profiled 574-876 ms for a ~150 ms startup).
// TypeScript, not VibeLang: the inspector's WebSocket and the module bytes are platform glue (test/support/workerdCoverage.ts).
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import { readdirSync, readFileSync } from "node:fs"
import { Miniflare } from "miniflare"
import { getCompatibility } from "@alchemy.run/cloudflare/Workers/Compatibility"
import { WorkerBundle } from "@alchemy.run/cloudflare/Workers/Sources/Rolldown"
import { props } from "../../worker/Api.vibe"

/** One uploaded module of the built Worker, entry first. */
export interface StartupModule { readonly name: string; readonly type: "esm" | "wasm"; readonly contents: string | Uint8Array; readonly bytes: number }
/** The deployed build: its modules and the compatibility it runs with. */
export interface DeployBuild { readonly modules: ReadonlyArray<StartupModule>; readonly compatibility: { readonly date: string; readonly flags: ReadonlyArray<string> } }

/** The API Worker's Durable Object classes, which the deploy's entry bridges (test/workerd/api.vibe). */
const CLASSES = ["Conversation", "Budget", "History", "ProjectAccounts", "ActionIndex"]

/** worker/Api.vibe built as `alchemy deploy` builds it. */
export async function deployBuild(): Promise<DeployBuild> {
  const compatibility = getCompatibility(props as never)
  const program = Effect.flatMap(WorkerBundle, (bundler) => bundler.build({
    id: "VibelangApi", main: props.main, compatibility,
    entry: { kind: "effect", exports: Object.fromEntries(CLASSES.map((name) => [name, { kind: "durableObject" }])) as never },
    stack: { name: "smithers-vibelang", stage: "prod" },
    extraOptions: props.build as never,
  }))
  const output = await Effect.runPromise(Effect.provide(program, NodeServices.layer))
  const modules: Array<StartupModule> = []
  for (const file of output.files) {
    if (file.path.endsWith(".map")) continue
    const bytes = typeof file.content === "string" ? Buffer.byteLength(file.content) : file.content.byteLength
    if (file.path.endsWith(".wasm")) modules.push({ name: file.path, type: "wasm", contents: file.content, bytes })
    else if (/\.m?js$/.test(file.path)) modules.push({ name: file.path, type: "esm", contents: file.content, bytes })
    else throw new Error(`worker startup: unexpected module ${file.path}`)
  }
  return { modules, compatibility }
}

/**
 * One startup: profiled active and garbage-collection milliseconds, workerd's CPU milliseconds where the host reports
 * them (Linux), and whether the main module evaluated.
 */
export interface StartupSample { readonly activeMs: number; readonly gcMs: number; readonly cpuMs: number | undefined; readonly evaluated: boolean }

/** The CPU time, user and system, of this process's workerd children, from /proc; undefined off Linux. */
export function workerdCpuMs(): number | undefined {
  let pids: Array<string>
  try { pids = readdirSync("/proc").filter((name) => /^[0-9]+$/.test(name)) } catch { return undefined }
  let ticks = 0
  for (const pid of pids) {
    let stat: string
    try { stat = readFileSync(`/proc/${pid}/stat`, "utf8") } catch { continue }
    const close = stat.lastIndexOf(")")
    const fields = stat.slice(close + 2).split(" ")
    // Fields after the command: state, ppid, ..., utime (14th of the line) and stime (15th).
    if (stat.slice(stat.indexOf("(") + 1, close) === "workerd" && Number(fields[1]) === process.pid) ticks += Number(fields[11]) + Number(fields[12])
  }
  // USER_HZ is 100 on every Linux the monorepo runs on.
  return ticks * 10
}

/** A probe entry's name no build emits. */
const PROBE = "__vibelang_startup_probe__.js"

/** Starts `build` in a fresh workerd and profiles the evaluation of its main module and static imports. */
export async function startupSample(build: DeployBuild): Promise<StartupSample> {
  const main = build.modules[0]!
  const modules: Record<string, { readonly type: string; readonly contents: string | Uint8Array }> = {
    [PROBE]: { type: "esm", contents: `export default { async fetch() { await import(${JSON.stringify(`./${main.name}`)}); return new Response("evaluated") } }` },
  }
  for (const module of build.modules) modules[module.name] = { type: module.type, contents: module.contents }
  const worker = new Miniflare({ host: "127.0.0.1", port: 0, inspectorPort: 0, workers: [{ config: {
    name: "startup", compatibilityDate: build.compatibility.date, compatibilityFlags: [...build.compatibility.flags],
    manifest: { mainModule: PROBE, modules },
  } }] } as unknown as ConstructorParameters<typeof Miniflare>[0])
  try {
    await worker.ready
    const inspector = new WebSocket(new URL("/core:user:startup", (await worker.getInspectorURL()).href))
    await new Promise((resolve, reject) => { inspector.onopen = resolve; inspector.onerror = reject })
    let next = 0
    const send = (method: string) => new Promise<{ readonly profile?: Profile }>((resolve, reject) => {
      const id = ++next
      const answer = (event: MessageEvent) => {
        const message = JSON.parse(String(event.data)) as { readonly id?: number; readonly result?: { readonly profile?: Profile }; readonly error?: { readonly message: string } }
        if (message.id !== id) return
        inspector.removeEventListener("message", answer)
        if (message.error !== undefined) reject(new Error(`inspector ${method}: ${message.error.message}`))
        else resolve(message.result ?? {})
      }
      inspector.addEventListener("message", answer)
      inspector.send(JSON.stringify({ id, method, params: {} }))
    })
    try {
      await send("Profiler.enable")
      await send("Profiler.start")
      const before = workerdCpuMs()
      const response = await worker.dispatchFetch("https://startup.test/")
      const evaluated = response.status === 200 && (await response.text()) === "evaluated"
      const after = workerdCpuMs()
      const { profile } = await send("Profiler.stop")
      if (profile === undefined) throw new Error("inspector Profiler.stop: no profile")
      return { ...summarize(profile), cpuMs: before === undefined || after === undefined ? undefined : after - before, evaluated }
    } finally {
      inspector.close()
    }
  } finally {
    await worker.dispose()
  }
}

interface Profile {
  readonly nodes: ReadonlyArray<{ readonly id: number; readonly callFrame: { readonly functionName: string } }>
  readonly samples?: ReadonlyArray<number>
  readonly timeDeltas?: ReadonlyArray<number>
}

/** wrangler's summarizeStartupProfile: sampled time less idle samples is the active time. */
export function summarize(profile: Profile): { readonly activeMs: number; readonly gcMs: number } {
  const names = new Map(profile.nodes.map((node) => [node.id, node.callFrame.functionName]))
  let sampled = 0
  let idle = 0
  let gc = 0
  for (const [at, delta] of (profile.timeDeltas ?? []).entries()) {
    sampled += delta
    const name = names.get(profile.samples?.[at] ?? 0)
    if (name === "(idle)") idle += delta
    else if (name === "(garbage collector)") gc += delta
  }
  return { activeMs: (sampled - idle) / 1000, gcMs: gc / 1000 }
}
