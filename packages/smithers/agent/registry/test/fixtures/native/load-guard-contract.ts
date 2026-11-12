/** Actual host loader under the load guard; no Vitest module interception. */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Effect, FileSystem, Layer } from "effect"
import * as Executable from "../../../src/Executable.ts"
import * as NodeLoadGuard from "../../../src/node/NodeLoadGuard.ts"
import * as Registry from "../../../src/Registry.ts"

const [root, target] = process.argv.slice(2) as [string, string]

interface Tool {
  readonly version: (target: string) => string
  readonly beside: (specifier: string) => unknown
  readonly from: (parent: string, specifier: string) => unknown
}

const load = (name: string) =>
  Effect.gen(function*() {
    const registry = yield* Registry.Registry
    return yield* Effect.result(Executable.fromDescriptor(yield* registry.get(name), { delegates: [] }))
  }).pipe(
    Effect.map((result) =>
      result._tag === "Failure" ? { code: result.failure.code, message: result.failure.message } : { loaded: true }
    )
  )

/** What a load the flow makes while it runs came to. */
const attempt = (run: () => unknown) => {
  try {
    return { value: run() }
  } catch (cause) {
    const refused = cause as { readonly _tag?: string; readonly path?: string; readonly root?: string }
    return { refused: refused._tag, path: refused.path, root: refused.root }
  }
}

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const held = yield* load("held")
  const tool = Reflect.get(globalThis, "issue4718/held") as Tool | undefined
  const runs = tool === undefined ? undefined : {
    version: attempt(() => tool.version(target)),
    unmeasured: attempt(() => tool.beside("./unmeasured.cjs")),
    original: attempt(() => tool.beside("./measured.cjs")),
    dotdot: attempt(() => tool.from(`${target}/package.json`, `${root}/target/../.smithers/flows/held/unmeasured.cjs`)),
    config: attempt(() => tool.from(`${root}/package.json`, "./bundler.config.cjs"))
  }
  // Its measured copies are written under the root the guard now holds.
  const plain = yield* load("plain")
  const linked = yield* load("linked")
  return {
    held,
    runs,
    plain,
    plainValue: Reflect.get(globalThis, "issue4718/plain"),
    linked,
    linkedEvaluated: Reflect.get(globalThis, "issue4718/linked") !== undefined,
    leftovers: (yield* fs.readDirectory(`${root}/.smithers/flows`, { recursive: true })).filter((name) =>
      name.includes("smithers-")
    )
  }
})

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeLoadGuard.layer)
const result = await Effect.runPromise(program.pipe(
  Effect.provide(Registry.layerProject({ root }).pipe(Layer.provideMerge(platform)))
))
process.stdout.write(JSON.stringify(result))
