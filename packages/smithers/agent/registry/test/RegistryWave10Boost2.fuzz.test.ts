import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Digest from "@smthrs/core/Digest"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, FlowRuntime } from "@smthrs/flow"
import * as CacheEnvironment from "@smthrs/flow/CacheEnvironment"
import { Fuzz } from "@smthrs/fuzz"
import { Node } from "@smthrs/plan"
import {
  Arbitrary,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  Path,
  Result,
  Schema
} from "effect"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import * as Descriptor from "../src/Descriptor.ts"
import * as Discovery from "../src/Discovery.ts"
import * as Executable from "../src/Executable.ts"
import * as LoadGuard from "../src/LoadGuard.ts"
import * as ModuleClosure from "../src/internal/ModuleClosure.ts"
import * as ModuleMetadata from "../src/internal/ModuleMetadata.ts"
import { recordingRuntime } from "./Runtime.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const fastExec = Math.max(30, Math.min(executions, 80))
const ioExec = Math.max(12, Math.min(executions, 24))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261199")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const platform = Layer.mergeAll(NodeCrypto.layer, NodeFileSystem.layer, NodePath.layer, Logger.layer([]))
const enc = new TextEncoder()

describe("@smthrs/registry Wave10 Boost2 Fuzz", () => {
  it("ModuleClosure JSONC/tsconfig extends cycles, #imports unmatched/bare, .node addon, bounds overflow, and confinement escape", async () => {
    const tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "smthrs-reg-w10-mc2-")))
    try {
      const modes = [
        "tsconfig-jsonc-and-extends-cycle",
        "tsconfig-invalid-jsonc-and-node-modules-extends",
        "pkg-imports-unmatched-and-bare",
        "native-node-addon-and-confinement-escape",
        "bounds-bytes-and-files-overflow",
        "unreadable-helper-and-cached-bytes-overflow"
      ] as const

      const arb = Arbitrary.schema(Schema.Struct({ idx: Schema.Literals([0, 1, 2, 3, 4, 5]) }))
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ idx }) =>
            Effect.gen(function*() {
              const fsSvc = yield* FileSystem.FileSystem
              const pathSvc = yield* Path.Path
              const mode = modes[idx]!
              const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(tmpRoot, "m-")))
              const cache = ModuleClosure.cache()

              if (mode === "tsconfig-jsonc-and-extends-cycle") {
                const aCfg = `// line comment\n/* block comment */\n{ "extends": "./b.json", "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["./src/*"], }, }, }\n`
                const bCfg = `{ "extends": "./tsconfig.json", "compilerOptions": { "paths": { "@other/*": ["./src/*"] } } }\n`
                yield* Effect.promise(() => fs.mkdir(path.join(dir, "src"), { recursive: true }))
                yield* Effect.promise(() => fs.writeFile(path.join(dir, "tsconfig.json"), aCfg))
                yield* Effect.promise(() => fs.writeFile(path.join(dir, "b.json"), bCfg))
                yield* Effect.promise(() => fs.writeFile(path.join(dir, "src", "util.ts"), "export const u = 1\n"))
                const entry = path.join(dir, "flow.ts")
                const src = `import { u } from "@app/util"\nexport default u\n`
                yield* Effect.promise(() => fs.writeFile(entry, src))
                const res = yield* ModuleClosure.analyze(fsSvc, pathSvc, entry, src, cache)
                expect(res.imports.length).toBeGreaterThan(0)
              } else if (mode === "tsconfig-invalid-jsonc-and-node-modules-extends") {
                const nmBase = path.join(dir, "node_modules", "cfg-pkg")
                yield* Effect.promise(() => fs.mkdir(nmBase, { recursive: true }))
                yield* Effect.promise(() =>
                  fs.writeFile(
                    path.join(nmBase, "tsconfig.json"),
                    JSON.stringify({ compilerOptions: { paths: { "@nm/*": ["./x/*"] } } })
                  )
                )
                yield* Effect.promise(() => fs.writeFile(path.join(dir, "tsconfig.json"), `{ "extends": "cfg-pkg", "compilerOptions": {} }`))
                const sub = path.join(dir, "sub")
                yield* Effect.promise(() => fs.mkdir(sub, { recursive: true }))
                yield* Effect.promise(() => fs.writeFile(path.join(sub, "tsconfig.json"), `{ invalid jsonc `))
                const entry = path.join(sub, "flow.ts")
                const src = `import { x } from "@nm/a"\nexport default x\n`
                yield* Effect.promise(() => fs.writeFile(entry, src))
                const res = yield* ModuleClosure.analyze(fsSvc, pathSvc, entry, src, cache)
                expect(res.imports).toBeDefined()
              } else if (mode === "pkg-imports-unmatched-and-bare") {
                yield* Effect.promise(() =>
                  fs.writeFile(
                    path.join(dir, "package.json"),
                    JSON.stringify({ name: "p", imports: { "#ext": "some-bare-pkg" } })
                  )
                )
                const entry = path.join(dir, "flow.ts")
                const src = `import a from "#ext"\nimport b from "#missing"\nexport default [a, b]\n`
                yield* Effect.promise(() => fs.writeFile(entry, src))
                const res = yield* ModuleClosure.analyze(fsSvc, pathSvc, entry, src, cache)
                expect(res.imports.length).toBeGreaterThanOrEqual(2)
              } else if (mode === "native-node-addon-and-confinement-escape") {
                const inside = path.join(dir, "inside")
                const outside = path.join(dir, "outside")
                yield* Effect.promise(() => fs.mkdir(inside, { recursive: true }))
                yield* Effect.promise(() => fs.mkdir(outside, { recursive: true }))
                yield* Effect.promise(() => fs.writeFile(path.join(inside, "addon.node"), "ELF"))
                yield* Effect.promise(() => fs.writeFile(path.join(outside, "secret.ts"), "export const s = 1\n"))
                yield* Effect.promise(() => fs.symlink(path.join(outside, "secret.ts"), path.join(inside, "link.ts")))
                const entry = path.join(inside, "flow.ts")
                const src = `import a from "./addon.node"\nimport { s } from "./link.ts"\nexport default [a, s]\n`
                yield* Effect.promise(() => fs.writeFile(entry, src))
                const res = yield* ModuleClosure.analyze(fsSvc, pathSvc, entry, src, cache, {
                  root: inside,
                  realRoot: inside
                })
                expect(res.hostImports.length).toBeGreaterThan(0)
                expect(res.imports.some((i) => i.contentDigest === undefined)).toBe(true)
              } else if (mode === "bounds-bytes-and-files-overflow") {
                yield* Effect.promise(() => fs.writeFile(path.join(dir, "a.ts"), "export const a = '" + "x".repeat(40) + "'\n"))
                yield* Effect.promise(() => fs.writeFile(path.join(dir, "b.ts"), "export const b = 2\n"))
                const entry = path.join(dir, "flow.ts")
                const src = `import { a } from "./a.ts"\nimport { b } from "./b.ts"\nexport default [a, b]\n`
                yield* Effect.promise(() => fs.writeFile(entry, src))
                const s1 = yield* ModuleClosure.snapshot(fsSvc, pathSvc, entry, enc.encode(src), { files: 1, bytes: 10_000 })
                expect(s1.imports.some((i) => i.contentDigest === undefined)).toBe(true)
                const s2 = yield* ModuleClosure.snapshot(fsSvc, pathSvc, entry, enc.encode(src), { files: 10, bytes: 15 })
                expect(s2.imports.some((i) => i.contentDigest === undefined)).toBe(true)
              } else if (mode === "unreadable-helper-and-cached-bytes-overflow") {
                const helper = path.join(dir, "h.ts")
                yield* Effect.promise(() => fs.writeFile(helper, "export const h = 1\n"))
                const entry = path.join(dir, "flow.ts")
                const src = `import { h } from "./h.ts"\nexport default h\n`
                yield* Effect.promise(() => fs.writeFile(entry, src))
                // First populate cache
                yield* ModuleClosure.analyze(fsSvc, pathSvc, entry, src, cache)
                // Now unreadable helper via faulty fs
                const badFs = {
                  ...fsSvc,
                  stream: (p: string, opts?: any) =>
                    p.endsWith("h.ts")
                      ? fsSvc.stream(path.join(dir, "no-such-file"), opts)
                      : fsSvc.stream(p, opts)
                } as unknown as FileSystem.FileSystem
                const res = yield* ModuleClosure.analyze(badFs, pathSvc, entry, src, ModuleClosure.cache())
                expect(res.imports.some((i) => i.contentDigest === undefined)).toBe(true)
              }
              return true
            }).pipe(Effect.provide(platform)),
          { executions: ioExec, seed }
        )
      )
      assertPassed(report)
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true })
    }
  }, 60_000)

  it("Executable dispatchedAction execution, namingMissing runtime defect, quiesce active fiber, and computed LoadGuard bounds", async () => {
    const tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "smthrs-reg-w10-ex2-")))
    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          n: Schema.Literals([1, 2, 3, 4]),
          exercise: Schema.Literals([
            "dispatched-cache-run",
            "naming-missing-invoke",
            "quiesce-active",
            "computed-guard-outside-root",
            "computed-guard-protect-fail",
            "all-layer-errors"
          ])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ n, exercise }) =>
            Effect.gen(function*() {
              const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(tmpRoot, "ex-")))
              const flowsDir = path.join(dir, "flows")
              const fDir = path.join(flowsDir, "f1")
              yield* Effect.promise(() => fs.mkdir(fDir, { recursive: true }))
              const flowTs = path.join(fDir, "flow.ts")
              const validSrc = [
                `import { Flow } from "@smthrs/flow"`,
                `import { Node } from "@smthrs/plan"`,
                `import { Schema } from "effect"`,
                `export default Flow.make("f1", {`,
                `  description: "f1",`,
                `  payload: Schema.Struct({ n: Schema.Number }),`,
                `  success: Schema.Number,`,
                `  body: ({ n }) => Node.succeed(n + 1)`,
                `})`
              ].join("\n")
              yield* Effect.promise(() => fs.writeFile(flowTs, validSrc))

              const discovery = yield* Discovery.Discovery
              const scanned = yield* discovery.scan({ source: "project", root: flowsDir, naming: "path" })
              const desc = scanned.entries[0]!
              const runtimeFlow = Flow.make("f1", {
                description: "f1",
                payload: Schema.Struct({ n: Schema.Number }),
                success: Schema.Number,
                body: ({ n: v }) => Node.succeed(v + 1)
              })

              if (exercise === "dispatched-cache-run") {
                const cachedFlow = CacheEnvironment.withCache(runtimeFlow, { scope: "shared", ttlMs: 60_000 })
                const engineLayer = Layer.mergeAll(FlowEngine.layerMemory, Action.layerImplementations, NodeCrypto.layer)
                const out = yield* Effect.scoped(
                  Effect.gen(function*() {
                    const exec = yield* Executable.fromDescriptor(desc, {
                      delegates: [],
                      load: () => Effect.succeed({ default: cachedFlow, layer: Layer.empty })
                    })
                    yield* Layer.build(exec.layer)
                    return yield* exec.flow.execute({ input: { n } })
                  })
                ).pipe(Effect.provide(engineLayer))
                expect(out).toBe(n + 1)
              } else if (exercise === "naming-missing-invoke") {
                class GhostSvc extends Context.Service<GhostSvc, { readonly x: number }>()("Wave10GhostSvc") {}
                const act = Action.make("wave10/ghost", {
                  payload: Schema.Struct({}),
                  success: Schema.Number
                })
                const implLayer = act.toLayer(() => Effect.map(GhostSvc, (s) => s.x))
                const flowWithAct = Flow.make("f1", {
                  description: "f1",
                  payload: Schema.Struct({}),
                  success: Schema.Number,
                  body: () => act.call({})
                })
                const engineLayer = Layer.mergeAll(FlowEngine.layerMemory, Action.layerImplementations, NodeCrypto.layer)
                const exit = yield* Effect.exit(
                  Effect.scoped(
                    Effect.gen(function*() {
                      const exec = yield* Executable.fromDescriptor(desc, {
                        delegates: [],
                        load: () => Effect.succeed({ default: flowWithAct, layer: implLayer })
                      })
                      yield* Layer.build(exec.layer)
                      return yield* exec.flow.execute({ input: {} })
                    })
                  ).pipe(Effect.provide(engineLayer))
                )
                expect(Exit.isFailure(exit)).toBe(true)
              } else if (exercise === "quiesce-active") {
                const started = yield* Deferred.make<void>()
                const slowAct = Action.make("wave10/slow", {
                  payload: Schema.Struct({}),
                  success: Schema.Number
                })
                const slowImpl = slowAct.toLayer(() =>
                  Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.sleep("5 seconds")), Effect.as(1))
                )
                const slowFlow = Flow.make("f1", {
                  description: "f1",
                  payload: Schema.Struct({}),
                  success: Schema.Number,
                  body: () => slowAct.call({})
                })
                const engineLayer = Layer.mergeAll(FlowEngine.layerMemory, Action.layerImplementations, NodeCrypto.layer)
                yield* Effect.scoped(
                  Effect.gen(function*() {
                    const exec = yield* Executable.fromDescriptor(desc, {
                      delegates: [],
                      adapterExecutionDigest: () => "adopt-q",
                      load: () => Effect.succeed({ default: slowFlow, layer: slowImpl })
                    })
                    yield* Layer.build(exec.layer)
                    const fiber = yield* Effect.forkChild(exec.flow.execute({ input: {} }, { executionId: "q-run-1" }))
                    yield* Deferred.await(started).pipe(Effect.timeoutOption("500 millis"))
                    if (exec.quiesce) yield* exec.quiesce(["q-run-1"])
                    yield* Fiber.interrupt(fiber)
                  })
                ).pipe(Effect.provide(engineLayer))
              } else if (exercise === "computed-guard-outside-root" || exercise === "computed-guard-protect-fail") {
                const compDesc = new Descriptor.FlowDescriptor({
                  ...desc,
                  body: new Descriptor.BodyRefModule({
                    path: flowTs,
                    contentDigest: desc.body.contentDigest,
                    imports: [{ path: "./dyn", computed: true }]
                  }),
                  provenance: new Descriptor.Provenance({
                    source: "project",
                    root: exercise === "computed-guard-outside-root" ? path.join(dir, "other-root") : flowsDir
                  })
                })
                const fakeGuard = LoadGuard.LoadGuard.of({
                  protect: () =>
                    Effect.fail(new LoadGuard.LoadGuardError({ path: flowsDir, message: "cannot protect" })),
                  permit: () => Effect.void
                })
                const r = yield* Effect.result(
                  Executable.fromDescriptor(compDesc, { delegates: [] }).pipe(
                    Effect.provideService(LoadGuard.LoadGuard, fakeGuard)
                  )
                )
                expect(Result.isFailure(r)).toBe(true)
              } else if (exercise === "all-layer-errors") {
                // Guarantee every single invalid_layer / missing_service / invalid_module branch executes
                const r1 = yield* Effect.result(
                  Executable.fromDescriptor(desc, {
                    delegates: [],
                    load: () => Effect.succeed({ default: { name: "f1", description: "d" }, layer: Layer.empty })
                  })
                )
                expect(Result.isFailure(r1)).toBe(true)
                const badLayer = Layer.succeed(Action.Implementations, Action.Implementations.of({
                  get: () => Effect.succeed(Option.none()),
                  add: () => Effect.void
                }))
                const r2 = yield* Effect.result(
                  Executable.fromDescriptor(desc, {
                    delegates: [],
                    load: () => Effect.succeed({ default: runtimeFlow, layer: badLayer })
                  }).pipe(Effect.provide(recordingRuntime([])))
                )
                expect(Result.isFailure(r2)).toBe(true)
                const r3 = yield* Effect.result(
                  Executable.fromDescriptor(desc, {
                    delegates: [],
                    load: () => Effect.succeed({ default: runtimeFlow, layer: Layer.empty })
                  })
                )
                expect(Result.isFailure(r3)).toBe(true)
                const legPath = path.join(fDir, "legacy.ts")
                const legSrc = `export default { name: "f1", steps: [] }\n`
                yield* Effect.promise(() => fs.writeFile(legPath, legSrc))
                const legDesc = new Descriptor.FlowDescriptor({
                  ...desc,
                  body: new Descriptor.BodyRefModule({ path: legPath, contentDigest: Digest.digest(enc.encode(legSrc)), imports: [] })
                })
                const r4 = yield* Effect.result(Executable.fromDescriptor(legDesc, { delegates: [] }))
                expect(Result.isFailure(r4)).toBe(true)
              }
              return true
            }).pipe(Effect.provide(Layer.mergeAll(platform, Discovery.layer.pipe(Layer.provide(platform))))) as Effect.Effect<boolean, unknown, never>,
          { executions: ioExec, seed: seed + 1 }
        )
      )
      assertPassed(report)
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true })
    }
  }, 90_000)

  it("ModuleMetadata comprehensive schema, effects, placement, model, budget, and escaped-identifier coverage", async () => {
    const cases = [
      `import { Schema } from "effect"\nexport default Flow.make("m1", { description: \`tpl desc\`, model: ["a", "b"], placement: "remote", modelInvocable: false, budget: { maxTokens: 100 }, effects: { reads: ["a"], writes: ["b"], mode: "expected", onConflict: "lane", tier: "compensable" }, payload: Schema.Struct({ a: Schema.Literals(["x", "y"]), b: Schema.optionalKey(Schema.Number), c: Schema.Array(Schema.Boolean), d: Schema.Finite, e: Schema.Int, f: Schema.NonEmptyString }), success: Schema.String, body: () => null })`,
      `import * as Schema from "effect/Schema"\nexport default Flow.make("m2", { description: 'single', model: "fast", placement: "local", effects: { reads: [], writes: [], mode: "hermetic", onConflict: "fail", tier: "irreversible" }, payload: { k: Schema.NullOr(Schema.String), m: Schema.UndefinedOr(Schema.Number), n: Schema.Record(Schema.String, Schema.Unknown) }, body: () => null })`,
      `export default Flow.make("m3", { name: "override-name", description: "d", capabilities: ["cap:a"], effects: { reads: 123, writes: null, mode: "bad", onConflict: "bad", tier: "bad" }, placement: "bad", modelInvocable: "bad", body: () => null })`,
      `const x = 1; export default Flow.make(dynamicTag, { description: dynamicDesc, body: () => null })`
    ]
    const arb = Arbitrary.schema(Schema.Struct({ i: Schema.Literals([0, 1, 2, 3]) }))
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ i }) =>
          Effect.sync(() => {
            const m = ModuleMetadata.parse(cases[i]!)
            expect(m).toBeDefined()
            return true
          }),
        { executions: fastExec, seed: seed + 2 }
      )
    )
    assertPassed(report)
  }, 60_000)
})
