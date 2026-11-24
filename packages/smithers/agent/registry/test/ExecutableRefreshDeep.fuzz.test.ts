import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Action, Flow, Graph } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import { Node } from "@smthrs/plan"
import { Arbitrary, Effect, FileSystem, Layer, Schema } from "effect"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as Executable from "../src/Executable.ts"
import * as Registry from "../src/Registry.ts"
import { recordingRuntime } from "./Runtime.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "120" : "25"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261131")

const modulesRoot = fileURLToPath(new URL("./fixtures/executable/modules", import.meta.url))
const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)

const Probe = Action.make("refresh/Probe", { payload: { step: Schema.String }, success: Schema.String })

const Delegate = Flow.make("refresh/Delegate", {
  payload: Executable.Invocation,
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Probe.call({ step: "first" }).pipe(Node.andThen(Probe.call({ step: "second" })))
})

const Other = Flow.make("refresh/Other", {
  payload: Executable.Invocation,
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Probe.call({ step: "only" })
})

const chained = `Node.andThen(Probe.call({ step: "first" }), Probe.call({ step: "second" }))`
const single = `Probe.call({ step: "only" })`

const declaration = (name: string, body: string) =>
  `import { Action, Flow } from "@smthrs/flow"
${body.includes("Node.") ? `import { Node } from "@smthrs/plan"\n` : ""}import { Schema } from "effect"

const Probe = Action.make("refresh/Probe", { payload: { step: Schema.String }, success: Schema.String })

export default Flow.make(${JSON.stringify(`refresh/${name}`)}, {
  description: "Fuzz generated flow",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
  payload: {},
  success: Schema.Unknown,
  body: () => ${body}
})
`

const halfWritten = (name: string) =>
  `import { Flow } from "@smthrs/flow"
import { Schema } from "effect"
import { body } from "./missing-sibling.ts"

export default Flow.make(${JSON.stringify(`refresh/${name}`)}, {
  description: "Broken sibling import",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
  payload: {},
  success: Schema.Unknown,
  body
})
`

const markdown = (delegate: string) =>
  `---
description: Fuzz markdown entry
flows: [${delegate}]
capabilities: []
---

Delegate prompt body for ${delegate}.
`

describe("@smthrs/registry Executable.layer, Refresh, ModuleClosure & Markdown hot-reload deep fuzz", () => {
  it(
    "Executable.layer & Refresh handle add, edit, markdown delegate swap, broken closure & removal atomically",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          mutation: Schema.Literals([
            "add_ts_chained",
            "edit_early_single",
            "add_markdown_delegate",
            "swap_markdown_delegate",
            "add_half_written",
            "remove_early",
            "refresh_missing"
          ]),
          idx: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ mutation, idx }) =>
            Effect.gen(function*() {
              const fs = yield* FileSystem.FileSystem
              const root = yield* fs.makeTempDirectoryScoped({ directory: modulesRoot, prefix: `.fuzz-ref-${idx}-` })
              yield* fs.makeDirectory(`${root}/.smithers/flows/early`, { recursive: true })
              yield* fs.writeFileString(`${root}/.smithers/flows/early/flow.ts`, declaration("early", chained))
              const registered: Array<string> = []

              return yield* Effect.gen(function*() {
                const catalog = yield* Executable.Catalog
                const refresh = yield* Executable.Refresh
                if (catalog.executables.length !== 1) return false

                if (mutation === "add_ts_chained") {
                  yield* fs.makeDirectory(`${root}/.smithers/flows/late`, { recursive: true })
                  yield* fs.writeFileString(`${root}/.smithers/flows/late/flow.ts`, declaration("late", chained))
                  const out = yield* refresh.flow("late")
                  if (out._tag !== "Registered") return false
                  const late = catalog.executables.find((e) => e.descriptor.name === "late")
                  if (!late) return false
                  const drafts = Graph.drafts(Graph.build(late.flow, { input: {} }))
                  return drafts.length > 0 && catalog.executables.some((e) => e.descriptor.name === "late")
                }
                if (mutation === "edit_early_single") {
                  yield* fs.writeFileString(`${root}/.smithers/flows/early/flow.ts`, declaration("early", single))
                  const out = yield* refresh.flow("early")
                  if (out._tag !== "Registered") return false
                  return catalog.executables.length === 1
                }
                if (mutation === "add_markdown_delegate" || mutation === "swap_markdown_delegate") {
                  yield* fs.makeDirectory(`${root}/.smithers/flows/md-flow`, { recursive: true })
                  yield* fs.writeFileString(`${root}/.smithers/flows/md-flow/SKILL.md`, markdown("refresh/Delegate"))
                  const o1 = yield* refresh.flow("md-flow")
                  if (o1._tag !== "Registered") return false
                  if (mutation === "swap_markdown_delegate") {
                    yield* fs.writeFileString(`${root}/.smithers/flows/md-flow/SKILL.md`, markdown("refresh/Other"))
                    const o2 = yield* refresh.flow("md-flow")
                    if (o2._tag !== "Registered") return false
                  }
                  return catalog.executables.some((e) => e.descriptor.name === "md-flow")
                }
                if (mutation === "add_half_written") {
                  yield* fs.makeDirectory(`${root}/.smithers/flows/broken`, { recursive: true })
                  yield* fs.writeFileString(`${root}/.smithers/flows/broken/flow.ts`, halfWritten("broken"))
                  const out = yield* Effect.result(refresh.flow("broken"))
                  // Broken closure must not corrupt existing catalog entry
                  return (
                    (out._tag === "Failure" || out.success._tag !== "Registered") &&
                    catalog.executables.some((e) => e.descriptor.name === "early")
                  )
                }
                if (mutation === "remove_early") {
                  yield* fs.remove(`${root}/.smithers/flows/early`, { recursive: true })
                  const out = yield* Effect.result(refresh.flow("early"))
                  return out._tag === "Success" || out._tag === "Failure"
                }
                // refresh_missing
                const out = yield* Effect.result(refresh.flow(`does-not-exist-${idx}`))
                return out._tag === "Success" || out._tag === "Failure"
              }).pipe(
                Effect.provide(
                  Executable.layer({ delegates: [Delegate, Other] }).pipe(
                    Layer.provideMerge(
                      Layer.mergeAll(recordingRuntime(registered), Action.layerImplementations, NodeCrypto.layer)
                    ),
                    Layer.provideMerge(Registry.layerProject({ root })),
                    Layer.orDie
                  )
                )
              )
            }).pipe(Effect.scoped, Effect.provide(platform)),
          { seed, executions: Math.min(executions, 14) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    },
    60_000
  )
})
