/**
 * Rebuilding one catalog entry on a host that is already serving.
 *
 * `catalog` is a startup snapshot: a host builds it once, registers what it
 * holds, and plans from it. A flow written to `flows/<id>/flow.ts` after that
 * moment is therefore invisible — it has no executable, so the host's plan
 * hook is absent and planning answers `FlowNotFound` or a plan with no nodes,
 * whatever discovery later says. That is the whole of the agent-led authoring
 * loop failing on a production box.
 *
 * This suite is about the seam that closes it: rescan discovery, rebuild ONE
 * entry, register its body with the runtime, and swap the snapshot the
 * `Catalog` service answers with — without restarting the host and without
 * replacing the service object readers captured at startup.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime, Graph } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { fileURLToPath } from "node:url"
import * as Executable from "../src/Executable.ts"
import * as Registry from "../src/Registry.ts"

const modulesRoot = fileURLToPath(new URL("./fixtures/executable/modules", import.meta.url))
const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)

const Probe = Action.make("refresh/Probe", { payload: { step: Schema.String }, success: Schema.String })

/** Every node id a plan built from this executable would carry. */
const drafts = (flow: Executable.Executable["flow"]) =>
  Graph.drafts(Graph.build(flow, { input: {} })).map((draft) => draft.id)

/** The delegate the authored declarations name. Its body is the plan's graph. */
const Delegate = Flow.make("refresh/Delegate", {
  payload: Executable.Invocation,
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Probe.call({ step: "first" }).pipe(Node.andThen(Probe.call({ step: "second" })))
})

/** A second registered flow, so an edited declaration can move between them. */
const Other = Flow.make("refresh/Other", {
  payload: Executable.Invocation,
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Probe.call({ step: "only" })
})

const declaration = (delegate: string) =>
  `import { Flow } from "@smthrs/core"
import { Schema } from "effect"
export default Flow.make({
  description: "Written after the catalog was built",
  input: Schema.Struct({}),
  output: Schema.Unknown,
  flows: [${JSON.stringify(delegate)}],
  effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" }
})
`

/** Every registration the runtime was asked for, in order. */
const observed = (registered: Array<string>) =>
  Layer.succeed(
    FlowRuntime.FlowRuntime,
    { register: (flow: { readonly _tag: string }) => Effect.sync(() => void registered.push(flow._tag)) } as never
  )

/**
 * One project root that starts with `early` on disk and nothing else, under a
 * directory whose `node_modules` resolve, so the default loader really
 * imports the file rather than a stand-in the test hands it.
 */
const withProject = <A, E>(
  registered: Array<string>,
  use: (root: string) => Effect.Effect<A, E, Executable.Catalog | Executable.Refresh | FileSystem.FileSystem>
) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ directory: modulesRoot, prefix: ".refresh-" })
    yield* fs.makeDirectory(`${root}/flows/early`, { recursive: true })
    yield* fs.writeFileString(`${root}/flows/early/flow.ts`, declaration("refresh/Delegate"))
    return yield* use(root).pipe(
      Effect.provide(
        Executable.layer({ delegates: [Delegate, Other] }).pipe(
          Layer.provideMerge(
            Layer.mergeAll(observed(registered), Action.layerImplementations, NodeCrypto.layer)
          ),
          Layer.provideMerge(Registry.layerProject({ root })),
          Layer.orDie
        )
      )
    )
  }).pipe(Effect.scoped, Effect.provide(platform))

describe("rebuilding one catalog entry without restarting the host", () => {
  it.effect("registers and plans a flow whose file was written after startup", () => {
    const registered: Array<string> = []
    return withProject(registered, (root) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const catalog = yield* Executable.Catalog
        const refresh = yield* Executable.Refresh
        expect(catalog.executables.map((entry) => entry.descriptor.name)).toEqual(["early"])
        expect(registered).toEqual(["early"])

        yield* fs.makeDirectory(`${root}/flows/late`, { recursive: true })
        yield* fs.writeFileString(`${root}/flows/late/flow.ts`, declaration("refresh/Delegate"))
        // Nothing has looked at the disk yet, so the snapshot is unchanged.
        expect(catalog.executables.map((entry) => entry.descriptor.name)).toEqual(["early"])

        const outcome = yield* refresh.flow("late")
        expect(outcome._tag).toBe("Registered")
        // The SAME service object a reader captured at startup answers with
        // the new entry: a swapped snapshot, not a swapped service.
        expect(catalog.executables.map((entry) => entry.descriptor.name).sort()).toEqual(["early", "late"])
        expect(registered).toEqual(["early", "late"])

        // The plan this host would now draw for `late` is its delegate's own
        // topology, keyed nodes and all, rather than the empty one a missing
        // executable leaves behind.
        const late = catalog.executables.find((entry) => entry.descriptor.name === "late")!
        expect(drafts(late.flow)).toContain("root.flow.flow.andThen")
      }))
  }, 60_000)

  it.effect("adopts the delegate an edited declaration moved to, from the new bytes", () => {
    const registered: Array<string> = []
    return withProject(registered, (root) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const catalog = yield* Executable.Catalog
        const refresh = yield* Executable.Refresh
        const before = catalog.executables.find((entry) => entry.descriptor.name === "early")!
        expect(before.delegate).toBe("refresh/Delegate")

        yield* fs.writeFileString(`${root}/flows/early/flow.ts`, declaration("refresh/Other"))
        expect((yield* refresh.flow("early"))._tag).toBe("Registered")

        const after = catalog.executables.find((entry) => entry.descriptor.name === "early")!
        // The import cache cannot answer this: the second build reads the new
        // bytes under a new content address and imports those.
        expect(after.delegate).toBe("refresh/Other")
        expect(after.descriptor.body.contentDigest).not.toBe(before.descriptor.body.contentDigest)
        expect(drafts(before.flow)).toContain("root.flow.flow.andThen")
        expect(drafts(after.flow)).not.toContain("root.flow.flow.andThen")
        expect(catalog.executables.filter((entry) => entry.descriptor.name === "early")).toHaveLength(1)
      }))
  }, 60_000)

  it.effect("reports the refusal and keeps the previous entry out of the catalog", () => {
    const registered: Array<string> = []
    return withProject(registered, (root) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const catalog = yield* Executable.Catalog
        const refresh = yield* Executable.Refresh
        yield* fs.makeDirectory(`${root}/flows/orphan`, { recursive: true })
        yield* fs.writeFileString(`${root}/flows/orphan/flow.ts`, declaration("refresh/Nobody"))

        const outcome = yield* refresh.flow("orphan")
        expect(outcome._tag).toBe("Refused")
        if (outcome._tag !== "Refused") return
        expect(outcome.error.code).toBe("missing_delegate")
        expect(outcome.error.delegate).toBe("refresh/Nobody")
        expect(catalog.executables.map((entry) => entry.descriptor.name)).toEqual(["early"])
        expect(catalog.refused.map((failure) => failure.flow)).toEqual(["orphan"])
        expect(registered).toEqual(["early"])
      }))
  }, 60_000)

  it.effect("leaves an entry the host holds fixed exactly as it was", () => {
    const registered: Array<string> = []
    return Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ directory: modulesRoot, prefix: ".refresh-" })
      yield* fs.makeDirectory(`${root}/flows/early`, { recursive: true })
      yield* fs.writeFileString(`${root}/flows/early/flow.ts`, declaration("refresh/Delegate"))
      yield* Effect.gen(function*() {
        const catalog = yield* Executable.Catalog
        const refresh = yield* Executable.Refresh
        const before = catalog.executables.find((entry) => entry.descriptor.name === "early")!
        yield* fs.writeFileString(`${root}/flows/early/flow.ts`, declaration("refresh/Other"))

        // A host serving part of its catalog out of its own measured bundle
        // answers `false` for those entries: the working tree is not where
        // their bytes come from.
        expect((yield* refresh.flow("early"))._tag).toBe("Fixed")
        expect(catalog.executables.find((entry) => entry.descriptor.name === "early")).toBe(before)
        expect(registered).toEqual(["early"])
      }).pipe(
        Effect.provide(
          Executable.layer({ delegates: [Delegate, Other], refreshable: () => false }).pipe(
            Layer.provideMerge(
              Layer.mergeAll(observed(registered), Action.layerImplementations, NodeCrypto.layer)
            ),
            Layer.provideMerge(Registry.layerProject({ root })),
            Layer.orDie
          )
        )
      )
    }).pipe(Effect.scoped, Effect.provide(platform))
  }, 60_000)

  it.effect(
    "rebuilds one entry of several, and clears the refusal it recorded for it",
    () =>
      withProject([], (root) =>
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const catalog = yield* Executable.Catalog
          const refresh = yield* Executable.Refresh
          yield* fs.makeDirectory(`${root}/flows/other`, { recursive: true })
          yield* fs.writeFileString(`${root}/flows/other/flow.ts`, declaration("refresh/Other"))
          expect((yield* refresh.flow("other"))._tag).toBe("Registered")
          const other = catalog.executables.find((entry) => entry.descriptor.name === "other")!

          // A refusal takes the entry out and records why.
          yield* fs.writeFileString(`${root}/flows/early/flow.ts`, declaration("refresh/Nobody"))
          expect((yield* refresh.flow("early"))._tag).toBe("Refused")
          expect(catalog.executables.map((entry) => entry.descriptor.name)).toEqual(["other"])
          expect(catalog.refused.map((failure) => failure.flow)).toEqual(["early"])

          // Repairing the file puts it back and drops the refusal with it.
          yield* fs.writeFileString(`${root}/flows/early/flow.ts`, declaration("refresh/Delegate"))
          expect((yield* refresh.flow("early"))._tag).toBe("Registered")
          expect(catalog.refused).toEqual([])
          expect(catalog.executables.map((entry) => entry.descriptor.name).sort()).toEqual(["early", "other"])

          // And rebuilding it again replaces only itself: every other entry is
          // the same object the host was already serving.
          yield* fs.writeFileString(`${root}/flows/early/flow.ts`, declaration("refresh/Other"))
          expect((yield* refresh.flow("early"))._tag).toBe("Registered")
          expect(catalog.executables.find((entry) => entry.descriptor.name === "other")).toBe(other)
          expect(catalog.executables.find((entry) => entry.descriptor.name === "early")!.delegate)
            .toBe("refresh/Other")
        })),
    60_000
  )

  it.effect("drops the entry when the flow it names is gone from disk", () => {
    const registered: Array<string> = []
    return withProject(registered, (root) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const catalog = yield* Executable.Catalog
        const refresh = yield* Executable.Refresh
        yield* fs.remove(`${root}/flows/early`, { recursive: true })

        expect((yield* refresh.flow("early"))._tag).toBe("Removed")
        expect(catalog.executables).toEqual([])
      }))
  }, 60_000)
})
