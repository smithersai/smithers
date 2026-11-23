import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Flow } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import { Node } from "@smthrs/plan"
import { Arbitrary, Effect, FileSystem, Layer, Logger, Result, Schema } from "effect"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { Descriptor, Discovery, Executable, ExecutionSnapshot, Registry } from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const platform = Layer.mergeAll(NodeCrypto.layer, NodeFileSystem.layer, NodePath.layer, Logger.layer([]))

describe("@smthrs/registry Executable module closures, tamper refusal, ExecutionSnapshot pin/restore & refreshable catalog fuzz invariants", () => {
  it("Discovery + ModuleClosure + Executable.fromDescriptor + ExecutionSnapshot pin/restore uphold digest pinning & tamper detection", async () => {
    const tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "smthrs-reg-snap-fuzz-")))
    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          flowName: Schema.Literals(["snap-a", "deploy-check", "triage"]),
          helperValue: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(32))),
          tamperTarget: Schema.Literals(["none", "entry", "helper", "lockfile"]),
          hasSubHelper: Schema.Boolean,
          hasLockfile: Schema.Boolean,
          badExport: Schema.Literals(["valid", "missing_default", "wrong_tag"])
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ flowName, helperValue, tamperTarget, hasSubHelper, hasLockfile, badExport }) =>
            Effect.gen(function*() {
              const safeVal = helperValue.replace(/[^a-zA-Z0-9 _-]/g, "x") || "ok"
              const root = yield* Effect.promise(() => fs.mkdtemp(path.join(tmpRoot, "case-")))
              try {
                const flowDir = path.join(root, ".smithers", "flows", flowName)
                yield* Effect.promise(() => fs.mkdir(flowDir, { recursive: true }))
                const entryPath = path.join(flowDir, "flow.ts")
                const helperPath = path.join(flowDir, "helper.ts")
                const subPath = path.join(flowDir, "sub.ts")

                if (hasSubHelper) {
                  yield* Effect.promise(() => fs.writeFile(subPath, `export const leaf = ${JSON.stringify(safeVal)}\n`))
                  yield* Effect.promise(() =>
                    fs.writeFile(helperPath, `import { leaf } from "./sub.ts"\nexport const value = leaf\n`)
                  )
                } else {
                  yield* Effect.promise(() =>
                    fs.writeFile(helperPath, `export const value = ${JSON.stringify(safeVal)}\n`)
                  )
                }

                const entrySrc = [
                  `import { Flow } from "@smthrs/flow"`,
                  `import { Node } from "@smthrs/plan"`,
                  `import { Schema } from "effect"`,
                  `import { value } from "./helper.ts"`,
                  `export default Flow.make(${JSON.stringify(flowName)}, {`,
                  `  description: "Fuzz snapshot flow",`,
                  `  payload: Schema.Struct({ x: Schema.String }),`,
                  `  success: Schema.String,`,
                  `  body: () => Node.succeed(value)`,
                  `})`
                ].join("\n")
                yield* Effect.promise(() => fs.writeFile(entryPath, entrySrc))

                if (hasLockfile) {
                  yield* Effect.promise(() => fs.writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n"))
                }

                const discovery = yield* Discovery.Discovery
                const scanned = yield* discovery.scan({
                  source: "project",
                  root: path.join(root, ".smithers", "flows"),
                  naming: "path",
                  lockfileRoot: root
                })
                if (scanned.entries.length !== 1) return false
                const desc = scanned.entries[0]!
                const digestBefore = Descriptor.executionDigest(desc)
                if (digestBefore === undefined) return false

                // Tamper disk bytes AFTER discovery, BEFORE Executable.fromDescriptor
                if (tamperTarget === "entry") {
                  yield* Effect.promise(() => fs.writeFile(entryPath, entrySrc + "\n// tampered\n"))
                } else if (tamperTarget === "helper") {
                  yield* Effect.promise(() => fs.writeFile(helperPath, `export const value = "TAMPERED"\n`))
                } else if (tamperTarget === "lockfile" && hasLockfile) {
                  yield* Effect.promise(() => fs.writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9.1\n"))
                }

                const flowImpl = Flow.make(badExport === "wrong_tag" ? "other/tag" : flowName, {
                  description: "Fuzz snapshot flow",
                  payload: Schema.Struct({ x: Schema.String }),
                  success: Schema.String,
                  body: () => Node.succeed(safeVal)
                })

                const loadResult = yield* Executable.fromDescriptor(desc, {
                  delegates: [],
                  load: () =>
                    badExport === "missing_default"
                      ? Effect.succeed({})
                      : Effect.succeed({ default: flowImpl })
                }).pipe(Effect.result)

                const tampered = tamperTarget === "entry" || tamperTarget === "helper" ||
                  (tamperTarget === "lockfile" && hasLockfile)
                if (tampered || badExport === "missing_default") {
                  return Result.isFailure(loadResult)
                }
                if (badExport === "wrong_tag") {
                  return Result.isSuccess(loadResult) && loadResult.success.declaredTag === "other/tag"
                }
                if (Result.isFailure(loadResult)) return false
                const executable = loadResult.success

                // Pin into ExecutionSnapshot and verify descriptor + restore + roots + missing digest refusal
                const snapRoot = path.join(root, ".snapshots")
                const snapshots = yield* ExecutionSnapshot.makeFileSystem({ root: snapRoot })
                yield* snapshots.pin(executable)
                const restoredDesc = yield* snapshots.descriptor(digestBefore)
                if (restoredDesc.name !== flowName) return false
                const restored = yield* snapshots.restore(digestBefore)
                if (restored.descriptor.name !== flowName) return false
                const roots = yield* snapshots.roots([digestBefore])
                if (roots.length === 0) return false

                const missingRes = yield* snapshots.descriptor("0".repeat(64)).pipe(Effect.result)
                if (Result.isSuccess(missingRes)) return false

                // Also exercise Registry.layerProject + Executable.catalog
                const regLayer = Registry.layerProject({ root }).pipe(Layer.provide(platform))
                const cat = yield* Executable.catalog({
                  delegates: [],
                  load: () => Effect.succeed({ default: flowImpl })
                }).pipe(Effect.provide(regLayer))
                return cat.executables.length === 1 && cat.refused.length === 0
              } finally {
                yield* Effect.promise(() => fs.rm(root, { recursive: true, force: true }))
              }
            }).pipe(Effect.provide(Discovery.layer), Effect.provide(platform), Effect.scoped),
          { seed, executions: Math.min(executions, 25) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true })
    }
  })
})
