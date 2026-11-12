/**
 * A flow that computes the target of a load (#4718) runs only where the host
 * checks loads at run time, and is then held to its source root: code of the
 * repository it works on loads, an unmeasured file beside the flow does not.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import { fileURLToPath } from "node:url"
import * as Descriptor from "../src/Descriptor.ts"
import * as Executable from "../src/Executable.ts"
import * as Snapshot from "../src/ExecutionSnapshot.ts"
import * as LoadGuard from "../src/LoadGuard.ts"
import * as NodeLoadGuard from "../src/node/NodeLoadGuard.ts"
import * as Registry from "../src/Registry.ts"

const modulesRoot = fileURLToPath(new URL("./fixtures/executable/modules", import.meta.url))
const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer)
const guardedPlatform = Layer.merge(platform, NodeLoadGuard.layer)

/** The loader of the issue's reproduction, and a second one aimed beside the flow. */
const tool = `import { createRequire } from "node:module"
import { join } from "node:path"
// The repository the flow works on brings its own TypeScript.
export const version = (target) => createRequire(join(target, "package.json"))("typescript").version
export const beside = (specifier) => createRequire(import.meta.url)(specifier)
export const from = (parent, specifier) => createRequire(parent)(specifier)
`

const flow = (name: string, prelude: string) =>
  `import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
${prelude}
export default Flow.make("${name}", {
  description: "Loads code by a path it computes", payload: {}, success: Schema.String,
  body: () => Node.succeed("loaded")
})
`

/** Hands the loaded tool to the test, the way an action handler would reach it. */
const exposed = (name: string) => `import * as tool from "./tool.mjs"\nReflect.set(globalThis, "${name}", tool)`

interface Tool {
  readonly version: (target: string) => string
  readonly beside: (specifier: string) => unknown
  readonly from: (parent: string, specifier: string) => unknown
}

const target = {
  "target/package.json": JSON.stringify({ name: "target" }),
  "target/node_modules/typescript/package.json": JSON.stringify({ main: "index.js" }),
  "target/node_modules/typescript/index.js": `exports.version = "9.9.9-target"`
}

const project = (files: Readonly<Record<string, string>>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ directory: modulesRoot, prefix: ".guard-" }))
    for (const [name, contents] of Object.entries(files)) {
      const file = `${root}/${name}`
      yield* fs.makeDirectory(file.slice(0, file.lastIndexOf("/")), { recursive: true })
      yield* fs.writeFileString(file, contents)
    }
    return root
  })

const descriptorIn = (root: string, name: string) =>
  Effect.gen(function*() {
    const registry = yield* Registry.Registry
    return yield* registry.get(name)
  }).pipe(Effect.provide(Registry.layerProject({ root })))

const computed = (descriptor: Descriptor.FlowDescriptor) =>
  descriptor.body._tag === "Module" ? (descriptor.body.imports ?? []).filter((entry) => entry.computed === true) : []

const thrown = (run: () => unknown): unknown => {
  try {
    run()
    return undefined
  } catch (cause) {
    return cause
  }
}

describe("Executable under a load guard", () => {
  it.effect("runs the reproduction: a flow loads the TypeScript of the repository it works on", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* project({
        ...target,
        ".smithers/flows/load/flow.ts": flow("load", exposed("issue4718/load")),
        ".smithers/flows/load/tool.mjs": tool
      })
      const descriptor = yield* descriptorIn(root, "load")
      expect(computed(descriptor).map((entry) => entry.path)).toEqual([
        "\"tool.mjs\" computes the target of 5 import() or require() call(s)"
      ])
      yield* Executable.fromDescriptor(descriptor, { delegates: [] })
      const loaded = Reflect.get(globalThis, "issue4718/load") as Tool
      expect(loaded.version(`${root}/target`)).toBe("9.9.9-target")
      expect((yield* fs.readDirectory(`${root}/.smithers/flows/load`)).sort()).toEqual(["flow.ts", "tool.mjs"])
    }).pipe(Effect.scoped, Effect.provide(guardedPlatform)))

  it.effect("refuses, at run time and by name, every unmeasured file inside the flow source root", () =>
    Effect.gen(function*() {
      const root = yield* project({
        ...target,
        "bundler.config.cjs": `module.exports = "the repository's own configuration"`,
        ".smithers/flows/held/flow.ts": flow("held", `import "./measured.cjs"\n${exposed("issue4718/held")}`),
        ".smithers/flows/held/tool.mjs": tool,
        ".smithers/flows/held/measured.cjs": `module.exports = "measured"`,
        ".smithers/flows/held/unmeasured.cjs": `module.exports = "unmeasured"`,
        ".smithers/flows/other/helper.cjs": `module.exports = "another flow's helper"`
      })
      const sourceRoot = `${root}/.smithers/flows`
      yield* Executable.fromDescriptor(yield* descriptorIn(root, "held"), { delegates: [] })
      const loaded = Reflect.get(globalThis, "issue4718/held") as Tool
      const refused = (run: () => unknown, file: string) => {
        const cause = thrown(run)
        expect(cause).toBeInstanceOf(LoadGuard.UnmeasuredLoadError)
        expect(cause).toMatchObject({ path: file, root: sourceRoot })
      }
      refused(() => loaded.beside("./unmeasured.cjs"), `${sourceRoot}/held/unmeasured.cjs`)
      refused(() => loaded.beside("../other/helper.cjs"), `${sourceRoot}/other/helper.cjs`)
      // Named from the target repository, by a path that leads back inside.
      refused(
        () => loaded.from(`${root}/target/package.json`, "../.smithers/flows/held/unmeasured.cjs"),
        `${sourceRoot}/held/unmeasured.cjs`
      )
      // A measured module runs as its measured copy; its live file is not that copy.
      refused(() => loaded.beside("./measured.cjs"), `${sourceRoot}/held/measured.cjs`)
      // The repository the flow lives in is code it may work on too.
      expect(loaded.from(`${root}/package.json`, "./bundler.config.cjs")).toBe("the repository's own configuration")
      expect(loaded.version(`${root}/target`)).toBe("9.9.9-target")
    }).pipe(Effect.scoped, Effect.provide(guardedPlatform)))

  it.effect("loads a measured helper outside the source root that requires a package while it is imported", () =>
    Effect.gen(function*() {
      // The shape that refused the release flow (#4594): a repository script the
      // flow imports reads its dependencies through createRequire.
      const root = yield* project({
        "node_modules/members/package.json": JSON.stringify({ main: "index.js" }),
        "node_modules/members/index.js": `exports.parse = () => ["packages/*"]`,
        "scripts/workspace-packages.mjs":
          `import { createRequire } from "node:module"\nexport const members = createRequire(import.meta.url)("members").parse()`,
        ".smithers/flows/release/flow.ts": flow(
          "release",
          `import { members } from "../../../scripts/workspace-packages.mjs"\nReflect.set(globalThis, "issue4718/release", members)`
        )
      })
      const descriptor = yield* descriptorIn(root, "release")
      expect(computed(descriptor).map((entry) => entry.path)).toEqual([
        "\"../../../scripts/workspace-packages.mjs\" computes the target of 3 import() or require() call(s)"
      ])
      yield* Executable.fromDescriptor(descriptor, { delegates: [] })
      expect(Reflect.get(globalThis, "issue4718/release")).toEqual(["packages/*"])
    }).pipe(Effect.scoped, Effect.provide(guardedPlatform)))

  it.effect("fails the load when the flow loads an unmeasured file while it is imported", () =>
    Effect.gen(function*() {
      const root = yield* project({
        ".smithers/flows/eager/flow.ts": flow(
          "eager",
          `import { createRequire } from "node:module"\nexport const early = createRequire(import.meta.url)("./unmeasured.cjs")`
        ),
        ".smithers/flows/eager/unmeasured.cjs": `Reflect.set(globalThis, "issue4718/eager", true)`
      })
      const failure = yield* Effect.flip(
        Executable.fromDescriptor(yield* descriptorIn(root, "eager"), { delegates: [] })
      )
      expect(failure.code).toBe("body_unavailable")
      expect(failure.cause).toBeInstanceOf(LoadGuard.UnmeasuredLoadError)
      expect((failure.cause as LoadGuard.UnmeasuredLoadError).path).toBe(
        `${root}/.smithers/flows/eager/unmeasured.cjs`
      )
      expect(Reflect.get(globalThis, "issue4718/eager")).toBeUndefined()
    }).pipe(Effect.scoped, Effect.provide(guardedPlatform)))

  it.effect("still loads a flow with no computed load from a source root the guard holds", () =>
    Effect.gen(function*() {
      const root = yield* project({
        ".smithers/flows/computes/flow.ts": flow("computes", exposed("issue4718/computes")),
        ".smithers/flows/computes/tool.mjs": tool,
        ".smithers/flows/plain/flow.ts": flow(
          "plain",
          `import { value } from "./helper.ts"\nexport const seen = value`
        ),
        ".smithers/flows/plain/helper.ts": `export const value = 1`
      })
      yield* Executable.fromDescriptor(yield* descriptorIn(root, "computes"), { delegates: [] })
      const plain = yield* Executable.fromDescriptor(yield* descriptorIn(root, "plain"), { delegates: [] })
      expect(plain.descriptor.name).toBe("plain")
    }).pipe(Effect.scoped, Effect.provide(guardedPlatform)))

  it.effect("keeps the refusal on a host with no guard, and says what would admit the flow", () =>
    Effect.gen(function*() {
      const root = yield* project({
        ".smithers/flows/load/flow.ts": flow("load", exposed("issue4718/unguarded")),
        ".smithers/flows/load/tool.mjs": tool
      })
      const failure = yield* Effect.flip(
        Executable.fromDescriptor(yield* descriptorIn(root, "load"), { delegates: [] })
      )
      expect(failure.code).toBe("body_unavailable")
      expect(failure.message).toBe(
        "flow \"load\" runs code this host cannot pin: \"tool.mjs\" computes the target of 5 import() or require() call(s). A load whose target is computed runs only where the host checks loads at run time, which takes a LoadGuard and the default loader. On this host every module a flow's entry loads from beside itself has to be measurable before it runs"
      )
      expect(Reflect.get(globalThis, "issue4718/unguarded")).toBeUndefined()
    }).pipe(Effect.scoped, Effect.provide(platform)))

  it.effect("keeps the refusal under a host's own loader, whose modules the guard cannot name", () =>
    Effect.gen(function*() {
      const root = yield* project({
        ".smithers/flows/load/flow.ts": flow("load", exposed("issue4718/own-loader")),
        ".smithers/flows/load/tool.mjs": tool
      })
      let loads = 0
      const failure = yield* Effect.flip(
        Executable.fromDescriptor(yield* descriptorIn(root, "load"), {
          delegates: [],
          load: () => {
            loads++
            return Effect.succeed({})
          }
        })
      )
      expect(failure.message).toContain("cannot pin")
      expect(failure.message).toContain("the default loader")
      expect(loads).toBe(0)
    }).pipe(Effect.scoped, Effect.provide(guardedPlatform)))

  it.effect("keeps refusing source the scan could not read to its end, which can hide a static load", () =>
    Effect.gen(function*() {
      const root = yield* project({
        ".smithers/flows/torn/flow.ts": `${flow("torn", "")}\nexport const torn = \`never closed`
      })
      const descriptor = yield* descriptorIn(root, "torn")
      expect(computed(descriptor)).toEqual([])
      const failure = yield* Effect.flip(Executable.fromDescriptor(descriptor, { delegates: [] }))
      expect(failure.message).toContain(
        "cannot pin: the entry computes the target of 1 import() or require() call(s). Every module"
      )
    }).pipe(Effect.scoped, Effect.provide(guardedPlatform)))

  it.effect("refuses a helper that gained a computed load after discovery measured it", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* project({
        ".smithers/flows/drift/flow.ts": flow("drift", exposed("issue4718/drift")),
        ".smithers/flows/drift/tool.mjs": `export const version = () => "static"`
      })
      const descriptor = yield* descriptorIn(root, "drift")
      yield* fs.writeFileString(`${root}/.smithers/flows/drift/tool.mjs`, tool)
      const failure = yield* Effect.flip(Executable.fromDescriptor(descriptor, { delegates: [] }))
      expect(failure.message).toContain("changed at")
      expect(failure.message).toContain("refresh the registry before running it")
      expect(Reflect.get(globalThis, "issue4718/drift")).toBeUndefined()
    }).pipe(Effect.scoped, Effect.provide(guardedPlatform)))

  it.effect("refuses a descriptor that leaves out the record of a computed load", () =>
    Effect.gen(function*() {
      // A stored descriptor is not evidence. Without the record nothing would
      // ask the guard to hold the flow, so the fresh measurement has to object.
      const root = yield* project({
        ".smithers/flows/load/flow.ts": flow("load", exposed("issue4718/forged")),
        ".smithers/flows/load/tool.mjs": tool
      })
      const descriptor = yield* descriptorIn(root, "load")
      const body = descriptor.body as Descriptor.BodyRefModule
      const forged = new Descriptor.FlowDescriptor({
        ...descriptor,
        body: new Descriptor.BodyRefModule({
          ...body,
          imports: body.imports!.filter((entry) => entry.contentDigest !== undefined)
        })
      })
      expect(computed(forged)).toEqual([])
      const failure = yield* Effect.flip(Executable.fromDescriptor(forged, { delegates: [] }))
      expect(failure.message).toContain(
        "changed at \"\"tool.mjs\" computes the target of 5 import() or require() call(s)\""
      )
      expect(Reflect.get(globalThis, "issue4718/forged")).toBeUndefined()
    }).pipe(Effect.scoped, Effect.provide(guardedPlatform)))

  it.effect("refuses a flow directory that is a symbolic link out of the source root", () =>
    Effect.gen(function*() {
      // Its measured copies would run, and load their unmeasured neighbours,
      // at a real path the guard does not hold.
      const fs = yield* FileSystem.FileSystem
      const root = yield* project({
        "moved/linked/flow.ts": flow("linked", exposed("issue4718/linked")),
        "moved/linked/tool.mjs": tool,
        "moved/linked/unmeasured.cjs": `module.exports = "unmeasured"`,
        ".smithers/flows/keep": ""
      })
      yield* fs.symlink(`${root}/moved/linked`, `${root}/.smithers/flows/linked`)
      const failure = yield* Effect.flip(
        Executable.fromDescriptor(yield* descriptorIn(root, "linked"), { delegates: [] })
      )
      expect(failure.code).toBe("body_unavailable")
      expect(failure.message).toContain("cannot be held to its source root")
      expect(failure.message).toContain(
        `is reached through a symbolic link that leaves the flow source root "${root}/.smithers/flows"`
      )
      expect(Reflect.get(globalThis, "issue4718/linked")).toBeUndefined()
      expect((yield* fs.readDirectory(`${root}/moved/linked`)).sort()).toEqual([
        "flow.ts",
        "tool.mjs",
        "unmeasured.cjs"
      ])
    }).pipe(Effect.scoped, Effect.provide(guardedPlatform)))

  it.effect("refuses a computed load whose entry is not beneath the source root it would be held to", () =>
    Effect.gen(function*() {
      const root = yield* project({
        ".smithers/flows/load/flow.ts": flow("load", exposed("issue4718/misplaced")),
        ".smithers/flows/load/tool.mjs": tool,
        "elsewhere/keep": ""
      })
      const descriptor = yield* descriptorIn(root, "load")
      const misplaced = new Descriptor.FlowDescriptor({
        ...descriptor,
        provenance: { ...descriptor.provenance, root: `${root}/elsewhere` }
      })
      const failure = yield* Effect.flip(Executable.fromDescriptor(misplaced, { delegates: [] }))
      expect(failure.code).toBe("body_unavailable")
      expect(failure.message).toContain(`its entry is outside its source root "${root}/elsewhere"`)
      expect(Reflect.get(globalThis, "issue4718/misplaced")).toBeUndefined()
    }).pipe(Effect.scoped, Effect.provide(guardedPlatform)))

  it.effect("refuses the flow when the guard cannot hold its source root", () =>
    Effect.gen(function*() {
      const root = yield* project({
        ".smithers/flows/load/flow.ts": flow("load", exposed("issue4718/unheld")),
        ".smithers/flows/load/tool.mjs": tool
      })
      const failing = Layer.succeed(LoadGuard.LoadGuard, {
        protect: (held) =>
          Effect.fail(new LoadGuard.LoadGuardError({ path: held, message: "the load guard could not resolve it" })),
        permit: () => Effect.void
      })
      const failure = yield* Effect.flip(
        Executable.fromDescriptor(yield* descriptorIn(root, "load"), { delegates: [] }).pipe(Effect.provide(failing))
      )
      expect(failure.code).toBe("body_unavailable")
      expect(failure.message).toBe(
        "flow \"load\" cannot be held to its source root: the load guard could not resolve it"
      )
      expect(failure.cause).toBeInstanceOf(LoadGuard.LoadGuardError)
      expect(Reflect.get(globalThis, "issue4718/unheld")).toBeUndefined()
    }).pipe(Effect.scoped, Effect.provide(platform)))
  it.effect("holds an approved snapshot of a computed flow to the same rule when its live source changed", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* project({
        ...target,
        ".smithers/flows/kept/flow.ts": flow("kept", exposed("issue4718/kept")),
        ".smithers/flows/kept/tool.mjs": tool,
        ".smithers/flows/kept/unmeasured.cjs": `module.exports = "unmeasured"`
      })
      const descriptor = yield* descriptorIn(root, "kept")
      const snapshots = yield* Snapshot.makeFileSystem({ root })
      const approved = yield* Executable.fromDescriptor(descriptor, { delegates: [] }).pipe(
        Effect.provide(NodeLoadGuard.layer)
      )
      yield* snapshots.pin(approved)
      Reflect.deleteProperty(globalThis, "issue4718/kept")
      yield* fs.writeFileString(`${root}/.smithers/flows/kept/flow.ts`, "throw new Error(\"unapproved\")")

      // A snapshot is not a way around the guard.
      const unguarded = yield* Effect.flip(Executable.fromDescriptor(descriptor, { delegates: [], snapshots }))
      expect(unguarded.message).toContain("cannot pin")
      expect(unguarded.message).toContain("takes a LoadGuard and the default loader")
      expect(Reflect.get(globalThis, "issue4718/kept")).toBeUndefined()

      yield* Effect.gen(function*() {
        yield* Executable.fromDescriptor(descriptor, { delegates: [], snapshots })
        const loaded = Reflect.get(globalThis, "issue4718/kept") as Tool
        expect(loaded.version(`${root}/target`)).toBe("9.9.9-target")
        expect(thrown(() => loaded.beside("./unmeasured.cjs"))).toBeInstanceOf(LoadGuard.UnmeasuredLoadError)
      }).pipe(Effect.provide(NodeLoadGuard.layer))
    }).pipe(Effect.scoped, Effect.provide(platform)))
})
