import { systemFlows } from "./fixtures/system-flows.ts"
/*
 * The repository host's catalog, after one of its own runs writes a flow.
 *
 * `.smithers/flows/coding/host.ts` assembles its catalog itself: the repository's own
 * `.smithers/flows/` tree with the ordinary verified loader, and the reserved
 * job declarations out of the measured bundle the host shipped as. That catalog
 * used to be frozen for the life of the process, so `create-flow` — which
 * this host serves — could write `.smithers/flows/<id>/flow.ts` and leave a flow the
 * same host could neither plan nor run until it was restarted.
 *
 * The composition now serves it through `Executable.layerRefreshable`. This
 * file is about the two halves of that rule holding against the real
 * `repositoryCatalog` and the real `bindRepositoryRegistry`: a project flow
 * written after startup is rebuilt, and a reserved job declaration is not,
 * because its bytes are the bundle and not whatever is on disk.
 */
import { NodeServices } from "@effect/platform-node"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Action, Flow, FlowRuntime, Graph } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import { Context, Effect, Layer, Schema } from "effect"
import assert from "node:assert/strict"
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import * as HostRegistry from "../coding/host-registry.ts"
import { repositoryFlowsServed } from "../coding/host.ts"
import { composeRoot } from "../coding/serve-host.ts"
import {
  bindRepositoryRegistry,
  provisionBuiltins,
  repositoryCatalog,
  repositoryRegistration
} from "../repository/registry.ts"

const platform = process.versions.bun ? (await import("@effect/platform-bun/BunServices")).layer : NodeServices.layer
const policy = "a".repeat(64)

const Step = Action.make("refresh/Step", { payload: { step: Schema.String }, success: Schema.String })

/** The one delegate every prompt body in this host's catalog resolves to. */
const Agent = Flow.make("agent", {
  payload: Executable.Invocation,
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Node.succeed(undefined)
})

/** The delegate one reserved job declaration names, so the bundle resolves. */
const Reserved = Flow.make("repository/RunSetup", {
  payload: Executable.Invocation,
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Node.succeed(undefined)
})

/** The delegate a project flow written after startup names. */
const Project = Flow.make("refresh/Project", {
  payload: Executable.Invocation,
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Step.call({ step: "first" }).pipe(Node.andThen(Step.call({ step: "second" })))
})

/** Every registration the runtime was asked for, in order. */
const observed = (registered: Array<string>) =>
  Layer.succeed(
    FlowRuntime.FlowRuntime,
    { register: (flow: { readonly _tag: string }) => Effect.sync(() => void registered.push(flow._tag)) } as never
  )

const workspace = async (t: TestContext) => {
  const temporary = await mkdtemp(join(tmpdir(), "coding-catalog-refresh-"))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const repositoryPath = join(temporary, "repo"), stateRoot = join(temporary, "state")
  await mkdir(join(repositoryPath, ".smithers", "flows"), { recursive: true })
  return { repositoryPath, stateRoot }
}

/** The declaration `create-flow`'s scaffold stage leaves in `.smithers/flows/<id>/`. */
const declaration = `---
description: Written by a run of this host.
model: flow/author
flows: ["refresh/Project"]
---

Do the thing.
`

/** The catalog and refresh `.smithers/flows/coding/host.ts` composes, over one workspace. */
const host = (repositoryPath: string, stateRoot: string, registered: Array<string>, hosted = false) =>
  Effect.gen(function*() {
    const builtins = yield* provisionBuiltins(stateRoot, policy)
    const project = yield* Registry.make({ sources: [Registry.projectSource({ join }, repositoryPath)] }).pipe(
      Effect.provide(Discovery.layer)
    )
    const registry = bindRepositoryRegistry(project, builtins.registry, policy, systemFlows)
    const options = { delegates: [Agent, Project, Reserved] }
    const built = yield* repositoryCatalog(options, builtins.load).pipe(
      Effect.provideService(Registry.Registry, registry)
    )
    return {
      registry,
      built,
      // The host's own composition, not a copy of it: `.smithers/flows/coding/host.ts`
      // serves its catalog through this exact function.
      layer: repositoryRegistration(options, built, Layer.empty, hosted ? repositoryPath : undefined).pipe(
        Layer.provideMerge(Layer.mergeAll(observed(registered), Action.layerImplementations, NodeCrypto.layer)),
        Layer.provideMerge(Layer.succeed(Registry.Registry, registry))
      )
    }
  })

test("a project flow written after the catalog was built is planned from the bytes on disk", async (t) => {
  const { repositoryPath, stateRoot } = await workspace(t)
  const registered: Array<string> = []
  const observedNames = await Effect.runPromise(Effect.scoped(
    Effect.gen(function*() {
      const composed = yield* host(repositoryPath, stateRoot, registered)
      return yield* Effect.gen(function*() {
        const catalog = yield* Executable.Catalog
        const refresh = yield* Executable.Refresh
        assert.equal(catalog.executables.some((entry) => entry.descriptor.name === "mine"), false)

        yield* Effect.promise(async () => {
          await mkdir(join(repositoryPath, ".smithers", "flows", "mine"), { recursive: true })
          await writeFile(join(repositoryPath, ".smithers", "flows", "mine", "flow.mdx"), declaration)
        })
        const outcome = yield* refresh.flow("mine")
        assert.equal(outcome._tag, "Registered")

        const entry = catalog.executables.find((candidate) => candidate.descriptor.name === "mine")
        assert.ok(entry, "the rebuilt entry must be in the catalog the host serves")
        assert.equal(entry.delegate, "refresh/Project")
        // The plan this host would now draw is the delegate's own topology,
        // rather than the empty one a missing executable leaves behind.
        assert.ok(
          Graph.drafts(Graph.build(entry.flow, { input: {} })).length > 1,
          "the rebuilt entry must plan its delegate's nodes"
        )
        return registered
      }).pipe(Effect.provide(composed.layer))
    }).pipe(Effect.provide(platform))
  ))

  assert.ok(observedNames.includes("mine"), "the rebuilt entry must be registered with the runtime")
})

test("a flow a run writes under the retired root flows/ is never planned", async (t) => {
  const { repositoryPath, stateRoot } = await workspace(t)
  const registered: Array<string> = []
  await Effect.runPromise(Effect.scoped(
    Effect.gen(function*() {
      const composed = yield* host(repositoryPath, stateRoot, registered)
      return yield* Effect.gen(function*() {
        const catalog = yield* Executable.Catalog
        const refresh = yield* Executable.Refresh
        yield* Effect.promise(async () => {
          await mkdir(join(repositoryPath, "flows", "mine"), { recursive: true })
          await writeFile(join(repositoryPath, "flows", "mine", "flow.mdx"), declaration)
        })
        assert.equal((yield* refresh.flow("mine"))._tag, "Removed")
        assert.equal(catalog.executables.some((entry) => entry.descriptor.name === "mine"), false)
        assert.deepEqual(
          (yield* composed.registry.warnings()).filter((warning) => warning.code === "retired_root").map((warning) =>
            warning.message
          ),
          ["Flows in flows/ are not loaded; move them to .smithers/flows/."]
        )
      }).pipe(Effect.provide(composed.layer))
    }).pipe(Effect.provide(platform))
  ))
  assert.equal(registered.includes("mine"), false)
})

test("a reserved job declaration is held fixed against whatever the working tree says", async (t) => {
  const { repositoryPath, stateRoot } = await workspace(t)
  const registered: Array<string> = []
  await Effect.runPromise(Effect.scoped(
    Effect.gen(function*() {
      const composed = yield* host(repositoryPath, stateRoot, registered)
      const before = composed.built.executables.find((entry) => entry.descriptor.name === "repository/setup")
      assert.ok(before, "the reserved setup job is part of this host's catalog")
      return yield* Effect.gen(function*() {
        const catalog = yield* Executable.Catalog
        const refresh = yield* Executable.Refresh
        // Everything this host's catalog holds is registered while it starts.
        const atStartup = [...registered]
        assert.ok(atStartup.includes("repository/setup"), "the reserved setup job registers at startup")
        // A run this host is serving can write anything into the tree. What it
        // must not be able to do is make the host rebuild a reserved job's
        // declaration out of what it wrote.
        yield* Effect.promise(async () => {
          await mkdir(join(repositoryPath, ".smithers", "flows", "repository", "setup"), { recursive: true })
          await writeFile(join(repositoryPath, ".smithers", "flows", "repository", "setup", "flow.mdx"), declaration)
        })
        assert.equal((yield* refresh.flow("repository/setup"))._tag, "Fixed")
        assert.equal(
          catalog.executables.find((entry) => entry.descriptor.name === "repository/setup"),
          before
        )
        assert.deepEqual(registered, atStartup)
      }).pipe(Effect.provide(composed.layer))
    }).pipe(Effect.provide(platform))
  ))
})

/** Real metadata discovery over a minimal packaged merge and a mutable project. */
const collisionHost = (repositoryPath: string, stateRoot: string, registered: Array<string>, packaged = true) =>
  Effect.gen(function*() {
    const defaults = join(stateRoot, "defaults")
    yield* Effect.promise(async () => {
      await mkdir(defaults, { recursive: true })
      if (packaged) {
        await mkdir(join(defaults, "merge"), { recursive: true })
        await writeFile(
          join(defaults, "merge", "flow.ts"),
          `
import { Flow } from "@smthrs/flow"
import { Schema } from "effect"
export default Flow.make("merge", { description: "Packaged merge", payload: {}, success: Schema.String })
`
        )
      }
    })
    const make = (root: string, source: string) =>
      Registry.make({ sources: [{ root, source, naming: "path" }] }).pipe(Effect.provide(Discovery.layer))
    const base = yield* make(join(repositoryPath, ".smithers", "flows"), "project")
    const defaultsRegistry = yield* make(defaults, "repository-host")
    // A routine service wrapper must retain collision diagnostics.
    const registry = Registry.Registry.of({
      ...bindRepositoryRegistry(base, defaultsRegistry, policy, systemFlows)
    })
    const options = { delegates: [] }
    const built = yield* repositoryCatalog(options, () =>
      Effect.succeed({
        default: Flow.make("merge", { payload: {}, success: Schema.String, body: () => Node.succeed("Packaged merge") })
      })).pipe(Effect.provideService(Registry.Registry, registry))
    return {
      built,
      layer: repositoryRegistration(options, built, Layer.empty).pipe(
        Layer.provideMerge(Layer.mergeAll(observed(registered), Action.layerImplementations, NodeCrypto.layer)),
        Layer.provideMerge(Layer.succeed(Registry.Registry, registry))
      )
    }
  })

const writeCollision = async (repositoryPath: string) => {
  const directory = join(repositoryPath, ".smithers", "flows", "merge")
  const marker = join(repositoryPath, "merge-imported")
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, "flow.ts"),
    `
import { Flow } from "@smthrs/flow"
import { Schema } from "effect"
import { writeFileSync } from "node:fs"
writeFileSync(${JSON.stringify(marker)}, "imported")
export default Flow.make("merge", { description: "Repository merge", payload: {}, success: Schema.String })
`
  )
  return marker
}

for (const initiallyPresent of [false, true]) {
  test(`reserved merge diagnostics reconcile add/remove with a fixed packaged entry (initially ${initiallyPresent})`, async (t) => {
    const { repositoryPath, stateRoot } = await workspace(t)
    const registered: Array<string> = []
    const marker = join(repositoryPath, "merge-imported")
    if (initiallyPresent) await writeCollision(repositoryPath)
    await Effect.runPromise(Effect.scoped(
      Effect.gen(function*() {
        const composed = yield* collisionHost(repositoryPath, stateRoot, registered)
        return yield* Effect.gen(function*() {
          const catalog = yield* Executable.Catalog
          const refresh = yield* Executable.Refresh
          const packaged = catalog.executables.find((entry) => entry.descriptor.name === "merge")
          assert.ok(packaged)
          const atStartup = [...registered]
          const expected = [{
            flow: "merge",
            code: "reserved_name",
            path: join(repositoryPath, ".smithers", "flows", "merge", "flow.ts")
          }]
          const refusals = () => catalog.refused.map(({ flow, code, path }) => ({ flow, code, path }))
          assert.deepEqual(refusals(), initiallyPresent ? expected : [])
          if (!initiallyPresent) yield* Effect.promise(() => writeCollision(repositoryPath))
          assert.equal((yield* refresh.flow("merge"))._tag, "Fixed")
          assert.deepEqual(refusals(), expected)
          // Mixed concurrent refreshes must publish the latest discovery once,
          // even when another selected name has no descriptor.
          const repeated = yield* Effect.all([refresh.flow("merge"), refresh.flow("absent")], {
            concurrency: "unbounded"
          })
          assert.deepEqual(repeated.map((result) => result._tag), ["Fixed", "Removed"])
          assert.deepEqual(refusals(), expected)
          assert.equal(catalog.executables.find((entry) => entry.descriptor.name === "merge"), packaged)
          assert.ok(Graph.build(packaged.flow, { input: {} }).nodes.some((node) => node.payload === "Packaged merge"))
          assert.equal(yield* catalog.load!("merge"), packaged)
          yield* Effect.promise(() => rm(join(repositoryPath, ".smithers", "flows", "merge"), { recursive: true }))
          assert.equal((yield* refresh.flow("merge"))._tag, "Fixed")
          assert.deepEqual(refusals(), [])
          yield* Effect.all([refresh.flow("absent"), refresh.flow("merge")], { concurrency: "unbounded" })
          assert.deepEqual(refusals(), [])
          assert.equal(catalog.executables.find((entry) => entry.descriptor.name === "merge"), packaged)
          assert.deepEqual(registered, atStartup)
        }).pipe(Effect.provide(composed.layer))
      }).pipe(Effect.provide(platform))
    ))
    await assert.rejects(access(marker), { code: "ENOENT" })
  })
}

test("a live reserved collision without a packaged executable remains a typed refusal", async (t) => {
  const { repositoryPath, stateRoot } = await workspace(t)
  await Effect.runPromise(Effect.scoped(
    Effect.gen(function*() {
      const composed = yield* collisionHost(repositoryPath, stateRoot, [], false)
      return yield* Effect.gen(function*() {
        const catalog = yield* Executable.Catalog
        const refresh = yield* Executable.Refresh
        yield* Effect.promise(() => writeCollision(repositoryPath))
        assert.equal((yield* refresh.flow("merge"))._tag, "Removed")
        assert.equal(catalog.refused.find((entry) => entry.flow === "merge")?.code, "reserved_name")
        const result = yield* Effect.result(catalog.load!("merge"))
        assert.equal(result._tag, "Failure")
        if (result._tag === "Failure") assert.equal(result.failure.code, "reserved_name")
        yield* Effect.promise(() => rm(join(repositoryPath, ".smithers", "flows", "merge"), { recursive: true }))
        yield* refresh.flow("merge")
        assert.deepEqual(catalog.refused, [])
      }).pipe(Effect.provide(composed.layer))
    }).pipe(Effect.provide(platform))
  ))
  await assert.rejects(access(join(repositoryPath, "merge-imported")), { code: "ENOENT" })
})

/*
 * A hosted host's runs are agent turns that write its checkout, and the host
 * holds the session's credentials. So on a hosted host the catalog loaded at
 * startup is the catalog for the host's life, and nothing under the checkout
 * is imported again. Each fixture's top-level code appends a line to `marks`
 * when it runs; the install variant shows the same fixture does run there.
 */

/** A module flow whose top level appends `<name> <version>` to `marks`. */
const markedFlow = (name: string, marks: string, version: string, preamble = "", value = JSON.stringify(version)) => `
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { appendFileSync } from "node:fs"
${preamble}
appendFileSync(${JSON.stringify(marks)}, ${JSON.stringify(`${name} ${version}\n`)})
export default Flow.make(${JSON.stringify(name)}, {
  description: ${JSON.stringify(`Repository ${name}`)}, capabilities: [],
  payload: {}, success: Schema.String,
  body: () => Node.succeed(${value})
})
`

/** A helper module whose top level appends `<name> <version>` to `marks`. */
const markedHelper = (name: string, marks: string, version: string) => `
import { appendFileSync } from "node:fs"
appendFileSync(${JSON.stringify(marks)}, ${JSON.stringify(`${name} ${version}\n`)})
export const ${name} = ${JSON.stringify(`${name} ${version}`)}
`

/** A workspace whose flows resolve this package's own `@smthrs` and `effect`. */
const moduleWorkspace = async (t: TestContext) => {
  const { repositoryPath, stateRoot } = await workspace(t)
  await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(repositoryPath, "node_modules"), "dir")
  const marks = join(repositoryPath, "..", "marks")
  const put = async (relative: string, text: string) => {
    await mkdir(join(repositoryPath, relative, ".."), { recursive: true })
    await writeFile(join(repositoryPath, relative), text)
  }
  const ran = async () => new Set((await readFile(marks, "utf8").catch(() => "")).split("\n").filter(Boolean))
  return { repositoryPath, stateRoot, marks, put, ran }
}

/** Where a loaded fixture leaves the loads it defers to first use. */
const deferred = (name: string) => `globalThis[Symbol.for("coding-catalog-refresh/${name}")]`
const later = (name: string): Promise<unknown> =>
  (globalThis as Record<symbol, () => Promise<unknown>>)[Symbol.for(`coding-catalog-refresh/${name}`)]!()

for (const hosted of [false, true]) {
  test(`a flow a run writes is ${hosted ? "never loaded on a hosted host" : "loaded on an install"}`, async (t) => {
    const { repositoryPath, stateRoot, marks, put, ran } = await moduleWorkspace(t)
    const registered: Array<string> = []
    await Effect.runPromise(Effect.scoped(
      Effect.gen(function*() {
        const composed = yield* host(repositoryPath, stateRoot, registered, hosted)
        return yield* Effect.gen(function*() {
          const catalog = yield* Executable.Catalog
          const refresh = yield* Executable.Refresh
          const atStartup = [...registered]
          yield* Effect.promise(() => put(".smithers/flows/evil/flow.ts", markedFlow("evil", marks, "agent")))
          // The draw the next plan makes: rebuild the named entry, then load it.
          const outcome = yield* refresh.flow("evil")
          const loaded = yield* Effect.result(catalog.load!("evil"))
          const offered = catalog.executables.some((entry) => entry.descriptor.name === "evil")
          if (hosted) {
            assert.equal(outcome._tag, "Fixed")
            assert.equal(loaded._tag, "Failure")
            assert.equal(offered, false)
            assert.deepEqual(registered, atStartup)
          } else {
            assert.equal(outcome._tag, "Registered")
            assert.equal(loaded._tag, "Success")
            assert.equal(offered, true)
            assert.ok(registered.includes("evil"))
          }
        }).pipe(Effect.provide(composed.layer))
      }).pipe(Effect.provide(platform))
    ))
    assert.deepEqual([...await ran()], hosted ? [] : ["evil agent"])
  })

  test(
    `an edit to a loaded flow, its helpers or its packages ${
      hosted ? "never runs on a hosted host" : "runs on an install"
    }`,
    async (t) => {
      const { repositoryPath, stateRoot, marks, put, ran } = await moduleWorkspace(t)
      const kept = (version: string) =>
        markedFlow(
          "kept",
          marks,
          version,
          [
            `import { helper } from "./helper.ts"`,
            `import { shared } from "../../../src/shared.ts"`,
            `${deferred("package")} = () => import("lazy-dependency")`
          ].join("\n"),
          "`${helper} ${shared}`"
        )
      const dependency = ".smithers/flows/kept/node_modules/lazy-dependency"
      const lazyIndex = (version: string) =>
        `import { appendFileSync } from "node:fs"\nappendFileSync(${
          JSON.stringify(marks)
        }, "lazy-dependency ${version}\\n")\n`
      await put(".smithers/flows/kept/flow.ts", kept("v1"))
      await put(".smithers/flows/kept/helper.ts", markedHelper("helper", marks, "v1"))
      await put("src/shared.ts", markedHelper("shared", marks, "v1"))
      await put(
        `${dependency}/package.json`,
        JSON.stringify({ name: "lazy-dependency", type: "module", exports: "./index.js" })
      )
      await put(`${dependency}/index.js`, lazyIndex("v1"))
      await put("src/required.cjs", `require("node:fs").appendFileSync(${JSON.stringify(marks)}, "required v1\\n")\n`)
      // A helper reached through import(), by path or by a package.json "imports"
      // entry, would load from the live tree at first use, so the flow that names
      // one is refused before it is imported.
      await put(
        ".smithers/flows/later/flow.ts",
        markedFlow("later", marks, "v1", `export const later = () => import("./later.ts")`)
      )
      await put(".smithers/flows/later/later.ts", markedHelper("later", marks, "v1"))
      await put(
        ".smithers/flows/mapped/flow.ts",
        markedFlow("mapped", marks, "v1", `export const mapped = () => import("#mapped")`)
      )
      await put(
        ".smithers/flows/mapped/package.json",
        JSON.stringify({ type: "module", imports: { "#mapped": "./mapped.ts" } })
      )
      await put(".smithers/flows/mapped/mapped.ts", markedHelper("mappedHelper", marks, "v1"))
      const registered: Array<string> = []
      await Effect.runPromise(Effect.scoped(
        Effect.gen(function*() {
          const composed = yield* host(repositoryPath, stateRoot, registered, hosted)
          const startup = composed.built.executables.find((entry) => entry.descriptor.name === "kept")
          assert.ok(startup, "the repository flow loads at startup")
          for (const name of ["later", "mapped"]) {
            assert.equal(composed.built.executables.some((entry) => entry.descriptor.name === name), false)
            assert.ok(composed.built.refused.some((entry) => entry.flow === name))
          }
          assert.deepEqual(yield* Effect.promise(ran), new Set(["helper v1", "shared v1", "kept v1"]))
          return yield* Effect.gen(function*() {
            const catalog = yield* Executable.Catalog
            const refresh = yield* Executable.Refresh
            yield* Effect.promise(async () => {
              await put(".smithers/flows/kept/flow.ts", kept("agent"))
              await put(".smithers/flows/kept/helper.ts", markedHelper("helper", marks, "agent"))
              await put("src/shared.ts", markedHelper("shared", marks, "agent"))
              await put(`${dependency}/index.js`, lazyIndex("agent"))
              await put(".smithers/flows/mapped/mapped.ts", markedHelper("mappedHelper", marks, "agent"))
              await put(
                "src/required.cjs",
                `require("node:fs").appendFileSync(${JSON.stringify(marks)}, "required agent\\n")\n`
              )
              await put(".smithers/flows/later/later.ts", markedHelper("later", marks, "agent"))
            })
            const outcome = yield* refresh.flow("kept")
            const entry = yield* catalog.load!("kept")
            const planned = Graph.build(entry.flow, { input: {} }).nodes.map((node) => node.payload)
            const lateHelpers = yield* Effect.all([catalog.load!("later"), catalog.load!("mapped")].map(Effect.result))
            // First use of a package and of a CommonJS module.
            const settle = (load: () => Promise<unknown>) =>
              load().then(() => "loaded", (error: unknown) => error instanceof Error ? error.message : String(error))
            const firstUse = yield* Effect.promise(() =>
              Promise.all([
                settle(() => later("package")),
                settle(async () => createRequire(join(repositoryPath, "package.json"))("./src/required.cjs"))
              ])
            )
            assert.deepEqual(lateHelpers.map((result) => result._tag), ["Failure", "Failure"])
            if (hosted) {
              assert.equal(outcome._tag, "Fixed")
              assert.equal(entry, startup)
              assert.ok(planned.includes("helper v1 shared v1"), "the plan is the startup code's")
              for (const refusal of firstUse) assert.match(refusal, /loads no workspace code after it starts/)
            } else {
              assert.equal(outcome._tag, "Registered")
              assert.ok(planned.includes("helper agent shared agent"), "an install plans the edited code")
              assert.deepEqual(firstUse, ["loaded", "loaded"])
            }
          }).pipe(Effect.provide(composed.layer))
        }).pipe(Effect.provide(platform))
      ))
      assert.deepEqual(
        await ran(),
        new Set([
          "helper v1",
          "shared v1",
          "kept v1",
          ...(hosted ? [] : [
            "helper agent",
            "shared agent",
            "kept agent",
            "lazy-dependency agent",
            "required agent"
          ])
        ])
      )
    }
  )
}

/*
 * A hosted host serving the live checkout loads no repository flow at all: a
 * box rebuilt for the next turn starts from a branch head that already holds
 * the agent's edits. These compose the root, registry, catalog and
 * registration from the functions `.smithers/flows/coding/serve-host.ts` and
 * `.smithers/flows/coding/host.ts` call.
 */
const composedHost = (repositoryPath: string, stateRoot: string, hosted: boolean, registered: Array<string>) =>
  Effect.gen(function*() {
    const adapters =
      composeRoot(repositoryPath, hosted ? repositoryPath : join(repositoryPath, "..", "hosted")).adapters
    const served = repositoryFlowsServed({ repositoryPath, ...adapters })
    const builtins = yield* provisionBuiltins(stateRoot, policy)
    const services = Layer.merge(platform, NodeCrypto.layer)
    const project = Context.get(
      yield* Layer.build(
        HostRegistry.layer(repositoryPath, stateRoot, services, served).pipe(Layer.provide(services))
      ),
      Registry.Registry
    )
    const registry = bindRepositoryRegistry(project, builtins.registry, policy, systemFlows)
    const options = { delegates: [Agent, Project, Reserved] }
    const built = yield* repositoryCatalog(options, builtins.load).pipe(
      Effect.provideService(Registry.Registry, registry)
    )
    const fixedRoot = "fixedFlowCatalog" in adapters && adapters.fixedFlowCatalog ? repositoryPath : undefined
    return {
      served,
      registry,
      built,
      layer: repositoryRegistration(options, built, Layer.empty, fixedRoot).pipe(
        Layer.provideMerge(Layer.mergeAll(observed(registered), Action.layerImplementations, NodeCrypto.layer)),
        Layer.provideMerge(Layer.succeed(Registry.Registry, registry))
      )
    }
  })

for (const hosted of [false, true]) {
  test(
    `committed repository flows ${
      hosted ? "never load on a hosted host, across an edit and a restart" : "load on an install"
    }`,
    async (t) => {
      const { repositoryPath, stateRoot, marks, put, ran } = await moduleWorkspace(t)
      const evil = (version: string) =>
        markedFlow("evil", marks, version, `import { helper } from "./helper.ts"`, "helper")
      await put(".smithers/flows/evil/flow.ts", evil("committed"))
      await put(".smithers/flows/evil/helper.ts", markedHelper("helper", marks, "committed"))
      await put(".smithers/flows/benign/flow.ts", markedFlow("benign", marks, "committed"))
      const repositoryNames = ["evil", "benign"]
      // From process start, on hosted, nothing under the root loads.
      const start = composeRoot(repositoryPath, hosted ? repositoryPath : join(repositoryPath, "..", "hosted"))
      t.after(start.release)
      if (hosted) {
        const direct = await import(pathToFileURL(join(repositoryPath, ".smithers/flows/evil/flow.ts")).href).then(
          () => "loaded",
          (error: Error) => error.message
        )
        assert.match(direct, /loads no workspace code after it starts/)
      }
      // A restart is a second host over the same tree.
      for (const restart of [false, true]) {
        const registered: Array<string> = []
        await Effect.runPromise(Effect.scoped(
          Effect.gen(function*() {
            const composed = yield* composedHost(repositoryPath, stateRoot, hosted, registered)
            assert.equal(composed.served, !hosted)
            // What the model is shown, and what the host can plan and run.
            const visible = (yield* composed.registry.visible()).map((entry) => entry.name)
            const listed = (yield* composed.registry.list()).map((entry) => entry.name)
            const loaded = composed.built.executables.map((entry) => entry.descriptor.name)
            for (const name of repositoryNames) {
              for (const [where, names] of [["visible", visible], ["listed", listed], ["catalog", loaded]] as const) {
                assert.equal(names.includes(name), !hosted, `${name} ${where}: ${names.join(",")}`)
              }
            }
            const setup = composed.built.executables.find((entry) => entry.descriptor.name === "repository/setup")
            assert.ok(setup, "the built-in setup job is served")
            assert.ok(Graph.build(setup.flow, { input: {} }).nodes.length > 0, "a built-in plan completes")
            return yield* Effect.gen(function*() {
              const catalog = yield* Executable.Catalog
              const refresh = yield* Executable.Refresh
              if (!restart) {
                // The agent edits the committed flow and its helper during the turn.
                yield* Effect.promise(async () => {
                  await put(".smithers/flows/evil/flow.ts", evil("agent"))
                  await put(".smithers/flows/evil/helper.ts", markedHelper("helper", marks, "agent"))
                })
              }
              const outcome = yield* refresh.flow("evil")
              const evilLoaded = yield* Effect.result(catalog.load!("evil"))
              assert.equal(outcome._tag, hosted ? "Fixed" : "Registered")
              assert.equal(evilLoaded._tag, hosted ? "Failure" : "Success")
              assert.equal(repositoryNames.some((name) => registered.includes(name)), !hosted)
            }).pipe(Effect.provide(composed.layer))
          }).pipe(Effect.provide(platform))
        ))
      }
      assert.deepEqual(
        await ran(),
        new Set(hosted ? [] : ["helper committed", "evil committed", "benign committed", "helper agent", "evil agent"])
      )
    }
  )
}
