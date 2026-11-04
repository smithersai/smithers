import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { expect, it } from "@effect/vitest"
import { FlowEngine } from "@smthrs/engine"
import { Action } from "@smthrs/flow"
import { Effect, FileSystem, Layer } from "effect"
import { fileURLToPath } from "node:url"
import * as Executable from "../src/Executable.ts"
import * as Registry from "../src/Registry.ts"

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer)
const modules = fileURLToPath(new URL("./fixtures/executable/modules", import.meta.url))
const declaration = (name: string, marker: string, collaborators: string[] = []) => `
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { appendFileSync } from "node:fs"
appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(name + "\n")})
export default Flow.make(${JSON.stringify(name)}, {
  description: "A measured module", capabilities: ["fs:write:**"], flows: ${JSON.stringify(collaborators)},
  payload: {}, success: Schema.String, body: () => Node.succeed(${JSON.stringify(name)})
})
`
const project = (use: (root: string, marker: string) => Effect.Effect<unknown, unknown, Executable.Catalog | Registry.Registry | FileSystem.FileSystem>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ directory: modules, prefix: ".deferred-" })
    const marker = `${root}/loaded.txt`
    for (const name of ["first", "later", "sibling"]) {
      yield* fs.makeDirectory(`${root}/.smithers/flows/${name}`, { recursive: true })
      yield* fs.writeFileString(`${root}/.smithers/flows/${name}/flow.ts`, declaration(name, marker, name === "first" ? ["sibling"] : name === "sibling" ? ["first"] : []))
    }
    return yield* use(root, marker).pipe(Effect.provide(
      Executable.layer({ delegates: [], initialFlows: ["first"] }).pipe(
        Layer.provideMerge(Registry.layerProject({ root })),
        Layer.provideMerge(Layer.merge(FlowEngine.layerMemory, Action.layerImplementations))
      )
    ))
  }).pipe(Effect.scoped, Effect.provide(platform))

it.effect("loads selected bodies and cyclic collaborators, then loads a measured deferred body once", () => project((_root, marker) => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const catalog = yield* Executable.Catalog
  expect(catalog.executables.map((entry) => entry.descriptor.name).sort()).toEqual(["first", "sibling"])
  expect(catalog.deferred?.map((entry) => entry.name)).toEqual(["later"])
  expect(awaitedLines(yield* fs.readFileString(marker))).toEqual(["first", "sibling"])
  const later = yield* catalog.load!("later")
  expect(yield* catalog.load!("later")).toBe(later)
  expect(catalog.deferred).toEqual([])
  expect(awaitedLines(yield* fs.readFileString(marker))).toEqual(["first", "later", "sibling"])
})))

it.effect("refuses changed deferred bytes and does not implicitly adopt a newly discovered body", () => project((root) => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const catalog = yield* Executable.Catalog
  const registry = yield* Registry.Registry
  yield* fs.writeFileString(`${root}/.smithers/flows/later/flow.ts`, declaration("later", `${root}/changed.txt`))
  yield* fs.makeDirectory(`${root}/.smithers/flows/new`, { recursive: true })
  yield* fs.writeFileString(`${root}/.smithers/flows/new/flow.ts`, declaration("new", `${root}/new.txt`))
  yield* registry.refresh()
  expect(yield* Effect.flip(catalog.load!("later"))).toMatchObject({ code: "body_unavailable" })
  expect(yield* Effect.flip(catalog.load!("new"))).toMatchObject({ code: "body_unavailable" })
  expect(yield* fs.exists(`${root}/changed.txt`)).toBe(false)
  expect(yield* fs.exists(`${root}/new.txt`)).toBe(false)
})))
const awaitedLines = (text: string) => text.trim().split("\n").sort()
