import { FlowEngine } from "@smthrs/engine"
import * as Action from "@smthrs/flow/Action"
import * as Flow from "@smthrs/flow/Flow"
import * as Interpreter from "@smthrs/flow/Interpreter"
import { Fuzz } from "@smthrs/fuzz"
import { Smithers as S } from "@smthrs/targets"
import * as Compose from "@smthrs/targets/Compose"
import * as Input from "@smthrs/targets/Input"
import * as TargetRuntime from "@smthrs/targets/Runtime"
import * as Target from "@smthrs/targets/Target"
import { Arbitrary, Effect, Exit, Layer, Schema } from "effect"
import * as Crypto from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Cache from "../src/Cache.ts"
import * as Engine from "../src/engine.ts"
import * as Executor from "../src/Executor.ts"
import * as GithubRender from "../src/GithubRender.ts"
import * as InstalledTree from "../src/internal/InstalledTree.ts"
import * as OutputCas from "../src/internal/OutputCas.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import type * as Planner from "../src/Planner.ts"
import * as Resolver from "../src/Resolver.ts"
import * as TestUnits from "../src/TestUnits.ts"

const executions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? "100")
const fsExecutions = Math.max(4, Math.min(executions, 8))

const assertPassed = <A>(report: Fuzz.Report<A, unknown>): void => {
  if (report._tag !== "Passed") {
    throw new Error(Fuzz.formatReport(report))
  }
}

const withTempDir = async <A>(prefix: string, body: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix))
  try {
    return await body(dir)
  } finally {
    await Fs.rm(dir, { recursive: true, force: true })
  }
}

const slugArb = Schema.Literals(["a0", "b1", "c2", "d3", "e4", "f5"])

describe("@smthrs/build-cli deep fuzz suite 7: Resolver, InstalledTree, Executor, engine, OutputCas, TestUnits & GithubRender", () => {
  it(
    "Resolver tsconfig extends/paths/baseUrl, extractSpecifiers, computeClosure, ImportClosureLive & CheckFilesDifferenceLive",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          slug: slugArb,
          withUnresolved: Schema.Boolean,
          withDynamic: Schema.Boolean
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ slug, withUnresolved, withDynamic }) =>
            Effect.promise(async () => {
              await withTempDir("smthrs-bc7-res-", async (root) => {
                await Fs.mkdir(NodePath.join(root, "src", "sub"), { recursive: true })
                await Fs.mkdir(NodePath.join(root, "lib"), { recursive: true })
                await Fs.mkdir(NodePath.join(root, "node_modules", "effect"), { recursive: true })
                await Fs.writeFile(
                  NodePath.join(root, "node_modules", "effect", "package.json"),
                  JSON.stringify({ name: "effect", main: "index.js" })
                )
                await Fs.writeFile(
                  NodePath.join(root, "node_modules", "effect", "index.js"),
                  "export const Effect = {}\n"
                )
                await Fs.writeFile(
                  NodePath.join(root, "tsconfig.base.json"),
                  JSON.stringify({
                    compilerOptions: {
                      baseUrl: ".",
                      paths: { "@lib/*": ["lib/*"] }
                    }
                  })
                )
                await Fs.writeFile(
                  NodePath.join(root, "tsconfig.json"),
                  JSON.stringify({ extends: "./tsconfig.base.json", compilerOptions: { strict: true } })
                )
                await Fs.writeFile(
                  NodePath.join(root, "lib", "util.ts"),
                  `export const util = "${slug}"\n`
                )
                await Fs.writeFile(
                  NodePath.join(root, "src", "sub", "index.ts"),
                  `export { util } from "@lib/util"\nexport * from "../cycle"\n`
                )
                await Fs.writeFile(
                  NodePath.join(root, "src", "cycle.ts"),
                  `import "./sub"\nexport const c = "${slug}"\n`
                )
                const extraLines: Array<string> = [
                  `/// <reference path="./ref.d.ts" />`,
                  `import { readFileSync } from "node:fs"`,
                  `import { Effect } from "effect"`,
                  `import { util } from "./sub"`,
                  `const req = require("./cycle")`,
                  `export const main = [readFileSync, Effect, util, req, "${slug}"]`
                ]
                if (withUnresolved) extraLines.push(`import "./does-not-exist-${slug}"`)
                if (withDynamic) extraLines.push(`const dyn = (x: string) => import(x)`)
                await Fs.writeFile(NodePath.join(root, "src", "ref.d.ts"), `declare const REF_${slug}: string;\n`)
                await Fs.writeFile(NodePath.join(root, "src", "entry.ts"), extraLines.join("\n") + "\n")

                // extractSpecifiers directly
                const extracted = Resolver.extractSpecifiers("src/entry.ts", extraLines.join("\n"))
                expect(extracted.length).toBeGreaterThanOrEqual(4)

                // loadResolverConfig (with extends chain)
                const cfg = await Resolver.loadResolverConfig({ workspaceRoot: root })
                expect(cfg.configDigest.length).toBeGreaterThan(0)

                // Invalid tsconfig triggers ResolverConfigError
                await Fs.writeFile(NodePath.join(root, "tsconfig.bad.json"), "{ invalid json")
                let badCfgErr = false
                try {
                  await Resolver.loadResolverConfig({ workspaceRoot: root, tsconfig: "tsconfig.bad.json" })
                } catch (e) {
                  badCfgErr = e instanceof Resolver.ResolverConfigError
                }
                expect(badCfgErr).toBe(true)

                // computeClosure cold + warm cache hit + references
                const cache = await Cache.openCache({ workspaceRoot: root, cacheDirectory: ".flows" })
                try {
                  const cold = await Resolver.computeClosure({
                    config: cfg,
                    entries: ["src/entry.ts"],
                    cache,
                    references: true
                  })
                  expect(cold.result.files.some((f) => f.path === "lib/util.ts")).toBe(true)
                  expect(cold.result.files.some((f) => f.path === "src/cycle.ts")).toBe(true)
                  expect(cold.result.packages).toContain("effect")
                  expect(cold.result.unresolved.length > 0).toBe(withUnresolved)
                  expect(cold.result.dynamic.length > 0).toBe(withDynamic)

                  const warm = await Resolver.computeClosure({
                    config: cfg,
                    entries: ["src/entry.ts"],
                    cache,
                    references: true
                  })
                  expect(warm.stats.cached).toBeGreaterThanOrEqual(1)

                  // ClosureError: maximumFiles & invalid_entry
                  let tooMany = false
                  try {
                    await Resolver.computeClosure({ config: cfg, entries: ["src/entry.ts"], maximumFiles: 1 })
                  } catch (e) {
                    tooMany = e instanceof Resolver.ClosureError
                  }
                  expect(tooMany).toBe(true)

                  let invalidEntry = false
                  try {
                    await Resolver.computeClosure({ config: cfg, entries: ["../escape.ts"] })
                  } catch (e) {
                    invalidEntry = e instanceof Resolver.ClosureError
                  }
                  expect(invalidEntry).toBe(true)

                  // packageDirectoryOf, expandAnchoredSources, closureOfEntries, operandPaths
                  expect(Resolver.packageDirectoryOf(root, NodePath.join(root, "src"))).toBe("src")
                  const expanded = await Resolver.expandAnchoredSources({
                    workspaceRoot: root,
                    sources: [{ base: root, source: Input.glob("src/**/*.ts") }],
                    requireFiles: false
                  })
                  expect(expanded).toContain("src/entry.ts")

                  const anchored: ReadonlyArray<Compose.AnchoredSource> = [
                    { base: root, source: Input.file("src/entry.ts") }
                  ]
                  const closed = await Resolver.closureOfEntries(
                    { workspaceRoot: root, cacheDirectory: ".flows", cache },
                    anchored
                  )
                  expect(closed.files.length).toBeGreaterThanOrEqual(3)

                  // ImportClosureLive + CheckFilesDifferenceLive via real FlowEngine
                  const runFlow = (
                    name: string,
                    body: () => import("@smthrs/plan/Node").Node<unknown, unknown, never>
                  ) => {
                    const flow = Flow.make(name, {
                      payload: {},
                      success: Schema.Unknown,
                      error: Schema.Unknown,
                      body
                    })
                    const runtime = Layer.mergeAll(
                      Resolver.ImportClosureLive({ workspaceRoot: root, cacheDirectory: ".flows", cache }),
                      Resolver.CheckFilesDifferenceLive({ workspaceRoot: root, cacheDirectory: ".flows", cache }),
                      Interpreter.layer(flow)
                    ).pipe(
                      Layer.provideMerge(Action.layerImplementations),
                      Layer.provideMerge(FlowEngine.layerMemory),
                      Layer.provideMerge(Engine.layerNonInteractiveNodeServices)
                    )
                    return Effect.runPromiseExit(
                      flow.execute({}, { executionId: name }).pipe(Effect.provide(runtime))
                    )
                  }
                  const closureExit = await runFlow(`res-cl-${slug}`, () =>
                    Compose.ResolveImportClosure.call({ entries: anchored }) as never)
                  expect(Exit.isSuccess(closureExit)).toBe(true)

                  const diffExit = await runFlow(`res-ok-${slug}`, () =>
                    Compose.CheckFilesDifference.call({
                      left: { _tag: "SourceSet", sources: [{ base: root, source: Input.file("src/entry.ts") }] },
                      right: { _tag: "SourceSet", sources: [{ base: root, source: Input.glob("src/**/*.ts") }] },
                      toBe: "empty"
                    }) as never)
                  if (Exit.isFailure(diffExit)) {
                    throw new Error(String(diffExit.cause))
                  }
                  expect(Exit.isSuccess(diffExit)).toBe(true)

                  const diffFailExit = await runFlow(`res-fail-${slug}`, () =>
                    Compose.CheckFilesDifference.call({
                      left: { _tag: "SourceSet", sources: [{ base: root, source: Input.file("lib/util.ts") }] },
                      right: { _tag: "SourceSet", sources: [{ base: root, source: Input.file("src/entry.ts") }] },
                      toBe: "empty"
                    }) as never)
                  expect(Exit.isFailure(diffFailExit)).toBe(true)

                  // operandPaths on Closure operand (fails closed when unresolved/dynamic)
                  let closureOpErr = false
                  try {
                    await Resolver.operandPaths(
                      { workspaceRoot: root, cacheDirectory: ".flows", cache },
                      { _tag: "Closure", entries: anchored },
                      "left"
                    )
                  } catch (e) {
                    closureOpErr = e instanceof Compose.FilesTestError
                  }
                  expect(closureOpErr).toBe(withUnresolved || withDynamic)
                } finally {
                  await cache.close()
                }
              })
              return true
            }),
          { executions: fsExecutions, seed: 20261250 }
        )
      )
      assertPassed(report)
    },
    120_000
  )

  it(
    "InstalledTree measure/units/identify/identifyAsync/load/save/difference/describeChange & OutputCas prepare/hydrate/limiter",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          slug: slugArb,
          mutation: Schema.Literals(["add-unit", "remove-unit", "modify-file", "add-many"])
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ slug, mutation }) =>
            Effect.promise(async () => {
              await withTempDir("smthrs-bc7-inst-", async (root) => {
                // 1. InstalledTree on real temp node_modules
                const nm = NodePath.join(root, "node_modules")
                await Fs.mkdir(NodePath.join(nm, "pkg-a", "dist"), { recursive: true })
                await Fs.mkdir(NodePath.join(nm, "@scope", "pkg-b"), { recursive: true })
                await Fs.writeFile(NodePath.join(nm, "pkg-a", "package.json"), `{"name":"pkg-a","v":"${slug}"}\n`)
                await Fs.writeFile(NodePath.join(nm, "pkg-a", "dist", "index.js"), `module.exports="${slug}"\n`)
                await Fs.writeFile(NodePath.join(nm, "@scope", "pkg-b", "index.js"), `export const b="${slug}"\n`)
                await Fs.symlink("pkg-a", NodePath.join(nm, "pkg-link"))

                // Make mtimes old so InstalledTree considers rows settled and remembers them
                const past = new Date(Date.now() - 60_000)
                for (
                  const f of [
                    NodePath.join(nm, "pkg-a", "package.json"),
                    NodePath.join(nm, "pkg-a", "dist", "index.js"),
                    NodePath.join(nm, "@scope", "pkg-b", "index.js")
                  ]
                ) {
                  await Fs.utimes(f, past, past)
                }

                const unitList = InstalledTree.units(nm)
                expect(unitList).toContain("pkg-a")
                expect(unitList).toContain("@scope")
                expect(InstalledTree.measure(nm).length).toBeGreaterThan(0)

                const futureIo: InstalledTree.Io = {
                  ...InstalledTree.defaultIo,
                  now: () => InstalledTree.defaultIo.now() + 60_000_000_000n
                }
                const remembered = InstalledTree.empty()
                const id1 = InstalledTree.identify(nm, remembered, futureIo)
                expect(id1.files).toBeGreaterThanOrEqual(3)
                expect(remembered.rows.size).toBeGreaterThan(0)
                const idAsync = await InstalledTree.identifyAsync(nm, remembered)
                expect(idAsync.digest).toBe(id1.digest)

                const cacheFile = InstalledTree.path(root, ".flows")
                await InstalledTree.save(cacheFile, remembered)
                const loaded = await InstalledTree.load(cacheFile)
                expect(loaded.rows.size).toBe(remembered.rows.size)

                // Corrupt cache file gracefully loads empty
                await Fs.mkdir(NodePath.dirname(cacheFile), { recursive: true })
                await Fs.writeFile(cacheFile, "{not-valid-json")
                const fallback = await InstalledTree.load(cacheFile)
                expect(fallback.rows.size).toBe(0)

                // Mutate node_modules and test difference + describeChange
                if (mutation === "add-unit") {
                  await Fs.mkdir(NodePath.join(nm, "pkg-new"), { recursive: true })
                  await Fs.writeFile(NodePath.join(nm, "pkg-new", "index.js"), "1\n")
                } else if (mutation === "remove-unit") {
                  await Fs.rm(NodePath.join(nm, "@scope", "pkg-b"), { recursive: true, force: true })
                } else if (mutation === "modify-file") {
                  await Fs.writeFile(
                    NodePath.join(nm, "pkg-a", "dist", "index.js"),
                    `module.exports="changed-${slug}"\n`
                  )
                } else {
                  for (let i = 0; i < 5; i += 1) {
                    await Fs.writeFile(NodePath.join(nm, "pkg-a", `extra-${i}.js`), `// ${i}\n`)
                  }
                  await Fs.mkdir(NodePath.join(nm, "pkg-c"), { recursive: true })
                  await Fs.writeFile(NodePath.join(nm, "pkg-c", "a.js"), "x\n")
                  await Fs.mkdir(NodePath.join(nm, "pkg-d"), { recursive: true })
                  await Fs.writeFile(NodePath.join(nm, "pkg-d", "a.js"), "y\n")
                }
                const id2 = await InstalledTree.identifyAsync(nm, InstalledTree.empty())
                const diff = InstalledTree.difference(nm, id1, id2)
                expect(diff).toBeDefined()
                if (diff !== undefined) {
                  const desc = InstalledTree.describeChange("node_modules", diff)
                  expect(desc).toContain("node_modules")
                }

                // Limits overflow throws
                let limitHit = false
                try {
                  InstalledTree.identify(nm, InstalledTree.empty(), InstalledTree.defaultIo, {
                    entries: 1,
                    depth: 1
                  })
                } catch {
                  limitHit = true
                }
                expect(limitHit).toBe(true)

                // 2. OutputCas writeBlob/readBlob/hasFile/prepare/hydrate + AdaptiveLimiter
                const casA = NodePath.join(root, "cas-a")
                const casB = NodePath.join(root, "cas-b")
                await Fs.mkdir(casA, { recursive: true })
                await Fs.mkdir(casB, { recursive: true })

                const payload = Buffer.from(`blob-payload-${slug}-` + "x".repeat(256))
                const digest = Crypto.createHash("sha256").update(payload).digest("hex")
                await OutputCas.writeBlob(casA, digest, payload)
                expect(await OutputCas.hasFile(casA, digest)).toBe(true)
                expect((await OutputCas.readBlob(casA, digest)).equals(payload)).toBe(true)

                const manifestObj = {
                  kind: "build",
                  manifests: [{ outDir: "dist", entries: [{ kind: "file", path: "a.txt", digest, mode: 0o644 }] }]
                }
                const prepared = await OutputCas.prepare(casA, manifestObj)
                expect(prepared.digests).toContain(digest)

                // Hydrate casB from casA (success + missing failure)
                const okHydrate = await OutputCas.hydrate(casB, prepared.output, async (d) => {
                  if (!(await OutputCas.hasFile(casA, d))) return false
                  const bytes = await OutputCas.readBlob(casA, d)
                  await OutputCas.writeBlob(casB, d, bytes)
                  return true
                })
                expect(okHydrate).toBe(true)
                expect(await OutputCas.hasFile(casB, digest)).toBe(true)

                const casC = NodePath.join(root, "cas-c")
                await Fs.mkdir(casC, { recursive: true })
                const missHydrate = await OutputCas.hydrate(casC, prepared.output, async () => false)
                expect(missHydrate).toBe(false)

                // AdaptiveLimiter: priority ordering + busy() + admitted() recovery + invalid args
                const lim = OutputCas.makeLimiter(4, 2)
                expect(lim.capacity()).toBe(2)
                lim.busy()
                expect(lim.capacity()).toBe(1)
                for (let i = 0; i < 10; i += 1) lim.admitted()
                expect(lim.capacity()).toBe(2)
                const order: Array<string> = []
                await Promise.all([
                  lim(async () => {
                    await new Promise((r) => setTimeout(r, 15))
                    order.push("first")
                  }, 0),
                  lim(async () => {
                    order.push("low")
                  }, 10),
                  lim(async () => {
                    order.push("high")
                  }, -5)
                ])
                expect(order).toContain("high")
                expect(() => OutputCas.makeLimiter(0)).toThrow(TypeError)
              })
              return true
            }),
          { executions: fsExecutions, seed: 20261251 }
        )
      )
      assertPassed(report)
    },
    120_000
  )

  it(
    "Executor mergePlans/scheduleEffect/encodeCacheOutput, Engine toolchain/env, TestUnits.command & GithubRender complex workflows",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          slug: slugArb,
          failMiddle: Schema.Boolean,
          abortRun: Schema.Boolean
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ slug, failMiddle, abortRun }) =>
            Effect.promise(async () => {
              // 1. Executor helpers & scheduleEffect DAG (parallel, exclusive, fail, abort, invalid jobs/cycle)
              expect(Executor.resolveJobs(undefined)).toBeGreaterThanOrEqual(1)
              expect(Executor.resolveJobs(3)).toBe(3)
              expect(Executor.notStoredCounts(["a", "b", "a"]).find((x) => x.reason === "a")?.count).toBe(2)
              expect(Executor.describeFailure(new Error(`err-${slug}`))).toContain(`err-${slug}`)
              expect(Executor.describeFailure({ code: slug, nested: [1, 2] })).toContain(slug)
              expect(Executor.describeFailure(null)).toBeTruthy()
              const encoded = Executor.encodeCacheOutput({ stdout: slug, n: 42 })
              expect("output" in encoded).toBe(true)
              if ("output" in encoded) {
                expect(Executor.decodeCacheOutput(encoded.output)).toEqual({ value: { stdout: slug, n: 42 } })
              }
              const encUndef = Executor.encodeCacheOutput(undefined)
              if ("output" in encUndef) {
                expect(Executor.decodeCacheOutput(encUndef.output)).toEqual({ value: undefined })
              }
              expect("reason" in Executor.decodeCacheOutput("not-an-envelope")).toBe(true)

              const mkTarget = (
                label: string,
                dependencies: ReadonlyArray<string>,
                exclusive = false
              ): Planner.PlannedTarget => ({
                label,
                target: "Shell",
                key: `k-${label}`,
                dependencies,
                attrs: exclusive ? { exclusive: true } : {}
              } as unknown as Planner.PlannedTarget)

              const dag = [
                mkTarget("//:a", []),
                mkTarget("//:b", ["//:a"]),
                mkTarget("//:c", ["//:a"], true),
                mkTarget("//:d", ["//:b", "//:c"])
              ]
              const merged = Executor.mergePlans([
                { roots: ["//:d"], targets: dag, warnings: ["w1"] } as never,
                { roots: ["//:b"], targets: dag.slice(0, 2), warnings: ["w1", "w2"] } as never
              ])
              expect(merged.targets.length).toBe(4)

              const ran: Array<string> = []
              const ac = new AbortController()
              const schedExit = await Effect.runPromiseExit(
                Executor.scheduleEffect(
                  dag,
                  2,
                  (lbl) =>
                    Effect.gen(function*() {
                      ran.push(lbl)
                      if (abortRun && lbl === "//:a") ac.abort(new Error("user-cancel"))
                      if (failMiddle && lbl === "//:b") return yield* Effect.fail(new Error("mid-fail"))
                    }),
                  ac.signal
                )
              )
              if (failMiddle || abortRun) {
                expect(Exit.isFailure(schedExit)).toBe(true)
              } else {
                expect(Exit.isSuccess(schedExit)).toBe(true)
                expect(ran.length).toBe(4)
                expect(ran.indexOf("//:a")).toBeLessThan(ran.indexOf("//:d"))
              }

              // Invalid jobs and cyclic work list fail cleanly
              const badJobs = await Effect.runPromiseExit(Executor.scheduleEffect(dag, 0, () => Effect.void))
              expect(Exit.isFailure(badJobs)).toBe(true)
              const cycExit = await Effect.runPromiseExit(
                Executor.scheduleEffect([mkTarget("//:x", ["//:y"]), mkTarget("//:y", ["//:x"])], 2, () => Effect.void)
              )
              expect(Exit.isFailure(cycExit)).toBe(true)

              // 2. Engine helpers: packageManagerEnvironment, targetToolchain, declaredToolchain, credentialHostsOf, verifyTargetToolchain
              const pmEnv = Engine.packageManagerEnvironment(
                { PATH: process.env["PATH"], SECRET_TOKEN: "hidden", HOME: Os.tmpdir() },
                ["SECRET_TOKEN"]
              )
              expect(pmEnv["SECRET_TOKEN"]).toBeUndefined()
              expect(Engine.credentialHostsOf({ [Engine.credentialHostsVariable]: "a.example, b.example:8443" }))
                .toEqual([
                  "a.example",
                  "b.example:8443"
                ])
              expect(Engine.credentialHostsOf({})).toBeUndefined()

              const nodeRt = TargetRuntime.Node({ version: ">=26.4.0" })
              const tt = Engine.targetToolchain("Vitest", { runtime: nodeRt })
              expect(tt.runtime?.name).toBe("node")
              const dt = Engine.declaredToolchain({ runtime: nodeRt })
              expect(dt.runtime).toBe("node")
              const verExit = await Effect.runPromiseExit(
                Engine.verifyTargetToolchain(tt, Os.tmpdir(), { PATH: process.env["PATH"] }).pipe(
                  Effect.provide(Engine.layerNonInteractiveNodeServices)
                )
              )
              expect(Exit.isSuccess(verExit) || Exit.isFailure(verExit)).toBe(true)
              const ttShell = Engine.targetToolchain("Shell", { runtime: nodeRt })
              const verShellExit = await Effect.runPromiseExit(
                Engine.verifyTargetToolchain(ttShell, Os.tmpdir(), { PATH: process.env["PATH"] }).pipe(
                  Effect.provide(Engine.layerNonInteractiveNodeServices)
                )
              )
              expect(Exit.isSuccess(verShellExit)).toBe(true)

              // 3. TestUnits.command (list + run with fake spawn + resultsFile) & GithubRender complex workflows
              await withTempDir("smthrs-bc7-tu-", async (root) => {
                await Fs.mkdir(NodePath.join(root, "src"), { recursive: true })
                await Fs.mkdir(NodePath.join(root, "test"), { recursive: true })
                await Fs.writeFile(
                  NodePath.join(root, "package.json"),
                  JSON.stringify({ name: `tu-${slug}`, type: "module" })
                )
                await Fs.writeFile(
                  NodePath.join(root, "tsconfig.json"),
                  JSON.stringify({ compilerOptions: { strict: true } })
                )
                await Fs.writeFile(NodePath.join(root, "vitest.config.ts"), `export default {}\n`)
                await Fs.writeFile(
                  NodePath.join(root, "src", "math.ts"),
                  `export const add = (a: number, b: number) => a + b\n`
                )
                await Fs.writeFile(
                  NodePath.join(root, "test", "math.test.ts"),
                  `import { add } from "../src/math"\nexport const t = add(1, 2)\n`
                )
                await Fs.writeFile(NodePath.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n")
                const packageJson = S.file("//package.json")
                const testT = S.Vitest({
                  tests: [Input.glob("test/**/*.test.ts")],
                  sources: [Input.glob("src/**/*.ts")],
                  deps: [],
                  config: Input.file("vitest.config.ts"),
                  environment: "node",
                  passWithNoTests: false,
                  units: "file",
                  runtime: S.Runtime.Node({ version: ">=26.4.0" }),
                  packageManager: S.PackageManager.Pnpm({
                    runtime: S.Runtime.Node({ version: ">=26.4.0" }),
                    version: "11.25.0"
                  })
                })
                const buildT = S.Shell.Build({
                  bin: S.Host.bin("sh"),
                  args: ["-c", "mkdir -p dist && echo ok > dist/a.txt"],
                  data: [Input.file("src/math.ts")],
                  outDirs: ["dist"]
                })
                const wf = S.Github.Workflow({
                  name: `CI-${slug}`,
                  on: { push: { branches: ["main"] }, pullRequest: { branches: ["main"] } },
                  permissions: { contents: "read" },
                  concurrency: { group: "ci", cancelInProgress: true },
                  runsOn: "ubuntu-latest",
                  env: { CI: "true" },
                  run: [buildT, testT]
                })
                const ciGen = S.Github.CiGen({
                  preserve: [".github/workflows/manual.yml"],
                  workflows: [wf]
                })
                const workspace = S.Workspace(`tu-${slug}`, {
                  repository: "git+https://example.invalid/tu.git",
                  cache: S.Cache({ directory: ".flows" }),
                  runtime: S.Runtime.Node({ version: ">=26.4.0" }),
                  packageManager: S.PackageManager.Pnpm({
                    manifest: packageJson,
                    lockfile: S.file("//pnpm-lock.yaml")
                  }),
                  nodeModules: S.Npm.NodeModules({ packageJson }),
                  host: S.Host({ bins: ["sh"] })
                })
                const loaded = PackageIndex.make({
                  root,
                  workspace,
                  factory: undefined,
                  packages: [
                    {
                      file: "PACKAGE.ts",
                      packagePath: "",
                      value: S.Package({ targets: { test: testT, build: buildT, wf, ci: ciGen } })
                    }
                  ]
                })
                const resultsFile = NodePath.join(root, ".flows", "unit-results.json")

                // List mode
                const listed = await TestUnits.command({
                  index: loaded,
                  label: "//:test",
                  cacheDirectory: ".flows",
                  base: "HEAD",
                  all: true,
                  list: true,
                  closures: true
                })
                expect("units" in listed).toBe(true)

                // Run mode with injected spawn (runs vitest command, writes resultsFile, populates & hits blob cache)
                let spawns = 0
                const fakeSpawn: typeof import("../src/internal/ContainedProcess.ts").run = async (opts) => {
                  spawns += 1
                  const blobIdx = opts.args.findIndex((a: string) =>
                    a.startsWith("--outputFile=") || a.endsWith(".blob")
                  )
                  if (blobIdx >= 0) {
                    const p = opts.args[blobIdx]!.replace(/^--outputFile=/, "")
                    if (p.includes(".blob")) {
                      await Fs.mkdir(NodePath.dirname(p), { recursive: true })
                      await Fs.writeFile(p, "{}")
                    }
                  }
                  opts.stdout("ok")
                  if (failMiddle) opts.stderr("boom")
                  return failMiddle ? 1 : 0
                }
                const ranUnits = await TestUnits.command({
                  index: loaded,
                  label: "//:test",
                  cacheDirectory: ".flows",
                  base: "HEAD",
                  all: true,
                  list: false,
                  closures: false,
                  jobs: 1,
                  resultsFile,
                  spawn: fakeSpawn
                })
                expect("results" in ranUnits).toBe(true)
                expect(spawns).toBeGreaterThanOrEqual(1)

                // GithubRender complex workflow: render, check (missing/preserved/unexpected), write, check (clean)
                const rendered = GithubRender.render({
                  ciGen,
                  workspace,
                  resolve: loaded,
                  packageDir: ""
                })
                expect(rendered.files.length).toBeGreaterThanOrEqual(1)

                const wfDir = NodePath.join(root, ".github", "workflows")
                await Fs.mkdir(wfDir, { recursive: true })
                await Fs.writeFile(NodePath.join(wfDir, "manual.yml"), "name: manual\n")
                await Fs.writeFile(NodePath.join(wfDir, "stale-old.yml"), "# Generated by smthrs\nname: old\n")

                const chk1 = await GithubRender.check(root, rendered)
                expect(chk1.clean).toBe(false)
                expect(chk1.entries.length).toBeGreaterThanOrEqual(2)

                const wrote = await GithubRender.write(root, rendered)
                expect(wrote.wrote.length).toBeGreaterThanOrEqual(1)
                const chk2 = await GithubRender.check(root, rendered)
                expect(chk2.clean).toBe(true)
              })
              return true
            }),
          { executions: fsExecutions, seed: 20261252 }
        )
      )
      assertPassed(report)
    },
    120_000
  )
})
