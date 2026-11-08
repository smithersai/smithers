/** B12: a bundled registry and an external module survive a real host restart. */
import { build } from "esbuild"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { expect, it } from "vitest"

// Receipts use real files outside the engine so killing a host cannot erase evidence.
// The fixture is an authored module; the parent test alone sends OS signals.
const moduleSource = String.raw`
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Schema } from "effect"
import { appendFileSync, existsSync } from "node:fs"
const A = Action.make("triage/A", { payload: {}, success: Schema.String })
const B = Action.make("triage/B", { payload: { value: Schema.String }, success: Schema.String })
export const layer = Layer.mergeAll(
  A.toLayer(() => Effect.sync(() => {
    appendFileSync("effects.log", "A\n")
    return "first"
  })),
  B.toLayer(({ value }) => Effect.gen(function*() {
    yield* Effect.sync(() => {
      appendFileSync("effects.log", "B\n")
      console.log("EFFECT=B")
    })
    if (!(yield* Effect.sync(() => existsSync("resume")))) yield* Effect.never
    yield* Effect.sync(() => appendFileSync("final.log", value + "\n"))
    return value
  }))
)
export default Flow.make("triage", {
  description: "Proves a module can resume through a bundled registry.",
  payload: {}, success: Schema.String,
  body: Node.capture({}, () => A.call({}).pipe(
    Node.bindPlanned(Node.capture({}, (value) => B.call({ value })))
  ))
})
`

const runnerSource = `
import { Executable, ModuleFlow, Graph } from "./loader.mjs"
import { Action, Graph as ExternalGraph } from "@smthrs/flow"
import { NodeRuntime } from "@smthrs/platform-node"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Effect, FileSystem, Layer, Option } from "effect"
import { resolve } from "node:path"
if (Graph.build === ExternalGraph.build) throw new Error("expected independent package copies")
const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)
const host = NodeRuntime.layerHost({
  filename: resolve("engine.db"), workspaceRoot: process.cwd(), owner: { hostId: "triage" }
}, Layer.empty)
const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = resolve("flow.ts")
  const text = yield* fs.readFileString(path)
  const descriptor = Option.getOrThrow(ModuleFlow.fromModule({
    text, path, naming: "path", name: Option.some("triage"), dirBasename: "triage",
    provenance: { source: "project", root: process.cwd() }
  }).descriptor)
  const executable = yield* Executable.fromDescriptor(descriptor, { delegates: [] })
  const graph = ExternalGraph.build(executable.flow, { input: {} })
  console.log("SITES=" + JSON.stringify(ExternalGraph.nodes(graph)
    .filter((node) => node.kind === "ActionCall").map((node) => node.declaredAt)))
  const result = yield* executable.flow.execute({ input: {} }, { executionId: "triage-1" }).pipe(
    Effect.provide(executable.layer)
  )
  console.log("RESULT=" + JSON.stringify(result))
}).pipe(Effect.provide(platform), Effect.provide(Action.layerImplementations), Effect.provide(host), Effect.scoped)
await Effect.runPromise(program)
`

const start = (directory: string) => {
  const child = spawn(process.execPath, [join(directory, "runner.mjs")], {
    cwd: directory,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, SMITHERS_BACKEND: "sqlite", SMITHERS_POSTGRES_URL: "", DATABASE_URL: "" }
  })
  let output = ""
  let errors = ""
  let reached = () => {}
  const inFlight = new Promise<void>((resolve) => {
    reached = resolve
  })
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk
    if (output.includes("EFFECT=B\n")) reached()
  })
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    errors += chunk
  })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code, signal) => resolve({ code, signal }))
  })
  // Kill only this incarnation, before Vitest's test timeout, so the awaits
  // settle and finally can remove the SQLite database and fixture directory.
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 12_000)
  void exited.then(() => clearTimeout(watchdog), () => clearTimeout(watchdog))
  return { child, inFlight, exited, output: () => output, errors: () => errors }
}

type Incarnation = ReturnType<typeof start>
const sites = (child: Incarnation) => {
  const row = child.output().split("\n").find((line) => line.startsWith("SITES="))
  expect(row, child.errors()).toBeDefined()
  return JSON.parse(row!.slice("SITES=".length))
}

it.each(["SIGKILL", "SIGTERM"] as const)(
  "#4268: a bundled loader retains canonical sites and replays A after %s",
  async (signal) => {
    const directory = await mkdtemp(join(import.meta.dirname, ".restart-identity-"))
    let first: Incarnation | undefined
    let second: Incarnation | undefined
    try {
      await build({
        stdin: {
          contents:
            "export { Executable, ModuleFlow } from \"@smthrs/registry\"; export { Graph } from \"@smthrs/flow\";",
          resolveDir: import.meta.dirname
        },
        outfile: join(directory, "loader.mjs"),
        bundle: true,
        format: "esm",
        platform: "node",
        external: ["effect", "effect/*", "@effect/*"],
        banner: { js: "import { createRequire } from \"node:module\"; const require = createRequire(import.meta.url);" }
      })
      await writeFile(join(directory, "flow.ts"), moduleSource)
      await writeFile(join(directory, "runner.mjs"), runnerSource)
      first = start(directory)
      const original = first
      await Promise.race([
        first.inFlight,
        first.exited.then((exit) => {
          throw new Error(`exited before B: ${JSON.stringify(exit)}\n${original.output()}\n${original.errors()}`)
        })
      ])
      expect(sites(first)).toEqual([
        { path: join(directory, "flow.ts"), line: 6 },
        { path: join(directory, "flow.ts"), line: 7 }
      ])
      expect(await readFile(join(directory, "effects.log"), "utf8")).toBe("A\nB\n")
      expect(first.child.kill(signal)).toBe(true)
      const killed = await first.exited
      if (signal === "SIGKILL") expect(killed.signal).toBe(signal)
      await writeFile(join(directory, "resume"), "")
      second = start(directory)
      expect((await second.exited).code, second.errors()).toBe(0)
      expect(sites(second)).toEqual(sites(first))
      expect(second.output()).toContain("RESULT=\"first\"")
      expect(await readFile(join(directory, "effects.log"), "utf8")).toBe("A\nB\nB\n")
      expect(await readFile(join(directory, "final.log"), "utf8")).toBe("first\n")
    } finally {
      first?.child.kill("SIGKILL")
      second?.child.kill("SIGKILL")
      await first?.exited
      await second?.exited
      await rm(directory, { recursive: true, force: true })
    }
  }
)
