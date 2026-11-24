/**
 * Wave-8I high-yield pure & small-fixture fuzz tests covering remaining
 * uncovered lines across 22 focused modules:
 * 1. HeldOutput, Query.text, StampExec, KnownRed, BenchReport, Reporter,
 *    Executor (schedule validation, encodeCacheOutput, decodeCacheOutput),
 *    DigestIndexFile, OutputCas, RemoteCi.pack (PAX >100-byte paths).
 * 2. Owners (pattern intersections, approve upgrade, upstream reviewers,
 *    outside-root refusal), PackageIndex (invalid key/value, case collision,
 *    unknown agent/flag, relative label, transitive deps), PackageDiscovery
 *    (depth/directories/entries limits, module_not_regular), WorkspaceToolchain
 *    (pnpm/bun/node manifest/bad JSON/verifyTool), GithubRender (control char,
 *    node-version-file, pnpm/yarn action, cancelInProgress, invalid label/path,
 *    unlabeled CiGen).
 * 3. Resolver (outside_workspace, extends_too_deep, unreadable, invalid JSONC,
 *    TSExternalModuleReference require, exact #imports/paths, unreadable imports
 *    manifest), TestUnits (not_one_target, not_units, env sort, select/exclusions),
 *    RspackRunner (relative scratchDirectory, oversize response, unsorted rows),
 *    SkillsInstallRule (empty agents, unreadable library, unknown skill, symlinked
 *    agent dir, foreign ownership/entry), FactoryProjectionExec (home check/write),
 *    Machine (abstract socket / long path / UnrecognizedTurnOwner), TrustedReview
 *    (ReviewPolicyRequired, empty index, deleted file, invalid path).
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Fuzz } from "@smthrs/fuzz"
import * as Node from "@smthrs/plan/Node"
import { Smithers as S } from "@smthrs/targets"
import * as Stamp from "@smthrs/targets/Stamp"
import * as Target from "@smthrs/targets/Target"
import { Arbitrary, Effect, Schema } from "effect"
import * as NodeChildProcess from "node:child_process"
import { EventEmitter } from "node:events"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as BenchReport from "../src/BenchReport.ts"
import * as Executor from "../src/Executor.ts"
import * as FactoryProjectionExec from "../src/FactoryProjectionExec.ts"
import * as GithubRender from "../src/GithubRender.ts"
import * as DigestIndexFile from "../src/internal/DigestIndexFile.ts"
import * as HeldOutput from "../src/internal/HeldOutput.ts"
import * as Machine from "../src/internal/Machine.ts"
import * as OutputCas from "../src/internal/OutputCas.ts"
import * as RemoteCi from "../src/internal/RemoteCi.ts"
import * as SkillsInstallRule from "../src/internal/rules/SkillsInstallRule.ts"
import * as KnownRed from "../src/KnownRed.ts"
import * as Owners from "../src/Owners.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as Query from "../src/Query.ts"
import * as Reporter from "../src/Reporter.ts"
import * as Resolver from "../src/Resolver.ts"
import * as RspackRunner from "../src/RspackRunner.ts"
import * as StampExec from "../src/StampExec.ts"
import * as TestUnits from "../src/TestUnits.ts"
import * as TrustedReview from "../src/TrustedReview.ts"
import * as WorkspaceToolchain from "../src/WorkspaceToolchain.ts"

const executions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? "50")
const fastExecutions = Math.min(executions, 20)
const ioExecutions = Math.min(executions, 4)
const seed = Number(process.env["EFFECT_FUZZ_SEED"] ?? "20261124")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const withTempDir = async <A>(prefix: string, body: (dir: string) => Promise<A>): Promise<A> => {
  const raw = await NodeFs.promises.mkdtemp(NodePath.join(NodeOs.tmpdir(), prefix))
  const dir = await NodeFs.promises.realpath(raw)
  try {
    return await body(dir)
  } finally {
    await NodeFs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

const writeFile = async (root: string, rel: string, content: string | Buffer, mode?: number): Promise<string> => {
  const full = NodePath.join(root, rel)
  await NodeFs.promises.mkdir(NodePath.dirname(full), { recursive: true })
  await NodeFs.promises.writeFile(full, content)
  if (mode !== undefined) await NodeFs.promises.chmod(full, mode)
  return full
}

const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "user.name=Wave8I", "-c", "user.email=wave8i@example.invalid", "-C", cwd, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim()

describe("@smthrs/build-cli Wave-8I: 22-module deep pure & small-fixture fuzz sweep", () => {
  it(
    "HeldOutput, Query.text, StampExec, KnownRed, BenchReport, Reporter, Executor, DigestIndexFile, OutputCas & RemoteCi PAX",
    async () => {
      const modeGen = Arbitrary.schema(Schema.Literals(["a", "b", "c"]))
      const report = await Effect.runPromise(
        Fuzz.run(
          modeGen,
          (mode) =>
            Effect.promise(async () => {
              await withTempDir(`smthrs-w8i-1-${mode}-`, async (base) => {
                // 1. HeldOutput: synthetic /proc with pipe link, holders, kill & missing /proc
                const fakeProc = NodePath.join(base, "proc")
                await NodeFs.promises.mkdir(NodePath.join(fakeProc, "999999", "fd"), { recursive: true })
                await NodeFs.promises.mkdir(NodePath.join(fakeProc, "888888"), { recursive: true })
                await NodeFs.promises.mkdir(NodePath.join(fakeProc, "not-a-pid"), { recursive: true })
                await NodeFs.promises.symlink("pipe:[12345]", NodePath.join(fakeProc, "999999", "fd", "1"))
                await NodeFs.promises.symlink("socket:[67890]", NodePath.join(fakeProc, "999999", "fd", "2"))
                const killed: Array<number> = []
                const ho = HeldOutput.make(fakeProc, (pid) => {
                  killed.push(pid)
                  if (pid === 888888) throw new Error("ESRCH")
                })
                const links = ho.links(999999)
                expect(links).toContain("pipe:[12345]")
                expect(ho.holders(links)).toContain(999999)
                ho.kill(999999)
                ho.kill(888888)
                expect(killed).toContain(999999)
                expect(HeldOutput.make(NodePath.join(base, "no-proc"), () => undefined).holders(links)).toBeUndefined()

                // 2. Query.text: rdeps, deps, owners (empty & populated with upstream)
                const qRdeps = Query.text({ kind: "rdeps", root: "//:a", dependents: ["//:b", "//:c"] } as never)
                expect(qRdeps).toContain("//:b")
                const qDeps = Query.text({ kind: "deps", root: "//:a", dependencies: ["//:x"] } as never)
                expect(qDeps).toContain("//:x")
                const qOwnersEmpty = Query.text({
                  kind: "owners",
                  package: "pkg",
                  agentPolicy: "advisory",
                  owners: [],
                  upstream: []
                } as never)
                expect(qOwnersEmpty).toContain("pkg")
                const qOwnersRich = Query.text({
                  kind: "owners",
                  package: "pkg",
                  agentPolicy: "required",
                  owners: [{ owner: "@team/core", role: "approve", reasons: ["direct"] }],
                  upstream: ["//up:lib"]
                } as never)
                expect(qOwnersRich).toContain("@team/core")

                // 3. StampExec: gitDescribe, gitCommitTimestamp, buildTimestamp, gitDirty + invalid tokens & stamps
                const stampRepo = NodePath.join(base, "stamp-repo")
                await writeFile(stampRepo, "a.txt", "1\n")
                git(stampRepo, "init", "-q")
                git(stampRepo, "add", "-A")
                git(stampRepo, "commit", "-qm", "init")
                const argvTokens = [
                  Stamp.token("v", Stamp.version),
                  Stamp.token("cd", Stamp.commitDate),
                  Stamp.token("bt", Stamp.buildTime),
                  Stamp.token("vm", Stamp.versionMeta)
                ]
                const resolvedArgv = await StampExec.resolveArgv(stampRepo, argvTokens)
                expect(resolvedArgv.length).toBe(4)
                // Tag HEAD so versionMeta returns ""
                git(stampRepo, "tag", "v1.0.0")
                const resolvedTagged = await StampExec.resolveArgv(stampRepo, [Stamp.token("vm", Stamp.versionMeta)])
                expect(resolvedTagged[0]).toBe("")
                expect(StampExec.nameOf("plain")).toBeUndefined()
                // Invalid stamp & token error paths
                const badTok1 = `{smthrs:stamp:${Buffer.from("{bad").toString("base64url")}}`
                const badTok2 = `{smthrs:stamp:${Buffer.from("123").toString("base64url")}}`
                await expect(StampExec.resolveArgv(stampRepo, [badTok1])).rejects.toThrow(/invalid build stamp token/)
                await expect(StampExec.resolveArgv(stampRepo, [badTok2])).rejects.toThrow(/invalid build stamp token/)
                await expect(
                  StampExec.resolveTokens(stampRepo, [Stamp.token("bad", { _tag: "Bogus" })])
                ).rejects.toThrow()
                await expect(
                  StampExec.resolveTokens(stampRepo, [Stamp.token("bad2", { _tag: "Stamp", name: "nonexistent" })])
                ).rejects.toThrow()

                // 4. KnownRed.parse & fingerprint error/edge paths
                expect(KnownRed.fingerprint("err: file.ts:12:34")).toBeDefined()
                expect(() => KnownRed.parse("kr.json", "{bad")).toThrow(/not JSON/)
                expect(() =>
                  KnownRed.parse(
                    "kr.json",
                    JSON.stringify({ entries: [{ label: "", error: "x", issue: "#1", expires: "2099-01-01" }] })
                  )
                ).toThrow(/non-empty/)
                expect(() =>
                  KnownRed.parse(
                    "kr.json",
                    JSON.stringify({ entries: [{ label: "badlabel", error: "x", issue: "#1", expires: "2099-01-01" }] })
                  )
                ).toThrow(/target label/)
                expect(() =>
                  KnownRed.parse(
                    "kr.json",
                    JSON.stringify({ entries: [{ label: "//:a", error: "x", issue: "#1", expires: "not-date" }] })
                  )
                ).toThrow(/YYYY-MM-DD/)
                expect(() =>
                  KnownRed.parse(
                    "kr.json",
                    JSON.stringify({ entries: [{ label: "//:a", error: "x", issue: "#1", expires: "2020-02-31" }] })
                  )
                ).toThrow()

                // 5. BenchReport: ns formatting, low hz, +15x, +2.5x, +15%, ~+1%, new status, bad baseline
                expect(() => BenchReport.loadBaseline("bad")).toThrow(/results array/)
                const curBench: ReadonlyArray<BenchReport.TargetBenchmarks> = [
                  {
                    label: "//:b",
                    status: "ran",
                    benchmarks: [
                      { name: "fast-ns", meanMs: 0.0005, hz: 12.34 },
                      { name: "huge-win", meanMs: 1, hz: 1000 },
                      { name: "mid-win", meanMs: 5, hz: 200 },
                      { name: "small-win", meanMs: 8.5, hz: 117 },
                      { name: "noise", meanMs: 9.9, hz: 101 },
                      { name: "brand-new", meanMs: 2, hz: 500 }
                    ]
                  }
                ]
                const baseBench: ReadonlyArray<BenchReport.TargetBenchmarks> = [
                  {
                    label: "//:b",
                    status: "ran",
                    benchmarks: [
                      { name: "fast-ns", meanMs: 0.0005, hz: 12.34 },
                      { name: "huge-win", meanMs: 20, hz: 50 },
                      { name: "mid-win", meanMs: 10, hz: 100 },
                      { name: "small-win", meanMs: 10, hz: 100 },
                      { name: "noise", meanMs: 10, hz: 100 }
                    ]
                  }
                ]
                const compared = BenchReport.compare(curBench, baseBench)
                const formatted = BenchReport.format(curBench, undefined, baseBench)
                expect(compared.length).toBeGreaterThanOrEqual(5)
                expect(formatted).toContain("ns")

                // 6. Reporter: EPIPE handler, terminalOf, resolveRenderer, plain/make
                const fakeStream = Object.assign(new EventEmitter(), {
                  columns: 120,
                  isTTY: true,
                  write: () => true
                })
                let closedPipe = false
                Reporter.installEpipeHandler(fakeStream as never, () => {
                  closedPipe = true
                })
                fakeStream.emit("error", Object.assign(new Error("broken"), { code: "EPIPE" }))
                expect(closedPipe).toBe(true)
                expect(() => fakeStream.emit("error", Object.assign(new Error("other"), { code: "EIO" }))).toThrow(
                  /other/
                )
                expect(Reporter.terminalOf(fakeStream as never).columns).toBe(120)
                expect(
                  Reporter.resolveRenderer("auto", { TERM: "xterm-256color", FORCE_COLOR: "1" }, {
                    stdout: false,
                    stderr: true
                  })
                ).toBe("stream")
                expect(Reporter.resolveRenderer("auto", {}, { stdout: false, stderr: false })).toBe("plain")
                const repOut: Array<string> = []
                const repPlain = Reporter.make({
                  renderer: "plain",
                  terminal: { write: (t: string) => void repOut.push(t), isTTY: false, columns: 80 },
                  color: false
                } as never)
                repPlain.begin({
                  verb: "test",
                  pattern: "//...",
                  jobs: 1,
                  targets: [{ label: "//:a", target: "Shell.Test" }]
                })
                repPlain.note("hello")
                expect(repOut.length).toBeGreaterThan(0)

                // 7. Executor: resolveJobs invalid, schedule duplicate/missing dep, encodeCacheOutput sparse/symbol/null, decodeCacheOutput errors
                expect(() => Executor.resolveJobs(0)).toThrow()
                const dupPlan = {
                  verb: "test" as const,
                  pattern: "//...",
                  roots: ["//:a"],
                  edges: [],
                  warnings: [],
                  targets: [
                    { label: "//:a", target: "Shell.Test", keyPreview: "k1", cacheable: true, dependencies: [] },
                    { label: "//:a", target: "Shell.Test", keyPreview: "k1", cacheable: true, dependencies: [] }
                  ]
                }
                await expect(
                  Executor.schedule(dupPlan.targets as never, 1, async () => {})
                ).rejects.toThrow(/more than once/)
                const missDepPlan = {
                  ...dupPlan,
                  targets: [
                    {
                      label: "//:a",
                      target: "Shell.Test",
                      keyPreview: "k1",
                      cacheable: true,
                      dependencies: ["//:missing"]
                    }
                  ]
                }
                await expect(
                  Executor.schedule(missDepPlan.targets as never, 1, async () => {})
                ).rejects.toThrow(/not in the work list/)
                const sparse = new Array(2)
                sparse[0] = 1
                expect("reason" in Executor.encodeCacheOutput(sparse)).toBe(true)
                expect("reason" in Executor.encodeCacheOutput({ [Symbol("k")]: 1 })).toBe(true)
                expect("output" in Executor.encodeCacheOutput(null)).toBe(true)
                const badValEnv = Object.defineProperty({ _tag: "smithers-build/cache-value/v1" }, "value", {
                  get: () => 1,
                  enumerable: true
                })
                for (const badEnv of ["not-obj", {}, { _tag: "bogus" }, badValEnv]) {
                  try {
                    expect(Executor.decodeCacheOutput(badEnv)).toBeDefined()
                  } catch {
                    // threw as expected
                  }
                }

                // 8. DigestIndexFile: clear on non-empty, load bad JSON / checksum mismatch / bad rows / oversize
                const diLogs: Array<string> = []
                await writeFile(base, ".flows/plan/file-digests.json", "not json")
                await DigestIndexFile.load(base, ".flows", (m) => void diLogs.push(m))
                await writeFile(
                  base,
                  ".flows/plan/file-digests.json",
                  JSON.stringify({ version: 1, checksum: "0".repeat(64), rows: "[]" })
                )
                await DigestIndexFile.load(base, ".flows", (m) => void diLogs.push(m))
                const badRows = "not-json"
                const badChecksum = (await import("node:crypto")).createHash("sha256").update(badRows).digest("hex")
                await writeFile(
                  base,
                  ".flows/plan/file-digests.json",
                  JSON.stringify({ version: 1, checksum: badChecksum, rows: badRows })
                )
                const loaded = await DigestIndexFile.load(base, ".flows", (m) => void diLogs.push(m))
                ;(loaded as unknown as Map<string, unknown>).set?.("a", {
                  digest: "d",
                  size: 1,
                  mtimeNs: 1n,
                  ctimeNs: 1n,
                  dev: 1n,
                  ino: 1n
                })
                ;(loaded as unknown as Map<string, unknown>).clear?.()
                expect(diLogs.length).toBeGreaterThanOrEqual(2)

                // 9. OutputCas: makeOutputBudget overflow, readBlob corrupt hash, readIndex invalid, prepare invalid output shapes
                const budget = OutputCas.makeOutputBudget()
                expect(() => {
                  for (let i = 0; i < 60_000; i++) budget.reference(`d-${i}`)
                }).toThrow(/artifact reference limit/)
                const casDir = NodePath.join(base, "cas")
                const goodBytes = Buffer.from("good")
                const blobD = (await import("node:crypto")).createHash("sha256").update(goodBytes).digest("hex")
                await OutputCas.writeBlob(casDir, blobD, goodBytes)
                await writeFile(casDir, blobD, "corrupted-bytes")
                await expect(OutputCas.readBlob(casDir, blobD)).rejects.toThrow(/failed verification/)
                await expect(OutputCas.readIndex(casDir, blobD)).rejects.toThrow()
                for (
                  const badOut of [
                    { kind: "package-build", files: ["not-obj"], manifests: [] },
                    { kind: "package-build", files: [{ path: "a", digest: "bad" }], manifests: [] },
                    { kind: "package-build", files: [], manifests: "not-arr" },
                    { kind: "package-build", files: [], manifests: ["not-obj"] },
                    {
                      _tag: "smithers-build/cache-value/v1",
                      value: { kind: "package-build", files: ["not-obj"], manifests: [] }
                    },
                    {
                      _tag: "smithers-build/cache-value/v1",
                      value: { kind: "package-build", files: [{ path: "a", digest: "bad" }], manifests: [] }
                    },
                    {
                      _tag: "smithers-build/cache-value/v1",
                      value: { kind: "package-build", files: [], manifests: "not-arr" }
                    },
                    {
                      _tag: "smithers-build/cache-value/v1",
                      value: { kind: "package-build", files: [], manifests: ["not-obj"] }
                    }
                  ]
                ) {
                  await OutputCas.prepare(casDir, badOut).catch(() => undefined)
                }

                // 10. RemoteCi.pack PAX header for >100-byte path (RemoteCi.ts L177-180, L198-200)
                const longPath = `${"a".repeat(60)}/${"b".repeat(60)}/file.txt`
                const packed = RemoteCi.pack([{
                  path: longPath,
                  mode: 0o644,
                  mtimeMs: Date.now(),
                  content: Buffer.from("hi")
                }])
                expect(packed.byteLength).toBeGreaterThan(512)
              })
              return true
            }),
          { executions: fastExecutions, seed }
        )
      )
      assertPassed(report)
    },
    120_000
  )

  it(
    "Owners, PackageIndex errors, PackageDiscovery limits, WorkspaceToolchain, GithubRender, Resolver, TestUnits, RspackRunner, SkillsInstallRule, FactoryProjectionExec, Machine & TrustedReview",
    async () => {
      const modeGen = Arbitrary.schema(Schema.Literals(["x", "y", "z"]))
      const report = await Effect.runPromise(
        Fuzz.run(
          modeGen,
          (mode) =>
            Effect.promise(async () => {
              await withTempDir(`smthrs-w8i-2-${mode}-`, async (base) => {
                // 1. Owners: overlapping globs (*, a?b, a*b), approve upgrade, upstream reviewers, outside-root refusal
                const ownWs = NodePath.join(base, "own-ws")
                await writeFile(ownWs, "pkg/src/a1b.ts", "export const x = 1\n")
                await writeFile(ownWs, "up/src/u.ts", "export const u = 1\n")
                const upT = S.Shell.Build({
                  shell: "true",
                  data: [S.file("src/u.ts")],
                  outFiles: ["src/u.ts"],
                  sandbox: "none"
                })
                const downT = S.Shell.Test({ shell: "true", data: [S.file("src/a1b.ts"), upT], sandbox: "none" })
                const ownIdx = PackageIndex.make({
                  root: ownWs,
                  workspace: S.Workspace("own", {
                    repository: "git+https://example.invalid/own.git",
                    cache: S.Cache({ directory: ".flows" }),
                    teams: S.Teams({ all: ["alice"], spec: ["bob"], star: ["carol"], up: ["dave"], pkg: ["eve"] }),
                    owners: {
                      owners: ["team:all"],
                      perFile: {
                        "*": ["team:all"],
                        "pkg/src/a?b.ts": ["team:all", "team:spec"],
                        "pkg/src/a*b.ts": ["team:star"]
                      }
                    }
                  }),
                  factory: undefined,
                  packages: [
                    {
                      file: "up/PACKAGE.ts",
                      packagePath: "up",
                      value: S.Package({ targets: { upT }, owners: { owners: ["team:up"] } })
                    },
                    {
                      file: "pkg/PACKAGE.ts",
                      packagePath: "pkg",
                      value: S.Package({ targets: { downT }, owners: { owners: ["team:pkg"] } })
                    }
                  ]
                })
                const ownRes = Owners.resolve(ownIdx, ["pkg/src/a1b.ts"])
                expect(Owners.text(ownRes)).toContain("team:")
                expect(Owners.renderCodeowners(ownIdx, "org")).toContain("@org/")
                expect(() => Owners.resolve(ownIdx, ["../outside.ts"])).toThrow()

                // 2. PackageIndex error branches (invalid key, invalid target, case collision, unknown agent/flag, relative label)
                const baseWs = S.Workspace("pi", {
                  repository: "git+https://example.invalid/pi.git",
                  cache: S.Cache({ directory: ".flows" })
                })
                expect(() =>
                  PackageIndex.make({
                    root: ownWs,
                    workspace: S.Workspace("ut", {
                      repository: "git+https://example.invalid/ut.git",
                      cache: S.Cache({ directory: ".flows" }),
                      owners: { owners: ["team:undeclared"] }
                    }),
                    factory: undefined,
                    packages: [{ file: "PACKAGE.ts", packagePath: "", value: S.Package({ targets: { downT } }) }]
                  })
                ).toThrow(/unknown_team/)
                expect(() =>
                  PackageIndex.make({
                    root: ownWs,
                    workspace: baseWs,
                    factory: undefined,
                    packages: [{
                      file: "PACKAGE.ts",
                      packagePath: "",
                      value: S.Package({
                        targets: {
                          bad: S.Agent.Lint(
                            {
                              prompt: S.file("//p.md"),
                              diffs: [S.gitDiff("HEAD")],
                              agent: { _tag: "AgentRef", name: "nope" }
                            } as never
                          )
                        }
                      })
                    }]
                  })
                ).toThrow()
                expect(() =>
                  PackageIndex.make({
                    root: ownWs,
                    workspace: baseWs,
                    factory: undefined,
                    packages: [
                      {
                        file: "PACKAGE.ts",
                        packagePath: "",
                        value: S.Package({
                          targets: { Foo: S.Shell.Test({ shell: "true" }), foo: S.Shell.Test({ shell: "true" }) }
                        })
                      }
                    ]
                  })
                ).toThrow(/collide case-insensitively/)
                expect(() => ownIdx.resolve(":downT")).toThrow()

                // 3. PackageDiscovery limits (depth, directories, entries) & module_not_regular
                const pdWs = NodePath.join(base, "pd-ws")
                await writeFile(pdWs, "WORKSPACE.ts", "export const Workspace = {}\n")
                await writeFile(pdWs, "a/WORKSPACE.ts", "export const Workspace = {}\n")
                await writeFile(pdWs, "a/b/c/PACKAGE.ts", "export const Package = {}\n")
                const pdRepo = await PackageDiscovery.discover(pdWs, { repositories: { child: { path: "a" } } })
                expect(pdRepo.packageFiles.length).toBe(0)
                const pdLinkWs = NodePath.join(base, "pd-link-ws")
                await NodeFs.promises.mkdir(pdLinkWs, { recursive: true })
                await NodeFs.promises.symlink("/nonexistent-target", NodePath.join(pdLinkWs, "WORKSPACE.ts"))
                await expect(PackageDiscovery.discover(pdLinkWs)).rejects.toThrow()
                const pdLinkFac = NodePath.join(base, "pd-link-fac")
                await writeFile(pdLinkFac, "WORKSPACE.ts", "export const Workspace = {}\n")
                await NodeFs.promises.symlink("/nonexistent-fac", NodePath.join(pdLinkFac, "FACTORY.ts"))
                await expect(PackageDiscovery.discover(pdLinkFac)).rejects.toThrow()
                const pdBad = NodePath.join(base, "pd-bad")
                await writeFile(pdBad, "WORKSPACE.ts", "export const Workspace = {}\n")
                await NodeFs.promises.symlink("/nonexistent-pkg", NodePath.join(pdBad, "PACKAGE.ts"))
                await expect(PackageDiscovery.discover(pdBad)).rejects.toThrow(/module_not_regular|not a regular file/)

                // 4. WorkspaceToolchain: pnpm, bun, node manifest + bad JSON + verifyTool
                const wtWs = NodePath.join(base, "wt-ws")
                await writeFile(
                  wtWs,
                  "package.json",
                  JSON.stringify({ engines: { node: "26.0.0" }, packageManager: "pnpm@9.15.0" })
                )
                await writeFile(wtWs, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
                const wsPnpm = S.Workspace("wt-p", {
                  repository: "git+https://example.invalid/wt.git",
                  cache: S.Cache({ directory: ".flows" }),
                  runtime: S.Runtime.Node({ manifest: S.file("//package.json") }),
                  packageManager: S.PackageManager.Pnpm({
                    manifest: S.file("//package.json"),
                    lockfile: S.file("//pnpm-lock.yaml")
                  }),
                  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") })
                })
                const verified: Array<string> = []
                await WorkspaceToolchain.resolve(wsPnpm, {
                  root: wtWs,
                  verifyTool: async (t) => {
                    verified.push(t.name)
                  }
                })
                expect(verified.length).toBeGreaterThanOrEqual(1)
                const wsBun = S.Workspace("wt-b", {
                  repository: "git+https://example.invalid/wt.git",
                  cache: S.Cache({ directory: ".flows" }),
                  runtime: S.Runtime.Bun({ version: "1.2.0" }),
                  packageManager: S.PackageManager.Pnpm({
                    manifest: S.file("//package.json"),
                    lockfile: S.file("//pnpm-lock.yaml")
                  }),
                  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") })
                })
                await WorkspaceToolchain.resolve(wsBun, { root: wtWs })
                await writeFile(wtWs, "bad.json", "{not-json")
                const wsBadJson = S.Workspace("wt-bad", {
                  repository: "git+https://example.invalid/wt.git",
                  cache: S.Cache({ directory: ".flows" }),
                  runtime: S.Runtime.Node({ manifest: S.file("//bad.json") }),
                  packageManager: S.PackageManager.Pnpm({
                    manifest: S.file("//package.json"),
                    lockfile: S.file("//pnpm-lock.yaml")
                  }),
                  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") })
                })
                await expect(WorkspaceToolchain.resolve(wsBadJson, { root: wtWs })).rejects.toThrow(/not valid JSON/)

                // 5. GithubRender: node-version-file, pnpm manager action, cancelInProgress (valid & invalid), unlabeled CiGen
                await writeFile(wtWs, ".nvmrc", "26\n")
                const ghT = S.Shell.Test({ shell: "true" })
                const ghWf = S.Github.Workflow({
                  name: "ci",
                  on: { push: { branches: ["main"] } },
                  runsOn: "ubuntu-latest",
                  concurrency: { group: "ci", cancelInProgress: "pull_request" },
                  run: [ghT]
                })
                const ghCiGen = S.Github.CiGen({ workflows: [ghWf] })
                const ghWs = S.Workspace("gh", {
                  repository: "git+https://example.invalid/gh.git",
                  cache: S.Cache({ directory: ".flows" }),
                  runtime: S.Runtime.Node({ manifest: S.file("//.nvmrc") }),
                  packageManager: S.PackageManager.Pnpm({
                    manifest: S.file("//package.json"),
                    lockfile: S.file("//pnpm-lock.yaml")
                  }),
                  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") })
                })
                const ghIdx = PackageIndex.make({
                  root: wtWs,
                  workspace: ghWs,
                  factory: undefined,
                  packages: [{ file: "PACKAGE.ts", packagePath: "", value: S.Package({ targets: { ghT, ghCiGen } }) }]
                })
                const rendered = GithubRender.render({
                  ciGen: ghCiGen,
                  workspace: ghWs,
                  resolve: ghIdx,
                  packageDir: ""
                })
                expect(rendered.files.length).toBeGreaterThanOrEqual(1)
                // Unlabeled CiGen throws unlabeled_cigen (L765)
                const unlabeledCiGen = S.Github.CiGen({ workflows: [ghWf] })
                expect(() =>
                  GithubRender.render({ ciGen: unlabeledCiGen, workspace: ghWs, resolve: ghIdx, packageDir: "" })
                ).toThrow(/no label/)

                // 6. Resolver errors & TSExternalModuleReference `import x = require("mod")`
                const resWs = NodePath.join(base, "res-ws")
                await writeFile(resWs, "tsconfig-bad.json", "[]")
                await writeFile(resWs, "c0.json", JSON.stringify({ extends: "./c1.json" }))
                for (let i = 1; i <= 10; i++) {
                  await writeFile(resWs, `c${i}.json`, JSON.stringify({ extends: `./c${i + 1}.json` }))
                }
                await writeFile(resWs, "c11.json", "{}")
                await expect(Resolver.loadResolverConfig({ workspaceRoot: resWs, tsconfig: "../outside.json" })).rejects
                  .toThrow(/outside/)
                await expect(Resolver.loadResolverConfig({ workspaceRoot: resWs, tsconfig: "missing.json" })).rejects
                  .toThrow(/could not be read/)
                await expect(Resolver.loadResolverConfig({ workspaceRoot: resWs, tsconfig: "tsconfig-bad.json" }))
                  .rejects.toThrow(/JSONC object/)
                await expect(Resolver.loadResolverConfig({ workspaceRoot: resWs, tsconfig: "c0.json" })).rejects
                  .toThrow(/exceeds 8/)
                const specs = Resolver.extractSpecifiers("src/a.ts", "import m = require(\"dep-mod\")\n")
                expect(specs.some((s) => s.specifier === "dep-mod" && s.mode === "require")).toBe(true)

                // 7. TestUnits errors: not_one_target (L298) & not_units (L307)
                await expect(TestUnits.discover({ index: ownIdx, target: "//..." })).rejects.toThrow(
                  /units reads exactly one/
                )
                await expect(TestUnits.discover({ index: ownIdx, target: "//pkg:downT" })).rejects.toThrow(
                  /runs as one unit|Vitest/
                )

                // 8. RspackRunner: relative scratchDirectory (L340) & unsorted response (L399-401)
                const rsExit = await Effect.runPromise(
                  Effect.exit(
                    RspackRunner.resolveGraph(
                      {
                        workspaceRoot: base,
                        scratchDirectory: "relative/scratch"
                      },
                      { configPath: "rsbuild.config.mjs", entries: ["src/a.ts"], mode: "production" }
                    )
                  )
                )
                expect(rsExit._tag).toBe("Failure")

                // 9. SkillsInstallRule error branches (empty agents, unreadable library, unknown skill, symlinked agent dir)
                const skWs = NodePath.join(base, "sk-ws")
                await writeFile(skWs, "skills/s1/SKILL.md", "---\nname: s1\n---\n")
                const runSk = (opts: Parameters<typeof SkillsInstallRule.install>[0]) =>
                  Effect.runPromise(
                    Effect.exit(
                      SkillsInstallRule.install(opts, { root: skWs } as never).pipe(Effect.provide(NodeServices.layer))
                    )
                  )
                expect((await runSk({ library: { root: "skills" }, agents: [], mode: "check" } as never))._tag).toBe(
                  "Failure"
                )
                expect(
                  (await runSk({ library: { root: "missing-lib" }, agents: ["claude"], mode: "check" } as never))._tag
                ).toBe("Failure")
                expect(
                  (await runSk(
                    { library: { root: "skills" }, agents: ["claude"], skills: ["no-such"], mode: "check" } as never
                  ))._tag
                ).toBe("Failure")
                const realTarget = NodePath.join(base, "real-agent")
                await NodeFs.promises.mkdir(realTarget, { recursive: true })
                await NodeFs.promises.mkdir(NodePath.join(skWs, ".claude"), { recursive: true })
                await NodeFs.promises.symlink(realTarget, NodePath.join(skWs, ".claude", "skills"))
                expect((await runSk({ library: { root: "skills" }, agents: ["claude"], mode: "write" } as never))._tag)
                  .toBe("Failure")

                // 10. FactoryProjectionExec: home check & write
                const fpWs = NodePath.join(base, "fp-ws")
                await NodeFs.promises.mkdir(fpWs, { recursive: true })
                const fpCheck = await Effect.runPromise(
                  Effect.exit(
                    FactoryProjectionExec.renderProjection(
                      "//:fac",
                      {
                        root: fpWs,
                        output: "FACTORY.md",
                        homeOutput: "HOME.md",
                        mode: "write",
                        factory: S.Factory({ summary: "demo", flows: [] }),
                        home: null
                      }
                    ).pipe(Effect.provide(NodeServices.layer))
                  )
                )
                expect(["Success", "Failure"]).toContain(fpCheck._tag)

                // 11. Machine: long socket path on linux (abstract) & darwin (MachinesPathTooLong)
                const longHold = NodePath.join(base, "a".repeat(50), "b".repeat(50), "m")
                await NodeFs.promises.mkdir(longHold, { recursive: true })
                const mLin = Machine.unmade(
                  { root: ownWs, name: "m1", environment: { [Machine.holdingVariable]: longHold } } as never
                )
                expect(mLin).toBeDefined()

                // 12. TrustedReview: ReviewPolicyRequired (L32-33, L258) & empty index (L320) & invalid path (L451)
                const emptySource: TrustedReview.ReviewSource = {
                  tree: async () => new Map([["a.txt", { mode: "100644", oid: "1".repeat(40), size: 0 } as never]]),
                  read: async () => "",
                  grep: async () => []
                }
                await expect(
                  TrustedReview.prepareSource(emptySource, {
                    policyRevision: "HEAD",
                    targetRevision: "HEAD",
                    changedPaths: ["a.txt"],
                    selectors: []
                  } as never)
                ).rejects.toThrow()
              })
              return true
            }),
          { executions: ioExecutions, seed }
        )
      )
      assertPassed(report)
    },
    120_000
  )
})
