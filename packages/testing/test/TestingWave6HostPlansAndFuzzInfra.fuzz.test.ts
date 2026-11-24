import { Action, Flow } from "@smthrs/flow"
import * as Graph from "@smthrs/flow/Graph"
import { Fuzz } from "@smthrs/fuzz"
import * as BrowserFileSystem from "@smthrs/platform-browser/BrowserFileSystem"
import { Arbitrary, Clock, Effect, Exit, FileSystem, Layer, Random, Schema, Scope } from "effect"
import * as PlatformError from "effect/PlatformError"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import * as TestClock from "effect/testing/TestClock"
import { mkdtempSync, rmSync } from "node:fs"
import * as NodeFs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, type TestAPI, type TestContext } from "vitest"
import * as FuzzV8Coverage from "../src/FuzzV8Coverage.ts"
import * as HostSuite from "../src/HostSuite.ts"
import * as InternalFuzz from "../src/internal/fuzz.ts"
import * as FuzzRegistration from "../src/internal/FuzzRegistration.ts"
import * as ScoreSuite from "../src/internal/ScoreSuite.ts"
import * as Structural from "../src/internal/Structural.ts"
import * as TestEffectRunner from "../src/internal/TestEffectRunner.ts"
import { expectJournal } from "../src/JournalAssertions.ts"
import * as Plan from "../src/Plan.ts"
import { expectKeyGoldens, expectPlan, expectPlans, expectPure } from "../src/PlanAssertions.ts"
import * as ScoreGate from "../src/ScoreGate.ts"
import * as TestHost from "../src/TestHost.ts"
import * as TestLayers from "../src/TestLayers.ts"
import * as VitestAdapter from "../src/Vitest.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "60")
const pureExecs = Math.max(15, Math.min(baseExecutions, 80))
const ioExecs = Math.max(6, Math.min(Math.ceil(baseExecutions / 8), 16))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261127")

const property = <A, E>(
  input: Arbitrary.Arbitrary<A>,
  executions: number,
  check: (value: A) => Effect.Effect<void, E>
) =>
  Effect.runPromise(Fuzz.run(input, (value) => check(value).pipe(Effect.as(true)), { seed, executions }))
    .then((report) => {
      expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
    })

const intBetween = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })))
const bool = Arbitrary.schema(Schema.Boolean)
const word = Arbitrary.schema(Schema.Literals(["alpha", "beta", "gamma", "delta"]))

// Exercise Vitest.testEffect directly!
const te = VitestAdapter.testEffect(TestHost.layer({ files: { "/hello.txt": "world" } }))
const teLive = VitestAdapter.testEffect(Layer.empty)

describe("Wave-6 testing HostSuite, TestHost, Plan/Journal assertions, Structural, ScoreSuite, FuzzV8Coverage & Vitest", () => {
  te.effect("exercises VitestAdapter.testEffect.effect with deterministic TestClock", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      expect(yield* fs.readFileString("/hello.txt")).toBe("world")
    }))

  teLive.live("exercises VitestAdapter.testEffect.live with real Clock", () =>
    Effect.gen(function*() {
      const now = yield* Clock.currentTimeMillis
      expect(now).toBeGreaterThan(0)
    }))

  te.scoped("exercises VitestAdapter.testEffect.scoped alias", () =>
    Effect.gen(function*() {
      const rnd = yield* Random.Random
      expect(typeof rnd.nextDoubleUnsafe()).toBe("number")
    }))

  it(
    "runs HostSuite against TestHost and fuzzes HostSuite capability/scratch edge cases + TestHost MemoryFs & StubBash",
    () =>
      property(
        Arbitrary.all({
          fileName: word,
          content: word,
          cmdSeed: intBetween(1, 1000),
          cmdExit: intBetween(0, 2)
        }),
        Math.min(ioExecs, 6),
        (s) =>
          Effect.gen(function*() {
            const profile: HostSuite.HostProfile = {
              fileSystem: { supported: true },
              path: { supported: true },
              shell: { supported: true, interruptCommand: ChildProcess.make("host-suite-pending") },
              jj: { supported: false, code: "not_installed" },
              httpTransport: { supported: false, code: "TransportError" },
              clock: { supported: true },
              random: { supported: true }
            }
            const bundle = TestHost.layer({
              seed: s.cmdSeed,
              files: { [`/init/${s.fileName}.txt`]: s.content },
              commands: {
                "host-suite-pending": { pending: true },
                "echo-ok": { stdout: s.content, stderr: "err", exitCode: s.cmdExit, delayMs: 1 }
              }
            })

            // Run ALL HostSuite cases against TestHost!
            for (const tc of HostSuite.hostSuite(bundle, profile)) {
              yield* tc.run
            }

            // Exercise HostSuite scratch error branches: dangling symlink + permission denied
            const tmpDir = mkdtempSync(join(tmpdir(), "testing-wave6-hostsuite-"))
            try {
              const scratch = join(tmpDir, "scratch")
              const target = join(tmpDir, "target")
              yield* Effect.promise(() => NodeFs.symlink(target, scratch, "file"))
              const symCase = HostSuite.hostSuite(
                Layer.merge(bundle, Layer.succeed(FileSystem.FileSystem)(BrowserFileSystem.make(NodeFs))),
                { ...profile, fileSystemScratchPath: scratch }
              )[0]!
              const symExit = yield* Effect.exit(symCase.run)
              expect(Exit.isFailure(symExit)).toBe(true)

              const denied = PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "makeDirectory"
              })
              const permFs = FileSystem.makeNoop({
                exists: () => Effect.succeed(false),
                makeDirectory: () => Effect.fail(denied)
              })
              const permCase = HostSuite.hostSuite(
                Layer.merge(bundle, Layer.succeed(FileSystem.FileSystem)(permFs)),
                { ...profile, fileSystemScratchPath: "/denied" }
              )[0]!
              const permExit = yield* Effect.exit(permCase.run)
              expect(Exit.isFailure(permExit)).toBe(true)
            } finally {
              rmSync(tmpDir, { recursive: true, force: true })
            }

            // Exercise TestHost MemoryFs + StubBash + layerSeededRandom deeply
            yield* Effect.scoped(
              Effect.gen(function*() {
                const fs = yield* FileSystem.FileSystem
                const spawner = yield* ChildProcessSpawner
                expect(yield* fs.readFileString(`/init/${s.fileName}.txt`)).toBe(s.content)
                yield* fs.makeDirectory("/sub/deep", { recursive: true })
                yield* fs.writeFileString("/sub/deep/a.txt", s.content)
                expect(yield* fs.exists("/sub/deep/a.txt")).toBe(true)
                const st = yield* fs.stat("/sub/deep/a.txt")
                expect(st.type).toBe("File")
                yield* fs.writeFileString("/sub/deep/b.txt", s.content)
                yield* fs.writeFileString("/sub/deep/c.txt", s.content)
                const entries = yield* fs.readDirectory("/sub/deep")
                expect(entries).toContain("c.txt")
                yield* fs.remove("/sub/deep/c.txt")
                expect(yield* fs.exists("/sub/deep/c.txt")).toBe(false)
                // Missing file fails
                expect(Exit.isFailure(yield* Effect.exit(fs.readFileString("/nope.txt")))).toBe(true)
                // StubBash: known command & unknown command
                const h1 = yield* spawner.spawn(ChildProcess.make("echo-ok"))
                expect(Number(yield* h1.exitCode)).toBe(s.cmdExit)
                const h2 = yield* spawner.spawn(ChildProcess.make("unknown-cmd"))
                expect(Number(yield* h2.exitCode)).toBe(127)
              })
            ).pipe(Effect.provide(bundle))

            // TestHost.layerSeededRandom determinism
            const r1 = yield* Effect.map(Random.Random, (r) => r.nextDoubleUnsafe()).pipe(
              Effect.provide(TestHost.layerSeededRandom(s.cmdSeed))
            )
            const r2 = yield* Effect.map(Random.Random, (r) => r.nextDoubleUnsafe()).pipe(
              Effect.provide(TestHost.layerSeededRandom(s.cmdSeed))
            )
            expect(r1).toBe(r2)
          })
      ),
    120_000
  )

  it("fuzzes Plan, PlanAssertions, JournalAssertions, Structural, and ScoreSuite across passing & failing branches", () =>
    property(
      Arbitrary.all({
        nodeA: word,
        nodeB: word,
        runId: word,
        scoreA: intBetween(0, 100),
        scoreB: intBetween(0, 100),
        failRunner: bool,
        dieRunner: bool
      }),
      pureExecs,
      (s) =>
        Effect.gen(function*() {
          const a = `a-${s.nodeA}`
          const b = `b-${s.nodeB}`

          // 1. Plan.planOf, Plan.fromGraph, Plan.keys, Plan.make, Plan.render, Plan.node, Plan.edge
          const actA = Action.make(`wave6/a/${s.nodeA}`, {
            payload: Schema.Struct({ x: Schema.String }),
            success: Schema.String,
            tier: "sealed"
          })
          const actB = Action.make(`wave6/b/${s.nodeB}`, {
            payload: Schema.Struct({ x: Schema.String }),
            success: Schema.String,
            tier: "compensable"
          })
          const myFlow = Flow.make(`wave6-flow-${s.runId}`, {
            payload: Schema.Struct({ x: Schema.String }),
            success: Schema.String,
            body: (input) => actA.call(input)
          })
          const planned = yield* Plan.planOf(myFlow, { x: s.runId }, { runId: s.runId })
          expect(Object.keys(Plan.keys(Graph.build(myFlow, { x: s.runId }), { runId: s.runId })).length)
            .toBeGreaterThan(0)
          expect(typeof Plan.render(planned)).toBe("string")

          const manualPlan = Plan.make({
            nodes: [
              {
                id: a,
                key: `key-${a}`,
                kind: "step",
                placement: { tag: "Local", options: {} },
                effects: ["read:a"],
                mode: "hard",
                tier: "sealed",
                sealed: true
              },
              {
                id: b,
                key: `key-${b}`,
                kind: "effect",
                placement: { tag: "Remote", options: { host: "cf" } },
                effects: ["write:b"],
                tier: "irreversible",
                sealed: false
              }
            ],
            edges: [{ from: a, to: b }],
            envelope: { maxRetries: 3 }
          })
          expect(Plan.node(manualPlan, a)?.id).toBe(a)
          expect(Plan.node(manualPlan, "missing")).toBeUndefined()
          expect(Plan.edge({ from: a, to: b })).toBe(`${a} -> ${b}`)
          const rendered = Plan.render(manualPlan)
          expect(rendered).toContain(a)

          // 2. PlanAssertions (passing AND failing branches!)
          const pa = expectPlan(manualPlan)
          yield* pa.nodeCount(2)
          yield* pa.contains(a)
          yield* pa.edges([[a, b]], { exact: true })
          yield* pa.keys({ [a]: `key-${a}`, [b]: `key-${b}` })
          yield* pa.placement(a, "Local")
          yield* pa.placement(b, { tag: "Remote", options: { host: "cf" } })
          yield* pa.declaresEffects(a, ["read:a"])
          yield* pa.envelope({ maxRetries: 3 })
          yield* pa.matchesSnapshot(rendered)
          yield* pa.node(a).key(`key-${a}`)
          yield* pa.node(a).placement("Local")
          yield* pa.node(a).mode("hard")
          yield* pa.node(a).tier("sealed")
          yield* pa.node(a).declaresEffects(["read:a"])
          yield* expectPlans([manualPlan]).covers([a, b])

          // Failure branches in PlanAssertions
          expect(Exit.isFailure(yield* Effect.exit(pa.nodeCount(99)))).toBe(true)
          expect(Exit.isFailure(yield* Effect.exit(pa.contains("nope")))).toBe(true)
          expect(Exit.isFailure(yield* Effect.exit(pa.edges([[b, a]])))).toBe(true)
          expect(Exit.isFailure(yield* Effect.exit(pa.edges([], { exact: true })))).toBe(true)
          expect(Exit.isFailure(yield* Effect.exit(pa.keys({ [a]: "wrong" })))).toBe(true)
          expect(Exit.isFailure(yield* Effect.exit(pa.placement(a, "Remote")))).toBe(true)
          expect(Exit.isFailure(yield* Effect.exit(pa.placement("nope", "Local")))).toBe(true)
          expect(Exit.isFailure(yield* Effect.exit(pa.declaresEffects(a, ["write:z"])))).toBe(true)
          expect(Exit.isFailure(yield* Effect.exit(pa.envelope({ maxRetries: 9 })))).toBe(true)
          expect(Exit.isFailure(yield* Effect.exit(pa.matchesSnapshot("wrong")))).toBe(true)
          expect(Exit.isFailure(yield* Effect.exit(pa.node(a).mode("expected")))).toBe(true)
          expect(Exit.isFailure(yield* Effect.exit(pa.node(a).tier("compensable")))).toBe(true)
          expect(Exit.isFailure(yield* Effect.exit(expectPlans([manualPlan]).covers([a, "missing"])))).toBe(true)

          // expectKeyGoldens (pass & fail)
          yield* expectKeyGoldens({ [a]: `key-${a}`, [b]: `key-${b}` }, { [a]: `key-${a}`, [b]: `key-${b}` })
          expect(Exit.isFailure(yield* Effect.exit(expectKeyGoldens({ [a]: "k1" }, { [a]: "k2" })))).toBe(true)

          // expectPure (pure passes, impure fails with purity_violation)
          yield* expectPure(Effect.succeed(42))
          const impure = yield* Effect.exit(
            expectPure(Clock.currentTimeMillis).pipe(Effect.provide(TestLayers.poisoned))
          )
          expect(Exit.isFailure(impure)).toBe(true)

          // 3. JournalAssertions (all pass & fail codes)
          const journal = [
            { index: 1, stepKey: a, kind: "step" as const, outcome: "completed" as const },
            {
              index: 2,
              stepKey: b,
              kind: "effect" as const,
              outcome: "completed" as const,
              value: { idempotencyKey: "ik-1" }
            }
          ]
          const ja = expectJournal(journal)
          yield* ja.executed(a)
          yield* ja.executedInOrder([a, b])
          yield* ja.terminal("completed")
          expect(ja.prefix(1).length).toBe(1)
          yield* ja.effect(b).atLeastOnce()
          yield* ja.effect(b).journaledAtMostOnce()
          yield* ja.effect(b).idempotencyKey("ik-1")
          yield* ja.effect("never-ran").journaledAtMostOnce()

          // Failure branches
          expect(Exit.isFailure(yield* Effect.exit(ja.executed("missing")))).toBe(true)
          expect(Exit.isFailure(yield* Effect.exit(ja.executedInOrder([b, a])))).toBe(true)
          expect(Exit.isFailure(yield* Effect.exit(ja.terminal("failed")))).toBe(true)
          expect(Exit.isFailure(yield* Effect.exit(ja.effect(a).atLeastOnce()))).toBe(true) // effect_kind_mismatch
          expect(Exit.isFailure(yield* Effect.exit(ja.effect("missing").atLeastOnce()))).toBe(true) // effect_not_executed
          expect(Exit.isFailure(yield* Effect.exit(ja.effect(a).journaledAtMostOnce()))).toBe(true) // effect_kind_mismatch
          expect(Exit.isFailure(yield* Effect.exit(ja.effect(b).idempotencyKey("wrong")))).toBe(true)
          expect(Exit.isFailure(yield* Effect.exit(ja.effect(a).idempotencyKey("ik-1")))).toBe(true)
          expect(Exit.isFailure(yield* Effect.exit(ja.effect("missing").idempotencyKey("ik-1")))).toBe(true)
          expect(Exit.isFailure(yield* Effect.exit(ja.effect(b).exactlyOnce()))).toBe(true)

          const dupJournal = expectJournal([
            { index: 1, stepKey: b, kind: "effect", outcome: "completed" },
            { index: 2, stepKey: b, kind: "effect", outcome: "completed" }
          ])
          expect(Exit.isFailure(yield* Effect.exit(dupJournal.effect(b).journaledAtMostOnce()))).toBe(true)
          expect(Exit.isFailure(yield* Effect.exit(dupJournal.effect(b).idempotencyKey("ik-1")))).toBe(true)

          // 4. Structural (canonical, same, snapshot, compare) with rich JS types + cycles
          const cyc: Record<string, unknown> = {
            a: s.scoreA,
            b: [1, Number.NaN, -0, +0, BigInt(7), Symbol("sym"), undefined],
            d: new Date(1_700_000_000_000),
            r: /abc/gi,
            m: new Map([["k", 1]]),
            set: new Set([1, 2]),
            u: new Uint8Array([1, 2, 3]),
            e: new Error("err")
          }
          cyc.self = cyc
          const snap = Structural.snapshot(cyc)
          expect(Structural.same(cyc, snap)).toBe(true)
          expect(Structural.same(cyc, { a: 999 })).toBe(false)
          expect(typeof Structural.canonical(cyc)).toBe("string")
          expect(Structural.compare("a", "b")).toBe(-1)
          expect(Structural.compare("b", "a")).toBe(1)
          expect(Structural.compare("a", "a")).toBe(0)

          // 5. ScoreSuite.suite & ciGrade
          const report = yield* ScoreSuite.suite({
            cases: [
              { name: "c1", input: s.scoreA / 100, minScore: 0.5 },
              { name: "c2", input: s.scoreB / 100, minScore: 0.5 }
            ],
            gates: { mean: 0.5, min: 0.4 },
            run: (sc) => {
              if (sc.name === "c2" && s.dieRunner) return Effect.die(new Error("runner-die"))
              if (sc.name === "c2" && s.failRunner) return Effect.fail("runner-fail")
              return Effect.succeed([{ case: sc.name, stepKey: "k", scorer: "q", kind: "score", value: sc.input }])
            }
          })
          const graded = ScoreSuite.ciGrade(report)
          expect([0, 1, 5]).toContain(graded.exitCode)
          expect(typeof graded.summary).toBe("string")
          // Also hit ScoreGate re-export
          expect(typeof ScoreGate.expectScores).toBe("function")
        })
    ))

  it("fuzzes FuzzV8Coverage, internal/fuzz, internal/FuzzRegistration, and internal/TestEffectRunner", () =>
    property(
      Arbitrary.all({
        hits: intBetween(1, 200),
        envMode: intBetween(0, 4),
        abortTest: bool,
        runAsSession: bool,
        withV8: bool
      }),
      Math.min(ioExecs, 10),
      (s) =>
        Effect.gen(function*() {
          // 1. FuzzV8Coverage pure helpers
          const bucket = FuzzV8Coverage.hitBucket(s.hits)
          expect([1, 2, 3, 4, 8, 16, 32, 128]).toContain(bucket)
          const blocks = FuzzV8Coverage.executedBlocks([
            { startOffset: 0, endOffset: 100, count: 5 },
            { startOffset: 20, endOffset: 40, count: 0 },
            { startOffset: 50, endOffset: 80, count: 2 }
          ])
          expect(blocks.length).toBeGreaterThanOrEqual(3)
          expect(FuzzV8Coverage.defaultInclude("file:///app/src/a.ts")).toBe(true)
          expect(FuzzV8Coverage.defaultInclude("node:fs")).toBe(false)
          expect(FuzzV8Coverage.defaultInclude("file:///x/node_modules/a.js")).toBe(false)
          expect(FuzzV8Coverage.defaultInclude("file:///x/packages/fuzz/src/a.ts")).toBe(false)
          expect(FuzzV8Coverage.defaultInclude("file:///x/packages/testing/src/FuzzV8Coverage.ts")).toBe(false)
          expect(FuzzV8Coverage.defaultInclude("")).toBe(false)

          const envMap: Record<string, string | undefined> = s.envMode === 0
            ? {}
            : s.envMode === 1
            ? { EFFECT_FUZZ_V8_COVERAGE: "0" }
            : s.envMode === 2
            ? { EFFECT_FUZZ_V8_COVERAGE: "1" }
            : s.envMode === 3
            ? { EFFECT_FUZZ_V8_COVERAGE: "true" }
            : { EFFECT_FUZZ_V8_COVERAGE: "src/,lib/" }
          const parsedEnv = FuzzV8Coverage.fromEnv(envMap)
          expect(s.envMode <= 1 ? parsedEnv === undefined : parsedEnv !== undefined).toBe(true)

          // FuzzV8Coverage.make with injected Inspector service (working + failing)
          const makeFakeSession = (failOn?: string): FuzzV8Coverage.InspectorSession => ({
            connect: () => {
              if (failOn === "connect") throw new Error("connect-fail")
            },
            disconnect: () => {},
            post: (method, _params, cb) => {
              if (failOn === method) {
                cb?.(new Error(`${method}-fail`))
                return
              }
              cb?.(null, {
                result: [{
                  scriptId: "1",
                  url: "file:///app/src/Target.ts",
                  functions: [{
                    functionName: "fn",
                    ranges: [{ startOffset: 0, endOffset: 50, count: s.hits }],
                    isBlockCoverage: true
                  }]
                }]
              })
            }
          })

          yield* Effect.scoped(
            Effect.gen(function*() {
              const fb = yield* FuzzV8Coverage.make({ include: ["Target.ts"], name: "v8-test" })
              const features: Array<string> = []
              yield* fb.measure(Effect.succeed("ok"), { feature: (f) => features.push(String(f)) })
              expect(features.length).toBeGreaterThan(0)
            }).pipe(Effect.provideService(FuzzV8Coverage.Inspector, () => makeFakeSession()))
          )

          // Faulty Inspector fails cleanly with FuzzError
          const failV8 = yield* Effect.exit(
            Effect.scoped(
              FuzzV8Coverage.make().pipe(
                Effect.provideService(FuzzV8Coverage.Inspector, () => makeFakeSession("Profiler.enable"))
              )
            )
          )
          expect(Exit.isFailure(failV8)).toBe(true)

          // 2. internal/fuzz.ts: session, sessionTimeout, segment, corpusDirectories, fileCorpus, makeTarget, runFuzz
          const dir = mkdtempSync(join(tmpdir(), "testing-wave6-fuzzinfra-"))
          try {
            expect(InternalFuzz.session({}, "test-a")).toBeUndefined()
            const sess = InternalFuzz.session(
              { EFFECT_FUZZ: "1", EFFECT_FUZZ_EXECUTIONS: "5", EFFECT_FUZZ_DURATION: "5000", EFFECT_FUZZ_SEED: "42" },
              "test-a"
            )
            expect(sess?.executions).toBe(5)
            expect(InternalFuzz.session({ EFFECT_FUZZ: "only-other" }, "test-a")).toBeUndefined()
            expect(InternalFuzz.sessionTimeout({ duration: 1000 })).toBeGreaterThan(1000)
            expect(InternalFuzz.segment("hello/world test!")).toMatch(/^[a-z0-9._-]+$/i)

            const dirs = InternalFuzz.corpusDirectories(join(dir, "foo.test.ts"), dir)
            const store = InternalFuzz.fileCorpus(dirs)
            const target = InternalFuzz.makeTarget(
              { n: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 })) },
              (v: { n: number }) => v.n >= 0,
              { id: "wave6-target", revision: "1" }
            )
            yield* InternalFuzz.runFuzz(
              target,
              store,
              { executions: 4, seed: 7 },
              { executions: 4, seed: 7 },
              () => Effect.void
            )
            const loaded = yield* store.load("wave6-target")
            expect(Array.isArray(loaded)).toBe(true)

            // 3. internal/FuzzRegistration.makeMethods with captured TestAPI
            const prevFuzz = process.env.EFFECT_FUZZ
            const prevExecs = process.env.EFFECT_FUZZ_EXECUTIONS
            const prevV8 = process.env.EFFECT_FUZZ_V8_COVERAGE
            try {
              if (s.runAsSession) {
                process.env.EFFECT_FUZZ = "1"
                process.env.EFFECT_FUZZ_EXECUTIONS = "3"
                if (s.withV8) process.env.EFFECT_FUZZ_V8_COVERAGE = "Target.ts"
                else delete process.env.EFFECT_FUZZ_V8_COVERAGE
              } else {
                delete process.env.EFFECT_FUZZ
                delete process.env.EFFECT_FUZZ_EXECUTIONS
                delete process.env.EFFECT_FUZZ_V8_COVERAGE
              }
              const registered: Array<(ctx: TestContext) => Promise<void>> = []
              const fakeTest = ((_name: string, _opts: unknown, fn: (ctx: TestContext) => Promise<void>) => {
                registered.push(fn)
              }) as unknown as TestAPI
              const methods = FuzzRegistration.makeMethods(fakeTest, () => makeFakeSession())
              methods.fuzz("sync-case", [Schema.Boolean], ([b]: [boolean]) => typeof b === "boolean", {
                fuzz: { executions: 3, seed: 1 }
              })
              methods.effect.fuzz(
                "eff-case",
                { b: Schema.Boolean },
                ({ b }) => Effect.succeed(typeof b === "boolean"),
                {
                  fuzz: { executions: 3, seed: 1 }
                }
              )
              const fakeCtx = {
                task: { fullTestName: "wave6-reg-test", file: { filepath: join(dir, "reg.test.ts") } },
                signal: new AbortController().signal
              } as unknown as TestContext
              for (const fn of registered) {
                yield* Effect.promise(() => fn(fakeCtx))
              }
            } finally {
              if (prevFuzz === undefined) delete process.env.EFFECT_FUZZ
              else process.env.EFFECT_FUZZ = prevFuzz
              if (prevExecs === undefined) delete process.env.EFFECT_FUZZ_EXECUTIONS
              else process.env.EFFECT_FUZZ_EXECUTIONS = prevExecs
              if (prevV8 === undefined) delete process.env.EFFECT_FUZZ_V8_COVERAGE
              else process.env.EFFECT_FUZZ_V8_COVERAGE = prevV8
            }

            // 4. internal/TestEffectRunner.runEffectTest (normal + aborted)
            const ctrl = new AbortController()
            if (s.abortTest) {
              const runP = TestEffectRunner.runEffectTest(
                Layer.empty,
                TestClock.layer(),
                () => Effect.never,
                ctrl.signal
              )
              ctrl.abort()
              const ex = yield* Effect.exit(Effect.tryPromise(() => runP))
              expect(Exit.isFailure(ex)).toBe(true)
            } else {
              const out = yield* Effect.promise(() =>
                TestEffectRunner.runEffectTest(Layer.empty, TestClock.layer(), Effect.succeed(123), ctrl.signal)
              )
              expect(out).toBe(123)
            }
          } finally {
            rmSync(dir, { recursive: true, force: true })
          }
        })
    ), 120_000)
})
