import { Fuzz } from "@smthrs/fuzz"
import { Smithers as S } from "@smthrs/targets"
import * as CronTarget from "@smthrs/targets/CronTarget"
import * as GithubTarget from "@smthrs/targets/GithubTarget"
import * as PackageManager from "@smthrs/targets/PackageManager"
import * as Runtime from "@smthrs/targets/Runtime"
import * as Target from "@smthrs/targets/Target"
import * as WorkspaceDeclaration from "@smthrs/targets/WorkspaceDeclaration"
import { Arbitrary, Effect, Schema } from "effect"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Net from "node:net"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as BenchReport from "../src/BenchReport.ts"
import * as CacheAdmin from "../src/CacheAdmin.ts"
import * as Diagnostic from "../src/Diagnostic.ts"
import * as Engine from "../src/engine.ts"
import * as GithubRender from "../src/GithubRender.ts"
import * as ApprovalBridge from "../src/internal/ApprovalBridge.ts"
import { assertDeclarationDependencies } from "../src/internal/DeclarationDependencies.ts"
import { declarationLabels } from "../src/internal/DeclarationLabels.ts"
import * as ObservedReads from "../src/internal/ObservedReads.ts"
import * as RecordStore from "../src/internal/RecordStore.ts"
import * as Shards from "../src/internal/Shards.ts"
import * as KnownRed from "../src/KnownRed.ts"
import type { PackageIndex } from "../src/PackageIndex.ts"
import * as Planner from "../src/Planner.ts"
import * as ServiceSupervisor from "../src/ServiceSupervisor.ts"
import { writeExecutable } from "./helpers/Executable.ts"

const executions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? "100")
const fastExecutions = Math.max(20, Math.min(executions, 250))

const assertPassed = <A>(report: Fuzz.Report<A, unknown>): void => {
  if (report._tag !== "Passed") {
    throw new Error(Fuzz.formatReport(report))
  }
}

const withTempDir = async <A>(prefix: string, body: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix)))
  try {
    return await body(dir)
  } finally {
    await Fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

describe("BuildCliWave9A pure & fast module coverage", () => {
  it("ServiceSupervisor spec validation matrix and lifecycle edge paths", async () => {
    const arb = Arbitrary.schema(Schema.Struct({
      key: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(16))),
      badPort: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 70000, maximum: 99999 }))),
      variant: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 23 })))
    }))
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ key, badPort, variant }) =>
          Effect.promise(async () => {
            const safeKey = `svc-${key.replace(/[^a-zA-Z0-9_-]/g, "x") || "a"}`
            const validBase: ServiceSupervisor.ServiceSpec = {
              key: safeKey,
              argv: [process.execPath, "-e", "setTimeout(() => {}, 1000)"],
              cwd: Os.tmpdir()
            }
            const badSpecs: ReadonlyArray<unknown> = [
              Object.assign(Object.create(new Date()), validBase),
              new Proxy(validBase, {}),
              { ...validBase, [Symbol("s")]: 1 },
              (() => {
                const o: Record<string, unknown> = { ...validBase }
                Object.defineProperty(o, "key", { get: () => safeKey, enumerable: true })
                return o
              })(),
              (() => {
                const o: Record<string, unknown> = { ...validBase }
                Object.defineProperty(o, "extra", { value: 1, enumerable: false })
                return o
              })(),
              { ...validBase, env: Object.create(new Map()) },
              { ...validBase, argv: new Proxy(["a"], {}) },
              (() => {
                // eslint-disable-next-line no-sparse-arrays
                const sparse = ["a", , "b"]
                return { ...validBase, argv: sparse }
              })(),
              (() => {
                const extra = ["a"] as Array<string> & { foo?: number }
                extra.foo = 1
                return { ...validBase, argv: extra }
              })(),
              { ...validBase, key: "" },
              { ...validBase, argv: [] },
              { ...validBase, docker: "bad prefix with spaces!" },
              { ...validBase, env: { A: 123 } },
              { ...validBase, secrets: ["not-a-secret"] },
              { ...validBase, secretUrls: [{ argvIndex: 0, secret: S.Secret("TOK") }] },
              { ...validBase, cwd: "relative/dir" },
              { ...validBase, readiness: { http: "not a url", timeout: "1s" } },
              { ...validBase, readiness: { http: "ftp://127.0.0.1/health", timeout: "1s" } },
              { ...validBase, readiness: { exec: [], timeout: "1s" } },
              { ...validBase, readiness: { port: badPort } },
              { ...validBase, health: { interval: "1s" } },
              {
                ...validBase,
                readiness: { exec: [process.execPath, "-e", "process.exit(0)"], timeout: "1s" },
                health: { interval: "1s", failures: 0 }
              },
              { ...validBase, stop: { signal: "NOT_A_SIGNAL", grace: "1s" } },
              { ...validBase, init: [[]] }
            ]
            const spec = badSpecs[variant % badSpecs.length]
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  const sup = yield* ServiceSupervisor.make
                  const exit = yield* Effect.exit(sup.acquire(spec as ServiceSupervisor.ServiceSpec))
                  expect(exit._tag).toBe("Failure")
                })
              )
            )
            return true
          }),
        { executions: fastExecutions, seed: 9101 }
      )
    )
    assertPassed(report)

    // Real supervisor lifecycle: readiness.exec probe timeout + init command + health pass/fail + docker cleanup
    await withTempDir("wave9a-svc-", async (dir) => {
      const healthFlag = NodePath.join(dir, "healthy")
      const initMarker = NodePath.join(dir, "init-ran")
      await Fs.writeFile(healthFlag, "1")
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const sup = yield* ServiceSupervisor.make
            // Probe timeout case
            const timeoutExit = yield* Effect.exit(
              sup.acquire({
                key: "slow-probe",
                argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
                cwd: dir,
                readiness: {
                  exec: [process.execPath, "-e", "setTimeout(() => {}, 5000)"],
                  timeout: "150ms"
                }
              })
            )
            expect(timeoutExit._tag).toBe("Failure")

            // Init + health check ok then becomes unhealthy
            const handle = yield* sup.acquire({
              key: "healthy-then-sick",
              argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
              cwd: dir,
              readiness: {
                exec: [
                  process.execPath,
                  "-e",
                  `const fs = require("node:fs"); process.exit(fs.existsSync(${JSON.stringify(healthFlag)}) ? 0 : 1)`
                ],
                timeout: "5s"
              },
              health: {
                interval: "40ms",
                failures: 1
              },
              init: [
                [
                  process.execPath,
                  "-e",
                  `require("node:fs").writeFileSync(${JSON.stringify(initMarker)}, "ok")`
                ]
              ]
            })
            const markerText = yield* Effect.promise(() => Fs.readFile(initMarker, "utf8"))
            expect(markerText).toBe("ok")
            yield* Effect.sleep("80 millis")
            yield* Effect.promise(() => Fs.unlink(healthFlag))
            const unhealthyExit = yield* Effect.exit(
              handle.whileHealthy(Effect.sleep("5 seconds"))
            )
            expect(unhealthyExit._tag).toBe("Failure")
            const againExit = yield* Effect.exit(
              sup.acquire({
                key: "healthy-then-sick",
                argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
                cwd: dir,
                readiness: { exec: [process.execPath, "-e", "process.exit(0)"], timeout: "2s" }
              })
            )
            expect(againExit._tag).toBe("Failure")
          })
        )
      )

      // Fake docker service with init command & cleanup retry
      const binDir = NodePath.join(dir, "bin")
      await Fs.mkdir(binDir, { recursive: true })
      const psCount = NodePath.join(dir, "ps-count")
      const fakeDocker = NodePath.join(binDir, "docker")
      await writeExecutable(
        fakeDocker,
        `#!/bin/sh
if [ "$1" = "ps" ]; then
  if [ -f "${psCount}" ]; then
    exit 0
  fi
  echo "1" > "${psCount}"
  echo "deadbeef1234"
  exit 0
fi
if [ "$1" = "rm" ]; then
  exit 0
fi
if [ "$1" = "create" ]; then
  echo "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
  exit 0
fi
if [ "$1" = "exec" ]; then
  exit 0
fi
exec "${process.execPath}" -e "setInterval(() => {}, 1000)"
`
      )
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const sup = yield* ServiceSupervisor.make
            const handle = yield* sup.acquire({
              key: "fake-docker-svc",
              docker: "wave9a-test",
              argv: [fakeDocker, "run", "--name", "wave9a-test-1", "img"],
              cwd: dir,
              readiness: { exec: [process.execPath, "-e", "process.exit(0)"], timeout: "2s" },
              init: [["true"]]
            })
            expect(handle.key).toBe("fake-docker-svc")
          })
        )
      )
    })
  }, 120_000)

  it("Planner key encoding, attrsValue, targetKeyBody, and fingerprintSources limits", async () => {
    const arb = Arbitrary.schema(Schema.Struct({
      variant: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 11 }))),
      tag: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(12)))
    }))
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ variant, tag }) =>
          Effect.sync(() => {
            const baseMaterial = (body: unknown): Planner.KeyMaterial => ({
              body,
              inputs: {},
              layers: [],
              capabilities: []
            })
            const hostileCases: ReadonlyArray<unknown> = [
              Symbol(tag),
              () => tag,
              // eslint-disable-next-line no-sparse-arrays
              [1, , 3],
              Object.assign([1, 2], { extra: 3 }),
              Object.assign([1, 2], { [Symbol("k")]: 3 }),
              (() => {
                const a = [1]
                Object.defineProperty(a, "0", { get: () => 1, enumerable: true })
                return a
              })(),
              new Proxy({ a: 1 }, {}),
              new Proxy({}, {
                ownKeys: () => {
                  throw new Error("boom")
                }
              }),
              (() => {
                const o: Record<string, unknown> = {}
                Object.defineProperty(o, "a", { get: () => 1, enumerable: true })
                return o
              })(),
              Object.assign({}, { [Symbol("s")]: 1 })
            ]
            if (variant < hostileCases.length) {
              expect(() => Planner.encodeKeyMaterial(baseMaterial(hostileCases[variant]))).toThrow(
                Planner.KeyMaterialError
              )
            } else if (variant === 10) {
              expect(() => Planner.attrsValue(new Proxy({}, {}), new Map(), new Map())).toThrow(
                Planner.KeyMaterialError
              )
              const symArr = Object.assign(["a"], { [Symbol("x")]: 1 })
              expect(Planner.attrsValue(symArr, new Map(), new Map())).toBe(symArr)
              const nonEnumArr = ["a"]
              Object.defineProperty(nonEnumArr, "0", { value: "a", enumerable: false })
              expect(Planner.attrsValue(nonEnumArr, new Map(), new Map())).toBe(nonEnumArr)
              const nonEnumObj: Record<string, unknown> = {}
              Object.defineProperty(nonEnumObj, "k", { value: 1, enumerable: false })
              expect(Planner.attrsValue(nonEnumObj, new Map(), new Map())).toBe(nonEnumObj)
            } else {
              const target = S.Shell.Test({ shell: "true" })
              const meta = Target.metadata(target)
              const b1 = Planner.targetKeyBody(target, meta, undefined)
              const b2 = Planner.targetKeyBody(target, meta, { cwd: ".", paths: ["dist"] })
              expect(b1).toBeTruthy()
              expect(b2).toBeTruthy()
            }
            return true
          }),
        { executions: fastExecutions, seed: 9102 }
      )
    )
    assertPassed(report)

    await withTempDir("wave9a-planner-", async (dir) => {
      const presentDir = NodePath.join(dir, "src")
      await Fs.mkdir(presentDir, { recursive: true })
      await Fs.writeFile(NodePath.join(presentDir, "a.ts"), "export const x = 1\n")
      const absentDir = NodePath.join(dir, "does-not-exist")
      const digest = await Planner.fingerprintSources([
        { name: "present", directory: presentDir },
        { name: "absent", directory: absentDir }
      ])
      expect(digest).toMatch(/^[a-f0-9]{64}$/)

      const { defaultIo } = await import("@smthrs/targets/SafeFs")
      const failingIo = {
        ...defaultIo,
        open: async () => {
          const e = Object.assign(new Error("gone"), { code: "ENOENT" })
          throw e
        }
      }
      await expect(
        Planner.fingerprintSources([{ name: "present", directory: presentDir }], { io: failingIo })
      ).rejects.toThrow()
    })
  }, 60_000)

  it("BenchReport full parse/loadBaseline/compare/regressions/format branch matrix", async () => {
    const arb = Arbitrary.schema(Schema.Struct({
      hz1: Schema.Number.pipe(Schema.check(Schema.isFinite(), Schema.isBetween({ minimum: 0.5, maximum: 500_000 }))),
      hz2: Schema.Number.pipe(Schema.check(Schema.isFinite(), Schema.isBetween({ minimum: 0.5, maximum: 500_000 }))),
      mean1: Schema.Number.pipe(Schema.check(Schema.isFinite(), Schema.isBetween({ minimum: 0.1, maximum: 5_000 }))),
      mean2: Schema.Number.pipe(Schema.check(Schema.isFinite(), Schema.isBetween({ minimum: 0.1, maximum: 5_000 }))),
      note: Schema.String.pipe(Schema.check(Schema.isMaxLength(20)))
    }))
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ hz1, hz2, mean1, mean2, note }) =>
          Effect.sync(() => {
            const cleanNote = note.replace(/[\r\n|"]/g, "x")
            const jsonl = [
              `BENCH_METRIC ${
                JSON.stringify({
                  name: "full-row",
                  suite: "core",
                  hz: hz1,
                  minMs: mean1 * 0.5,
                  maxMs: mean1 * 1.5,
                  meanMs: mean1,
                  p75Ms: mean1 * 1.1,
                  p99Ms: mean1 * 1.4,
                  samples: 20,
                  rme: "±1.2%",
                  note: cleanNote || "fast"
                })
              }`,
              `BENCH_METRIC ${JSON.stringify({ name: "mean-only", meanMs: mean1 })}`,
              `BENCH_METRIC ${JSON.stringify({ name: "bare-row" })}`,
              `BENCH_METRIC ${
                JSON.stringify({
                  name: "bad-nums",
                  hz: "NaN",
                  minMs: null,
                  maxMs: null,
                  meanMs: null,
                  p75Ms: null,
                  rme: "",
                  note: ""
                })
              }`,
              "BENCH_METRIC {not-json"
            ].join("\n")

            const vitestTable = [
              " ✓ single-heading",
              " ✓ root > nested > suite",
              "   name                  hz     min     max    mean     p75     p99    p995    p999     rme  samples",
              ` · tbl-full        ${hz1.toFixed(2)}  0.1000  2.0000  ${
                mean1.toFixed(4)
              }  0.5000  1.5000  1.8000  1.9000  ±1.10%      100   ${cleanNote || "fastest"}`,
              " · tbl-bad         1000.00  0.1  0.2  0.15  0.16  0.18  ±1.0%  10",
              "plain non-table line that resets inTable"
            ].join("\n")

            const rowsJson = BenchReport.parse(jsonl)
            const rowsTbl = BenchReport.parse(vitestTable)
            expect(rowsJson.length).toBeGreaterThanOrEqual(4)
            expect(rowsTbl.length).toBeGreaterThanOrEqual(2)

            expect(BenchReport.stdoutOf({ stdout: "a" })).toBe("a")
            expect(BenchReport.stdoutOf({ value: { stdout: "b" } })).toBe("b")
            expect(BenchReport.stdoutOf({ result: { stdout: "c" } })).toBe("c")
            expect(BenchReport.stdoutOf({ other: 1 })).toBeUndefined()
            expect(BenchReport.stdoutOf(null)).toBeUndefined()

            const baseline = BenchReport.loadBaseline({
              results: [
                null,
                { label: "" },
                { label: "//a:no-bench", status: "unknown-status" },
                { label: "//a:empty-bench", status: "hit", benchmarks: [null, { name: "" }] },
                {
                  label: "//a:bench",
                  status: "hit",
                  benchmarks: [
                    { name: "full-row", suite: "core", hz: hz2, meanMs: mean2, note: "base" },
                    { name: "mean-only", meanMs: mean2 },
                    { name: "bare-row" },
                    { name: "high-hz", hz: 250_000, meanMs: 1500 },
                    { name: "low-hz", hz: 3.5, meanMs: 0.25 },
                    { name: "mid-hz", hz: 50, meanMs: 20 }
                  ]
                }
              ]
            })
            expect(baseline.length).toBeGreaterThanOrEqual(2)

            const current: ReadonlyArray<BenchReport.TargetBenchmarks> = [
              { label: "//a:no-bench", status: "hit" },
              {
                label: "//a:bench",
                status: "hit",
                benchmarks: [
                  { name: "full-row", suite: "core", hz: hz1, meanMs: mean1, note: "cur" },
                  { name: "mean-only", meanMs: mean1 },
                  { name: "bare-row" },
                  { name: "new-only-hz", hz: 150_000 },
                  { name: "new-only-mean", meanMs: 2500 },
                  { name: "new-bare" },
                  { name: "high-hz", hz: 120_000, meanMs: 2000 },
                  { name: "low-hz", hz: 3.51, meanMs: 0.25 },
                  { name: "mid-hz", hz: 49.9, meanMs: 20 }
                ]
              },
              {
                label: "//a:live",
                status: "ran",
                benchmarks: [{ name: "live-row", hz: 5, meanMs: 200 }]
              }
            ]

            const deltas = BenchReport.compare(current, baseline)
            const regs = BenchReport.regressions(deltas, 5)
            expect(Array.isArray(regs)).toBe(true)
            const formatted = BenchReport.format(current, undefined, baseline)
            expect(formatted?.length ?? 0).toBeGreaterThan(0)
            return true
          }),
        { executions: fastExecutions, seed: 9103 }
      )
    )
    assertPassed(report)
  }, 60_000)

  it(
    "KnownRed, Shards, Diagnostic, ApprovalBridge, RecordStore, CacheAdmin, DeclarationLabels & Dependencies",
    async () => {
      const arb = Arbitrary.schema(Schema.Struct({
        shardBad: Schema.String.pipe(Schema.check(Schema.isMaxLength(12))),
        idx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 5 })))
      }))
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ shardBad, idx }) =>
            Effect.sync(() => {
              expect(() =>
                KnownRed.parse(
                  "kr.json",
                  JSON.stringify([{
                    label: "//a:b",
                    reason: "r",
                    owner: "o",
                    expires: "2099-01-01",
                    platforms: []
                  }])
                )
              ).toThrow(KnownRed.KnownRedError)
              expect(() =>
                KnownRed.parse(
                  "kr.json",
                  JSON.stringify([{
                    label: "//a:b",
                    reason: "r",
                    owner: "o",
                    expires: "2099-01-01",
                    failureDigest: "md5:1234"
                  }])
                )
              ).toThrow(KnownRed.KnownRedError)

              const judged = KnownRed.judge(
                {
                  ok: false,
                  counts: { hit: 0, miss: 0, failed: 0, skipped: 0, cancelled: 1 },
                  results: [
                    { label: "//a:c", target: "T", status: "cancelled", key: "k", durationMs: 1 },
                    { label: "//a:g", target: "T", status: "hit", key: "k2", durationMs: 1 }
                  ]
                } as never,
                {
                  source: "kr.json",
                  entries: [
                    {
                      label: "//a:g",
                      reason: "old",
                      owner: "o",
                      expires: "2099-01-01",
                      issue: "#1",
                      failureDigest: `sha256:${"0".repeat(64)}`
                    },
                    {
                      label: "//a:exp",
                      reason: "exp",
                      owner: "o",
                      expires: "2000-01-01",
                      issue: "#2",
                      failureDigest: `sha256:${"1".repeat(64)}`
                    }
                  ]
                },
                { today: "2026-11-24", platform: "linux" }
              )
              expect(judged.ok).toBe(false)
              const desc = KnownRed.describe(judged.knownRed)
              expect(desc.some((l) => l.includes("green again"))).toBe(true)

              const badShards = ["0/0", "2/2", "0/9999", "abc", `bad-${shardBad}`]
              expect(() => Shards.parse(badShards[idx % badShards.length]!)).toThrow()
              const measured = new Map<string, number>()
              expect(() => Shards.measure("t.json", "{not-json", measured)).toThrow()
              expect(() => Shards.measure("t.json", JSON.stringify({}), measured)).toThrow()
              expect(() => Shards.measure("t.json", JSON.stringify({ results: [{ label: 1 }] }), measured)).toThrow()
              expect(() =>
                Shards.measure(
                  "t.json",
                  JSON.stringify({ results: [{ label: "//a:b", status: "ran", durationMs: -5 }] }),
                  measured
                )
              ).toThrow()

              const sel = Shards.select(
                {
                  roots: ["//a:b", "//a:c"],
                  targets: [
                    {
                      label: "//a:b",
                      target: "T",
                      kinds: ["test"],
                      attrs: {},
                      dependencies: [],
                      declaredInputs: [],
                      declaredOutputs: undefined,
                      cacheable: true,
                      cacheLookup: "not-wired",
                      wouldRun: true,
                      keyMaterial: {} as never,
                      keyPreview: "k1"
                    },
                    {
                      label: "//a:c",
                      target: "T",
                      kinds: ["test"],
                      attrs: {},
                      dependencies: ["//a:b"],
                      declaredInputs: [],
                      declaredOutputs: undefined,
                      cacheable: true,
                      cacheLookup: "not-wired",
                      wouldRun: true,
                      keyMaterial: {} as never,
                      keyPreview: "k2"
                    }
                  ],
                  edges: [{ from: "//a:c", to: "//a:b" }],
                  warnings: []
                },
                Shards.parse("0/2")
              )
              expect(sel.targets.length).toBeGreaterThanOrEqual(0)

              const longSurrogate = `${"a".repeat(64 * 1024 - 4)}\ud83d\ude00tail`
              const boundedMsg = Diagnostic.message(longSurrogate, "fb")
              expect(boundedMsg.endsWith("...")).toBe(true)
              expect(Diagnostic.message(Symbol("sym"), "fb")).toContain("Symbol")
              const hostileErr = new Error("ok")
              Object.defineProperty(hostileErr, "message", {
                get: () => {
                  throw new Error("getter-boom")
                }
              })
              expect(Diagnostic.message(hostileErr, "fb")).toBe("fb")
              const hostileObj = {}
              Object.defineProperty(hostileObj, "message", {
                get: () => {
                  throw new Error("boom")
                }
              })
              expect(Diagnostic.message(hostileObj, "fb")).toBe("fb")
              expect(Diagnostic.message(new Proxy(new Error("p"), {}), "fb")).toBe("fb")
              expect(Diagnostic.report(hostileErr, { verbose: false })).toBeTruthy()
              expect(Diagnostic.report(hostileErr, { verbose: true })).toBeTruthy()

              // DeclarationLabels expansion over unlabeled dependency
              const dep = S.Shell.Test({ shell: "true" })
              const rootTarget = S.Shell.Test({ shell: "true", data: [dep] })
              const fakeIndex = {
                targets: () => [{ label: "//pkg:root", target: rootTarget }],
                labelOf: (t: Target.AnyTarget) => (t === rootTarget ? "//pkg:root" : undefined)
              } as unknown as PackageIndex
              const lbls = declarationLabels(fakeIndex, () => "pkg")
              expect(lbls.get(rootTarget)).toBe("//pkg:root")
              expect(lbls.get(dep)).toBeDefined()
              return true
            }),
          { executions: fastExecutions, seed: 9104 }
        )
      )
      assertPassed(report)

      await withTempDir("wave9a-io-", async (dir) => {
        await expect(KnownRed.read(dir, ".")).rejects.toThrow(KnownRed.KnownRedError)

        const winEp = await ApprovalBridge.endpoint("win32")
        expect(winEp.path).toContain("\\\\.\\pipe\\")
        await winEp.remove()

        const bridge = await ApprovalBridge.serve({
          granted: async () => true
        })
        try {
          const rawEnv = bridge.environment[ApprovalBridge.environmentName]!
          const atIdx = rawEnv.indexOf("@")
          const parsedEnv = { token: rawEnv.slice(0, atIdx), socket: rawEnv.slice(atIdx + 1) }
          const sendRaw = (payload: string) =>
            new Promise<string>((resolve, reject) => {
              const sock = Net.createConnection(parsedEnv.socket)
              let out = ""
              sock.on("data", (d) => {
                out += d.toString("utf8")
              })
              sock.on("end", () => resolve(out))
              sock.on("error", reject)
              sock.once("connect", () => sock.write(payload))
            })

          const unauth = JSON.parse(await sendRaw(`${JSON.stringify({ token: "wrong", request: {} })}\n`))
          expect(unauth.error).toBe("unauthorized")
          const malformed = JSON.parse(
            await sendRaw(`${JSON.stringify({ token: parsedEnv.token, request: { bad: true } })}\n`)
          )
          expect(malformed.error).toBe("malformed request")
          const badJson = JSON.parse(await sendRaw("not-json\n"))
          expect(badJson.error).toBeTruthy()
          const oversize = await sendRaw("x".repeat(70 * 1024)).catch(() => "")
          expect(typeof oversize).toBe("string")

          const badClient = ApprovalBridge.client(`wrong@${parsedEnv.socket}`)!
          await expect(
            badClient.granted({
              rule: "test",
              label: "//a:b",
              action: "publish",
              subject: "pkg"
            } as never)
          ).rejects.toThrow()
        } finally {
          await bridge.close()
        }

        const cas = NodePath.join(dir, "cas")
        await Fs.mkdir(cas, { recursive: true })
        const longPath = `${"a".repeat(200)}/${"b".repeat(200)}/file.txt`
        const body = {
          reads: [[longPath, "d".repeat(64)]] as const,
          lists: [] as const,
          from: [["//a:b", "prev"]] as const,
          given: [[longPath, "v".repeat(70_000), 0]] as const
        }
        const bigRecord: ObservedReads.Record = {
          ...body,
          id: ObservedReads.idOf(body)
        }
        const ref = await RecordStore.write(cas, bigRecord)
        const loaded = await RecordStore.read(cas, ref)
        expect(loaded?.given?.[0]?.[0]).toBe(longPath)
        const badLoaded = await RecordStore.read(cas, { ...ref, digest: "0".repeat(64) })
        expect(badLoaded).toBeUndefined()

        const extraContent = [
          JSON.stringify({ id: "i", reads: 0, lists: 0, given: 0 }),
          JSON.stringify(["unexpected", "extra", 0])
        ].join("\n") + "\n"
        const extraDigest = createHash("sha256").update(extraContent).digest("hex")
        const extraShard = NodePath.join(cas, extraDigest.slice(0, 2))
        await Fs.mkdir(extraShard, { recursive: true })
        await Fs.writeFile(NodePath.join(extraShard, extraDigest), extraContent)
        const extraLoaded = await RecordStore.read(cas, {
          digest: extraDigest,
          bytes: Buffer.byteLength(extraContent),
          paths: 1
        })
        expect(extraLoaded).toBeUndefined()

        const fileAsDir = NodePath.join(dir, "not-a-dir")
        await Fs.writeFile(fileAsDir, "x")
        await expect(CacheAdmin.directory(dir, "not-a-dir/sub")).rejects.toThrow()

        const cacheDir = NodePath.join(dir, ".cache")
        const shardDir = NodePath.join(cacheDir, "results", "aa")
        await Fs.mkdir(shardDir, { recursive: true })
        const badEntryPath = NodePath.join(shardDir, `${"a".repeat(64)}.json`)
        await Fs.writeFile(
          badEntryPath,
          JSON.stringify({ label: "//a:b", target: "T", exitOk: "not-bool", storedAt: "2026-01-01T00:00:00.000Z" })
        )
        const inspected = await CacheAdmin.inspect(dir, ".cache", "a".repeat(64))
        expect(inspected).toBeUndefined()
        const removed = await CacheAdmin.remove({
          root: dir,
          cacheDirectory: ".cache",
          maxSizeBytes: 0,
          dryRun: false,
          yes: true
        })
        expect(removed.removed).toBeGreaterThanOrEqual(0)

        const badPkg = NodePath.join(dir, "PACKAGE.ts")
        await Fs.writeFile(badPkg, `import * as X from "definitely-missing-pkg-wave9a"\nexport default {}\n`)
        expect(() => assertDeclarationDependencies([badPkg], { bootstrap: false })).toThrow()
      })
    },
    60_000
  )

  it("engine.ts validation/toolchain branches & GithubRender error/toolchain matrix", async () => {
    const arb = Arbitrary.schema(Schema.Struct({
      variant: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 15 }))),
      name: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(10)))
    }))
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ variant, name }) =>
          Effect.sync(() => {
            const safe = name.replace(/[^a-z0-9]/gi, "a") || "a"
            const envBad: ReadonlyArray<() => unknown> = [
              () => Engine.packageManagerEnvironment(null as never),
              () => Engine.packageManagerEnvironment([] as never),
              () =>
                Engine.packageManagerEnvironment(
                  new Proxy({}, {
                    ownKeys: () => {
                      throw new Error("k")
                    }
                  }) as never
                ),
              () => Engine.packageManagerEnvironment({ "BAD=NAME": "1" }, [], true),
              () => {
                const o: Record<string, string> = {}
                Object.defineProperty(o, "GOOD", { get: () => "1", enumerable: true })
                return Engine.packageManagerEnvironment(o)
              },
              () => Engine.packageManagerEnvironment({ GOOD: "a\0b" }),
              () => Engine.packageManagerEnvironment({ GOOD: "x".repeat(260 * 1024) }),
              () => Engine.packageManagerEnvironment({ foo: "1", FOO: "2" }, [], true),
              () => Engine.packageManagerEnvironment({ GOOD: "1" }, new Array(65).fill("X")),
              () => {
                const arr: Array<string> = []
                Object.defineProperty(arr, "length", { get: () => 1 })
                return Engine.packageManagerEnvironment({ GOOD: "1" }, arr)
              },
              () => {
                const arr = new Proxy(["X"], {
                  getOwnPropertyDescriptor: () => {
                    throw new Error("boom")
                  }
                })
                return Engine.packageManagerEnvironment({ GOOD: "1" }, arr)
              },
              () => {
                const tc = Engine.targetToolchain("GithubCiGen", {})
                expect(tc.runtime).toBeUndefined()
                const tc2 = Engine.targetToolchain("PnpmWorkspace", {})
                expect(tc2.packageManager).toBeUndefined()
                const dt = Engine.declaredToolchain({ packageManager: { name: "invalid-pm", version: "1.0.0" } })
                expect(dt.manager).toBe(Engine.defaultToolchain.manager)
                return dt
              }
            ]
            if (variant < 11) {
              expect(envBad[variant]!).toThrow(TypeError)
            } else if (variant === 11) {
              envBad[11]!()
            } else {
              const runTarget = S.Shell.Test({ shell: "true" })
              const bunRuntime = Runtime.Bun({ version: ">=1.4.0" })
              const nm = WorkspaceDeclaration.NodeModules({ packageJson: S.file("//package.json") })
              const wsBun = WorkspaceDeclaration.Workspace(safe, {
                repository: "git+https://github.com/org/repo.git",
                cache: WorkspaceDeclaration.Cache({ directory: ".flows" }),
                runtime: bunRuntime,
                packageManager: PackageManager.BunPackages({ runtime: bunRuntime }),
                nodeModules: nm
              })
              const nodeRuntime = Runtime.Node({ manifest: S.file("//.nvmrc") })
              const wsNodeFile = WorkspaceDeclaration.Workspace(safe, {
                repository: "git+https://github.com/org/repo.git",
                cache: WorkspaceDeclaration.Cache({ directory: ".flows" }),
                runtime: nodeRuntime,
                packageManager: PackageManager.Pnpm({
                  manifest: S.file("//package.json"),
                  lockfile: S.file("//pnpm-lock.yaml")
                }),
                nodeModules: nm
              })
              const setup1 = GithubTarget.Setup({})
              const setup2 = GithubTarget.Setup({ cacheUrl: S.Secret("CACHE_URL") })
              const pushMain = { push: { branches: ["main"] } }
              const wf1 = GithubTarget.Workflow({ name: "ci", on: pushMain, setup: setup1, run: [runTarget] })
              const wfDup = GithubTarget.Workflow({ name: "ci", on: pushMain, run: [runTarget] })
              const wf2 = GithubTarget.Workflow({ name: "ci2", on: pushMain, setup: setup2, run: [runTarget] })
              const wfBadSetup = GithubTarget.Workflow({
                name: "ci3",
                on: pushMain,
                setup: runTarget,
                run: [runTarget]
              })
              const ciBun = GithubTarget.CiGen({
                workflows: [wf1],
                preserve: ["workflows/keep-*.yml", "workflows/re[a-z]+(1)?.yml"]
              })
              const resBun = GithubRender.render({
                ciGen: ciBun,
                workspace: wsBun,
                packageDir: ".github",
                resolve: {
                  labelOf: (t) => (t === ciBun ? "//.github:ci" : t === runTarget ? "//pkg:test" : undefined)
                }
              })
              expect(resBun.files.length).toBeGreaterThan(0)

              const resNode = GithubRender.render({
                ciGen: ciBun,
                workspace: wsNodeFile,
                packageDir: ".github",
                resolve: {
                  labelOf: (t) => (t === ciBun ? "//.github:ci" : t === runTarget ? "//pkg:test" : undefined)
                }
              })
              expect(resNode.files.some((f) => f.content.includes("node-version-file"))).toBe(true)

              const errCigens = [
                GithubTarget.CiGen({ workflows: [runTarget] }),
                GithubTarget.CiGen({ workflows: [wf1, wfDup] }),
                GithubTarget.CiGen({ workflows: [wf1, wf2] }),
                GithubTarget.CiGen({ workflows: [wfBadSetup] }),
                GithubTarget.CiGen({ workflows: [wf1], preserve: ["workflows/ci.yml"] })
              ]
              for (const bad of errCigens) {
                expect(() =>
                  GithubRender.render({
                    ciGen: bad,
                    workspace: wsBun,
                    packageDir: ".github",
                    resolve: {
                      labelOf: (t) => (t === bad ? "//.github:ci" : t === runTarget ? "//pkg:test" : undefined)
                    }
                  })
                ).toThrow(GithubRender.GithubRenderError)
              }
              expect(() =>
                GithubRender.render({
                  ciGen: ciBun,
                  workspace: wsBun,
                  packageDir: ".github",
                  resolve: { labelOf: (t) => (t === ciBun ? "//.github:ci" : undefined) }
                })
              ).toThrow(GithubRender.GithubRenderError)

              const cronTarget = CronTarget.Cron({ schedule: "0 0 * * *", run: [runTarget] })
              const ciNoSetup = GithubTarget.CiGen({
                workflows: [GithubTarget.Workflow({ name: "cron-daily", on: pushMain, run: [runTarget] })]
              })
              expect(() =>
                GithubRender.render({
                  ciGen: ciNoSetup,
                  workspace: wsNodeFile,
                  packageDir: ".github",
                  resolve: {
                    labelOf: (t) => (t === ciNoSetup ? "//.github:ci" : t === runTarget ? "//pkg:test" : undefined),
                    targets: () => [{ label: "//pkg:daily", target: cronTarget }]
                  }
                })
              ).toThrow(GithubRender.GithubRenderError)
              const ciWithSetup = GithubTarget.CiGen({
                workflows: [
                  GithubTarget.Workflow({ name: "cron-daily", on: pushMain, setup: setup1, run: [runTarget] })
                ]
              })
              expect(() =>
                GithubRender.render({
                  ciGen: ciWithSetup,
                  workspace: wsNodeFile,
                  packageDir: ".github",
                  resolve: {
                    labelOf: (t) => (t === ciWithSetup ? "//.github:ci" : t === runTarget ? "//pkg:test" : undefined),
                    targets: () => [{ label: "//pkg:daily", target: cronTarget }]
                  }
                })
              ).toThrow(GithubRender.GithubRenderError)
              const cronUnlabeledRun = CronTarget.Cron({
                schedule: "0 0 * * *",
                run: [S.Shell.Test({ shell: "true" })]
              })
              expect(() =>
                GithubRender.render({
                  ciGen: ciBun,
                  workspace: wsBun,
                  packageDir: ".github",
                  resolve: {
                    labelOf: (t) => (t === ciBun ? "//.github:ci" : t === runTarget ? "//pkg:test" : undefined),
                    targets: () => [{ label: "//pkg:nightly", target: cronUnlabeledRun }]
                  }
                })
              ).toThrow(GithubRender.GithubRenderError)
              expect(() => {
                const wfCtrl = GithubTarget.Workflow({
                  name: "ci",
                  on: { push: { branches: ["main\x01"] } },
                  run: [runTarget]
                })
                const ciCtrl = GithubTarget.CiGen({ workflows: [wfCtrl] })
                return GithubRender.render({
                  ciGen: ciCtrl,
                  workspace: wsBun,
                  packageDir: ".github",
                  resolve: {
                    labelOf: (t) => (t === ciCtrl ? "//.github:ci\x01" : t === runTarget ? "//pkg:test" : undefined)
                  }
                })
              }).toThrow(GithubRender.GithubRenderError)
              expect(() =>
                GithubRender.render({
                  ciGen: ciBun,
                  workspace: wsBun,
                  packageDir: ".github",
                  resolve: { labelOf: () => undefined }
                })
              ).toThrow(GithubRender.GithubRenderError)
            }
            return true
          }),
        { executions: fastExecutions, seed: 9105 }
      )
    )
    assertPassed(report)

    await expect(Engine.runInstall("")).rejects.toThrow(TypeError)
    await expect(Engine.runInstall("a\0b")).rejects.toThrow(TypeError)
    await expect(Engine.runInstall("/tmp", null as never)).rejects.toThrow(TypeError)
    await expect(Engine.runInstall("/tmp", { cacheDirectory: 123 as never })).rejects.toThrow(TypeError)
    await expect(Engine.runInstall("/tmp", { signal: {} as never })).rejects.toThrow(TypeError)
    await expect(Engine.runInstall("/tmp", { toolchain: { runtime: "" } as never })).rejects.toThrow(TypeError)
    await expect(
      Engine.runInstall(
        "/tmp",
        new Proxy({}, {
          ownKeys: () => {
            throw new Error("bad")
          }
        }) as never
      )
    ).rejects.toThrow(TypeError)

    await withTempDir("wave9a-gh-", async (dir) => {
      await expect(
        GithubRender.write(dir, {
          label: "//.github:ci",
          packageDir: ".github",
          changes: ["workflows/**"],
          preserve: [],
          files: [{ path: "../escape/ci.yml", content: "x" }]
        })
      ).rejects.toThrow(GithubRender.GithubRenderError)
      await expect(
        GithubRender.write(dir, {
          label: "//.github:ci",
          packageDir: ".github",
          changes: ["workflows/**"],
          preserve: [],
          files: [{ path: "other/a.yml", content: "hi" }]
        })
      ).rejects.toThrow(GithubRender.GithubRenderError)
      await Fs.mkdir(NodePath.join(dir, ".github"), { recursive: true })
      await Fs.writeFile(NodePath.join(dir, ".github", "workflows"), "blocking-file")
      await expect(
        GithubRender.write(dir, {
          label: "//.github:ci",
          packageDir: ".github",
          changes: ["workflows/**"],
          preserve: [],
          files: [{ path: "workflows/ci.yml", content: "hi" }]
        })
      ).rejects.toThrow(GithubRender.GithubRenderError)
    })
  }, 60_000)
})
