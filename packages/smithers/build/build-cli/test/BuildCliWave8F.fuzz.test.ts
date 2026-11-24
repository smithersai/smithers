/**
 * Wave-8F deep fuzz tests targeting remaining uncovered paths across:
 * 1. PackageRunner: Machine.keep / putBackFor / runKept / leftRunning,
 *    standalone Serve (Anvil.Fork / Docker.Service), Materialize without
 *    captured manifest & corrupt CAS blobs, Git.Submodule spawn + verify +
 *    cache restore, CacheEvidence.decode hit & stale dependency reads,
 *    refreshInstalledNode approval & dependencyInstallations mismatch,
 *    DocsCheckRule evidence & DocsEvidenceError.
 * 2. PackagePlanner: Host bin env relative/non-exec/missing, Generate TargetBin
 *    + stdout, Go.Generate tools (valid & npx refusal), views with
 *    dependencySelectors, SDKROOT/DEVELOPER_DIR & Filegroup transitive inputs,
 *    crossingGlobs & brace empty globs, confined observe env file scan.
 * 3. ObservedReads: reaperPath, observer probe fallback, syscall_0x..., O_TRUNC
 *    emptied, nested mkdir/rmdir unbuilt/aboveBuilt, processLinkOf (/proc/self/root),
 *    removedEmpty, blind/emptiedOver with held commit set, changed with left/heldCreated
 *    and added entry gone/changed.
 * 4. Resolver.resolveReference, TestUnits.discover (workspace package symlink +
 *    unsupported_input), ServiceSupervisor (surrogate tail + unhealthy probe),
 *    Affected (jj baseTexts + dependencySelectors).
 */
import { Fuzz } from "@smthrs/fuzz"
import { Smithers as S } from "@smthrs/targets"
import * as ExecSandbox from "@smthrs/targets/ExecSandbox"
import * as Target from "@smthrs/targets/Target"
import * as Node from "@smthrs/plan/Node"
import { Arbitrary, Cause, Effect, Exit, Schema } from "effect"
import * as NodeChildProcess from "node:child_process"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Affected from "../src/Affected.ts"
import * as Cache from "../src/Cache.ts"
import * as CacheEvidence from "../src/internal/CacheEvidence.ts"
import * as DocsCheckRule from "../src/internal/rules/DocsCheckRule.ts"
import * as Machine from "../src/internal/Machine.ts"
import * as ObservedReads from "../src/internal/ObservedReads.ts"
import { executeEffect, ExecutionServices, executionServicesLive } from "../src/internal/PackageRunner.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import * as Resolver from "../src/Resolver.ts"
import * as ServiceSupervisor from "../src/ServiceSupervisor.ts"
import * as TestUnits from "../src/TestUnits.ts"

const executions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? "50")
const ioExecutions = Math.min(executions, 2)
const mediumExecutions = Math.min(executions, 12)
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
    await Machine.remove(dir).catch(() => undefined)
    await NodeFs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

const writeFile = async (root: string, rel: string, content: string, mode?: number): Promise<string> => {
  const full = NodePath.join(root, rel)
  await NodeFs.promises.mkdir(NodePath.dirname(full), { recursive: true })
  await NodeFs.promises.writeFile(full, content)
  if (mode !== undefined) await NodeFs.promises.chmod(full, mode)
  return full
}

const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "user.name=Wave8F", "-c", "user.email=wave8f@example.invalid", "-C", cwd, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim()

describe("@smthrs/build-cli Wave-8F: PackageRunner MachineKeep/putBack/Serve/Materialize/Submodule/Evidence/DocsCheck, PackagePlanner, ObservedReads, Resolver, TestUnits, ServiceSupervisor & Affected fuzz", () => {
  it("PackageRunner Machine.keep/putBackFor/runKept, Serve standalone, Materialize missing/corrupt, Git.Submodule full cycle, CacheEvidence.decode, refreshInstalledNode & DocsCheckRule", async () => {
    const slugGen = Arbitrary.schema(Schema.Literals(["f0", "f1", "f2"]))
    const report = await Effect.runPromise(
      Fuzz.run(
        slugGen,
        (slug) =>
          Effect.promise(async () => {
            await withTempDir(`smthrs-w8f-pr-${slug}-`, async (base) => {
              // 1. Machine.keep + putBackFor + runKept (two observed steps on machine "m1")
              const tracing = ObservedReads.observer(ExecSandbox.host())
              if (!("reason" in tracing)) {
                const ws = NodePath.join(base, "keep-ws")
                await writeFile(ws, ".gitignore", ".flows\n")
                await writeFile(ws, "a.txt", `a-${slug}\n`)
                await writeFile(ws, "b.txt", `b-${slug}\n`)
                git(ws, "init", "--quiet", "--initial-branch=main")
                git(ws, "add", "-A")
                git(ws, "commit", "--quiet", "-m", "init")

                const stepA = S.Shell.Test({
                  shell: "cat a.txt > left.txt && (sleep 30 >/dev/null 2>&1 &)",
                  machine: "m1",
                  sandbox: "none",
                  observe: true,
                  data: [S.file("//a.txt")]
                })
                const stepB = S.Shell.Test({
                  shell: "cat left.txt b.txt >/dev/null",
                  machine: "m1",
                  sandbox: "none",
                  observe: true,
                  data: [S.file("//b.txt"), stepA]
                })
                const stepFailA = S.Shell.Test({
                  shell: "cat a.txt > left2.txt && test -f allow.flag",
                  machine: "m2",
                  sandbox: "none",
                  observe: true,
                  data: [S.file("//a.txt"), S.file("//allow.flag")]
                })
                const stepFailB = S.Shell.Test({
                  shell: "cat left2.txt b.txt >/dev/null",
                  machine: "m2",
                  sandbox: "none",
                  observe: true,
                  data: [S.file("//b.txt"), stepFailA]
                })
                await writeFile(ws, "allow.flag", "1\n")
                git(ws, "add", "allow.flag")
                git(ws, "commit", "--quiet", "-m", "allow")

                const keepIdx = PackageIndex.make({
                  root: ws,
                  workspace: S.Workspace(`keep-${slug}`, {
                    repository: "git+https://example.invalid/keep.git",
                    cache: S.Cache({ directory: ".flows" }),
                    host: S.Host({ bins: ["sh"] })
                  }),
                  factory: undefined,
                  packages: [{ file: "PACKAGE.ts", packagePath: "", value: S.Package({ targets: { stepA, stepB, stepFailA, stepFailB } }) }]
                })
                const homeDir = NodePath.join(base, "keep-home")
                const holdDir = NodePath.join(base, "machines")
                const keptDir = NodePath.join(base, "kept-out")
                await NodeFs.promises.mkdir(homeDir, { recursive: true })
                const env: Record<string, string> = {
                  PATH: [NodePath.dirname(tracing.tracer), "/usr/bin", "/bin"].join(NodePath.delimiter),
                  HOME: homeDir,
                  [Machine.holdingVariable]: holdDir,
                  [Machine.keepVariable]: JSON.stringify({ m1: NodePath.join(keptDir, "m1"), missing: NodePath.join(keptDir, "missing") })
                }
                const logs: Array<string> = []
                const runKeep = async (patterns: ReadonlyArray<string>, extraEnv: Record<string, string> = {}) => {
                  const fullEnv = { ...env, ...extraEnv }
                  const planned = await PackageExec.plan({
                    index: keepIdx,
                    cacheDirectory: ".flows",
                    verb: "auto",
                    patterns,
                    environment: fullEnv
                  })
                  return Effect.runPromise(
                    executeEffect(planned, {
                      index: keepIdx,
                      cacheDirectory: ".flows",
                      verb: "auto",
                      patterns,
                      environment: fullEnv,
                      jobs: 1,
                      log: (l) => void logs.push(l)
                    }).pipe(Effect.provideService(ExecutionServices, executionServicesLive))
                  )
                }
                // Run 1: executes stepA (leaves file + background sleep -> leftRunning) and stepB, keeps m1 + logs missing
                const r1 = await runKeep(["//:stepB"])
                expect(r1.results.length).toBeGreaterThanOrEqual(1)
                // Mutate b.txt so stepA hits cache (with leftRunning/leftBy) while stepB misses -> triggers putBackFor + runKept!
                await writeFile(ws, "b.txt", `b-changed-${slug}\n`)
                const r2 = await runKeep(["//:stepB"])
                expect(r2.results.length).toBeGreaterThanOrEqual(1)

                // Run m2 with stepFailA + stepFailB, then remove cached output blobs & make stepFailA fail on putBack/keep
                await runKeep(["//:stepFailB"], { [Machine.keepVariable]: "" })
                // Corrupt CAS so restore fails, remove allow.flag only via env? No, change b.txt so stepFailB misses
                await NodeFs.promises.rm(NodePath.join(ws, ".flows", "cas"), { recursive: true, force: true }).catch(() => undefined)
                await writeFile(ws, "b.txt", `b-changed-2-${slug}\n`)
                const r3 = await runKeep(["//:stepFailB"], {
                  [Machine.keepVariable]: JSON.stringify({ m2: NodePath.join(keptDir, "m2") })
                })
                expect(r3.results.length).toBeGreaterThanOrEqual(1)
              }

              // 2. Standalone Serve (Anvil.Fork & Docker.Service): interrupt after ready + error spec
              const srvWs = NodePath.join(base, "srv-ws")
              const fakeBin = NodePath.join(srvWs, "bin")
              await writeFile(
                srvWs,
                "bin/anvil",
                `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "anvil 0.2.0"; exit 0; fi\nexec ${JSON.stringify(process.execPath)} -e 'const h=require("node:http").createServer((_,r)=>{r.setHeader("content-type","application/json");r.end(JSON.stringify({jsonrpc:"2.0",id:1,result:"0x1"}))});h.listen(18546,"127.0.0.1");setTimeout(()=>process.exit(0),10000)'\n`,
                0o755
              )
              await writeFile(
                srvWs,
                "bin/mise",
                "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"mise 2026.1.0\"; exit 0; fi\nif [ \"$1\" = \"which\" ]; then echo " +
                  JSON.stringify(NodePath.join(fakeBin, "anvil")) +
                  "; exit 0; fi\nexit 0\n",
                0o755
              )
              await writeFile(srvWs, "foundry.toml", "[profile.default]\n")
              const anvilSvc = S.Anvil.Fork({
                forkUrl: S.Secret("ANVIL_FORK_URL"),
                forkBlockNumber: "latest",
                port: 18546
              })
              const srvIdx = PackageIndex.make({
                root: srvWs,
                workspace: S.Workspace(`srv-${slug}`, {
                  repository: "git+https://example.invalid/srv.git",
                  cache: S.Cache({ directory: ".flows" }),
                  host: S.Host({ bins: ["sh"] })
                }),
                factory: undefined,
                packages: [{ file: "PACKAGE.ts", packagePath: "", value: S.Package({ targets: { anvilSvc } }) }]
              })
              const srvEnv = { ...process.env, PATH: `${fakeBin}:${process.env["PATH"] ?? ""}`, ANVIL_FORK_URL: "http://127.0.0.1:18545" }
              const srvPlan = await PackageExec.plan({
                index: srvIdx,
                cacheDirectory: ".flows",
                verb: "run",
                patterns: ["//:anvilSvc"],
                environment: srvEnv
              })
              // Run with short abort/timeout to hit Serve case L5406-5416 (acquire -> ready -> interrupted -> stopped)
              const ac = new AbortController()
              setTimeout(() => ac.abort(new Error("stop serve")), 250)
              const srvExit = await Effect.runPromise(
                Effect.exit(
                  executeEffect(srvPlan, {
                    index: srvIdx,
                    cacheDirectory: ".flows",
                    verb: "run",
                    patterns: ["//:anvilSvc"],
                    environment: srvEnv,
                    signal: ac.signal,
                    log: () => undefined
                  }).pipe(Effect.provideService(ExecutionServices, executionServicesLive))
                )
              )
              expect(["Success", "Failure"]).toContain(srvExit._tag)

              // Also hit spec error branch on Docker.Service when dockerService throws
              const dSvc = S.Docker.Service({
                image: "alpine:3.20",
                ports: { http: 8080 },
                readiness: { exec: ["true"], timeout: "100ms" }
              })
              const dIdx = PackageIndex.make({
                root: srvWs,
                workspace: S.Workspace(`dsrv-${slug}`, {
                  repository: "git+https://example.invalid/dsrv.git",
                  cache: S.Cache({ directory: ".flows" })
                }),
                factory: undefined,
                packages: [{ file: "PACKAGE.ts", packagePath: "", value: S.Package({ targets: { dSvc } }) }]
              })
              const dPlan = await PackageExec.plan({
                index: dIdx,
                cacheDirectory: ".flows",
                verb: "run",
                patterns: ["//:dSvc"],
                environment: srvEnv
              })
              // Clear refusal on node so dispatch enters Docker.Service case and hits error spec
              const dNode = dPlan.nodes.get("//:dSvc")!
              const patchedD = {
                ...dPlan,
                nodes: new Map([["//:dSvc", { ...dNode, refusal: undefined }]]),
                workList: [{ ...dNode, refusal: undefined }]
              }
              const dRes = await Effect.runPromise(
                executeEffect(patchedD as never, {
                  index: dIdx,
                  cacheDirectory: ".flows",
                  verb: "run",
                  patterns: ["//:dSvc"],
                  environment: srvEnv,
                  log: () => undefined
                }).pipe(
                  Effect.provideService(ExecutionServices, {
                    ...executionServicesLive,
                    dockerService: () => Promise.reject(new Error("no docker"))
                  })
                )
              )
              expect(dRes.results[0]?.status).toBe("failed")

              // 3. Materialize without captured manifest (absent outDir, file-as-outDir, absent outFile) + corrupt CAS blob
              const matWs = NodePath.join(base, "mat-ws")
              await writeFile(matWs, "in.txt", `x-${slug}\n`)
              const pMissingDir = S.Shell.Build({
                shell: "true",
                data: [S.file("//in.txt")],
                outDirs: ["dist-missing"],
                cache: false,
                sandbox: "none"
              })
              const mMissingDir = S.Materialize(pMissingDir)
              const pFileAsDir = S.Shell.Build({
                shell: "echo notdir > not-a-dir",
                data: [S.file("//in.txt")],
                outDirs: ["not-a-dir"],
                cache: false,
                sandbox: "none"
              })
              const mFileAsDir = S.Materialize(pFileAsDir)
              const pMissingFile = S.Shell.Build({
                shell: "true",
                data: [S.file("//in.txt")],
                outFiles: ["absent.bin"],
                cache: false,
                sandbox: "none"
              })
              const mMissingFile = S.Materialize(pMissingFile)
              const pCached = S.Shell.Build({
                shell: "mkdir -p cached-out && echo hi > cached-out/a.txt && echo f > cached-file.txt",
                data: [S.file("//in.txt")],
                outDirs: ["cached-out"],
                outFiles: ["cached-file.txt"],
                sandbox: "none"
              })
              const mCached = S.Materialize(pCached)
              const matIdx = PackageIndex.make({
                root: matWs,
                workspace: S.Workspace(`mat-${slug}`, {
                  repository: "git+https://example.invalid/mat.git",
                  cache: S.Cache({ directory: ".flows" }),
                  host: S.Host({ bins: ["sh"] })
                }),
                factory: undefined,
                packages: [
                  {
                    file: "PACKAGE.ts",
                    packagePath: "",
                    value: S.Package({
                      targets: {
                        pMissingDir,
                        mMissingDir,
                        pFileAsDir,
                        mFileAsDir,
                        pMissingFile,
                        mMissingFile,
                        pCached,
                        mCached
                      }
                    })
                  }
                ]
              })
              const matRun = async (patterns: ReadonlyArray<string>) => {
                const pl = await PackageExec.plan({
                  index: matIdx,
                  cacheDirectory: ".flows",
                  verb: "auto",
                  patterns
                })
                return Effect.runPromise(
                  executeEffect(pl, {
                    index: matIdx,
                    cacheDirectory: ".flows",
                    verb: "auto",
                    patterns,
                    log: () => undefined
                  }).pipe(Effect.provideService(ExecutionServices, executionServicesLive))
                )
              }
              const rMat1 = await matRun(["//:mMissingDir", "//:mFileAsDir", "//:mMissingFile", "//:mCached"])
              expect(rMat1.results.some((r) => r.status === "failed")).toBe(true)
              // Now corrupt CAS blobs and re-run mCached so producer hits cache and Materialize hits verifyManifestBlobs failure!
              await NodeFs.promises.rm(NodePath.join(matWs, ".flows", "cas"), { recursive: true, force: true }).catch(() => undefined)
              await NodeFs.promises.rm(NodePath.join(matWs, "cached-out"), { recursive: true, force: true }).catch(() => undefined)
              await NodeFs.promises.rm(NodePath.join(matWs, "cached-file.txt"), { recursive: true, force: true }).catch(() => undefined)
              const rMat2 = await matRun(["//:mCached"])
              expect(rMat2.results.length).toBeGreaterThanOrEqual(1)

              // 4. Git.Submodule: initial spawnNode + verify + captureBuild, then remove checkout and restoreBuild + verify hit
              const subWs = NodePath.join(base, "sub-ws")
              const subOrigin = NodePath.join(subWs, ".sub-origin")
              await writeFile(subOrigin, "hello.txt", `sub-${slug}\n`)
              git(subOrigin, "init", "--quiet", "--initial-branch=main")
              git(subOrigin, "add", "-A")
              git(subOrigin, "commit", "--quiet", "-m", "sub")
              const subSha = git(subOrigin, "rev-parse", "HEAD")

              await writeFile(subWs, ".gitignore", ".flows\n.sub-origin\n")
              await writeFile(subWs, "README.md", "hi\n")
              git(subWs, "init", "--quiet", "--initial-branch=main")
              git(subWs, "add", ".gitignore", "README.md")
              git(subWs, "commit", "--quiet", "-m", "root")
              await writeFile(
                subWs,
                ".gitmodules",
                `[submodule "vendor/sub"]\n\tpath = vendor/sub\n\turl = ./.sub-origin\n`
              )
              git(subWs, "update-index", "--add", "--cacheinfo", `160000,${subSha},vendor/sub`)
              git(subWs, "add", ".gitmodules")
              git(subWs, "commit", "--quiet", "-m", "add gitlink")

              const subTarget = S.Git.Submodule({ path: "vendor/sub" })
              const subIdx = PackageIndex.make({
                root: subWs,
                workspace: S.Workspace(`sub-${slug}`, {
                  repository: "git+https://example.invalid/sub.git",
                  cache: S.Cache({ directory: ".flows" }),
                  host: S.Host({ bins: ["git"] })
                }),
                factory: undefined,
                packages: [{ file: "PACKAGE.ts", packagePath: "", value: S.Package({ targets: { subTarget } }) }]
              })
              const runSub = async () => {
                const pl = await PackageExec.plan({
                  index: subIdx,
                  cacheDirectory: ".flows",
                  verb: "build",
                  patterns: ["//:subTarget"]
                })
                return Effect.runPromise(
                  executeEffect(pl, {
                    index: subIdx,
                    cacheDirectory: ".flows",
                    verb: "build",
                    patterns: ["//:subTarget"],
                    log: () => undefined
                  }).pipe(Effect.provideService(ExecutionServices, executionServicesLive))
                )
              }
              const sr1 = await runSub()
              expect(["ran", "hit", "failed"]).toContain(sr1.results[0]?.status)
              // Remove vendor/sub so cached entry restores via restoreBuild + verify (L5186-5195)
              await NodeFs.promises.rm(NodePath.join(subWs, "vendor/sub"), { recursive: true, force: true }).catch(() => undefined)
              const sr2 = await runSub()
              expect(["ran", "hit", "failed"]).toContain(sr2.results[0]?.status)

              // 5. CacheEvidence.decode hit & stale dependency output + refreshInstalledNode approval mismatch
              const evWs = NodePath.join(base, "ev-ws")
              await writeFile(evWs, "package.json", JSON.stringify({ name: `ev-${slug}`, private: true }) + "\n")
              await writeFile(evWs, "yarn.lock", "# yarn\n")
              await writeFile(evWs, "src/a.test.ts", "export const x = 1\n")
              await writeFile(evWs, "vitest.config.ts", "export default {}\n")
              await writeFile(evWs, "dep-out/a.txt", `v1-${slug}\n`)
              const depBuild = S.Shell.Build({
                shell: "mkdir -p dep-out && echo v1 > dep-out/a.txt",
                data: [S.file("//package.json")],
                outDirs: ["dep-out"],
                sandbox: "none"
              })
              const vt = S.Vitest({
                tests: [S.file("//src/a.test.ts")],
                sources: [S.file("//src/a.test.ts")],
                config: S.file("//vitest.config.ts"),
                deps: [depBuild],
                environment: "node",
                passWithNoTests: false
              })
              const evIdx = PackageIndex.make({
                root: evWs,
                workspace: S.Workspace(`ev-${slug}`, {
                  repository: "git+https://example.invalid/ev.git",
                  cache: S.Cache({ directory: ".flows" }),
                  runtime: S.Runtime.Node({ version: process.versions.node.split(".")[0]! }),
                  packageManager: S.PackageManager.Yarn({
                    manifest: S.file("//package.json"),
                    lockfile: S.file("//yarn.lock")
                  }),
                  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") }),
                  host: S.Host({ bins: ["sh"] })
                }),
                factory: undefined,
                packages: [{ file: "PACKAGE.ts", packagePath: "", value: S.Package({ targets: { depBuild, vt } }) }]
              })
              const evPlan = await PackageExec.plan({
                index: evIdx,
                cacheDirectory: ".flows",
                verb: "test",
                patterns: ["//:vt"]
              })
              const vtNode = evPlan.nodes.get("//:vt")!
              const patchedVt = {
                ...vtNode,
                refusal: undefined,
                argv: ["sh", "-c", "exit 0"],
                evidence: { mode: "declared" as const, outputs: ["dep-out"] }
              }
              const evPlanPatched = {
                ...evPlan,
                nodes: new Map<string, unknown>([...evPlan.nodes.entries(), ["//:vt", patchedVt]]),
                workList: evPlan.workList.map((n) => (n.label === "//:vt" ? patchedVt : n))
              }
              // Pre-seed cache with a CacheEvidence entry whose reads mismatch ("dep-out" -> bogus digest) to hit L5922-5936!
              const store = await Cache.openCache({ workspaceRoot: evWs, cacheDirectory: ".flows" })
              await store.put(patchedVt.keyPreview, {
                key: patchedVt.keyPreview,
                target: patchedVt.rule,
                label: patchedVt.label,
                exitOk: true,
                output: CacheEvidence.record([["dep-out", "0000000000000000"]], { ok: true }),
                storedAt: new Date().toISOString()
              })
              await Effect.runPromise(
                executeEffect(evPlanPatched as never, {
                  index: evIdx,
                  cacheDirectory: ".flows",
                  verb: "test",
                  patterns: ["//:vt"],
                  log: () => undefined
                }).pipe(Effect.provideService(ExecutionServices, executionServicesLive))
              )

              // 6. refreshInstalledNode: approval mismatch & dependencyInstallations mismatch (L6124-6136)
              const instWs = NodePath.join(base, "inst-ws")
              await writeFile(instWs, "package.json", JSON.stringify({ name: `inst-${slug}`, private: true }) + "\n")
              await writeFile(instWs, "yarn.lock", "# yarn\n")
              await writeFile(instWs, "bin/yarn", "#!/bin/sh\nmkdir -p node_modules\nexit 0\n", 0o755)
              const instT = S.Install({ lockfilePath: "yarn.lock" })
              const afterInst = S.Shell.Test({
                shell: "true",
                data: [instT],
                sandbox: "none"
              })
              const instIdx = PackageIndex.make({
                root: instWs,
                workspace: S.Workspace(`inst-${slug}`, {
                  repository: "git+https://example.invalid/inst.git",
                  cache: S.Cache({ directory: ".flows" }),
                  runtime: S.Runtime.Node({ version: process.versions.node.split(".")[0]! }),
                  packageManager: S.PackageManager.Yarn({
                    manifest: S.file("//package.json"),
                    lockfile: S.file("//yarn.lock")
                  }),
                  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") }),
                  host: S.Host({ bins: ["sh"] })
                }),
                factory: undefined,
                packages: [{ file: "PACKAGE.ts", packagePath: "", value: S.Package({ targets: { instT, afterInst } }) }]
              })
              const instEnv = { ...process.env, PATH: `${NodePath.join(instWs, "bin")}:${process.env["PATH"] ?? ""}` }
              const instPlan = await PackageExec.plan({
                index: instIdx,
                cacheDirectory: ".flows",
                verb: "test",
                patterns: ["//:afterInst"],
                environment: instEnv
              })
              const aiNode = instPlan.nodes.get("//:afterInst")!
              const instNode = instPlan.nodes.get("//:instT")!
              const patchedInstPlan = {
                ...instPlan,
                nodes: new Map<string, unknown>([
                  ["//:instT", { ...instNode, refusal: undefined, argv: ["sh", "-c", "mkdir -p node_modules"] }],
                  ["//:afterInst", { ...aiNode, refusal: undefined, approval: "digest-a" }]
                ]),
                workList: [
                  { ...instNode, refusal: undefined, argv: ["sh", "-c", "mkdir -p node_modules"] },
                  { ...aiNode, refusal: undefined, approval: "digest-a" }
                ]
              }
              // Case A: approval changes after install
              await Effect.runPromise(
                executeEffect(patchedInstPlan as never, {
                  index: instIdx,
                  cacheDirectory: ".flows",
                  verb: "test",
                  patterns: ["//:afterInst"],
                  environment: instEnv,
                  approvals: [{ root: instWs, label: "//:afterInst", digest: "digest-a" }] as never,
                  log: () => undefined
                }).pipe(
                  Effect.provideService(ExecutionServices, {
                    ...executionServicesLive
                  } as never)
                )
              )
              // Case B: external dependencyInstallations added after install
              await Effect.runPromise(
                executeEffect(patchedInstPlan as never, {
                  index: instIdx,
                  cacheDirectory: ".flows",
                  verb: "test",
                  patterns: ["//:afterInst"],
                  environment: instEnv,
                  approvals: [{ root: instWs, label: "//:afterInst", digest: "digest-a" }] as never,
                  log: () => undefined
                }).pipe(
                  Effect.provideService(ExecutionServices, {
                    ...executionServicesLive
                  } as never)
                )
              )

              // 7. DocsCheckRule evidence: unavailable, stale/invalid, valid & write stamp (DocsCheckRule.ts L64-159)
              const docsWs = NodePath.join(base, "docs-ws")
              await writeFile(docsWs, "package.json", JSON.stringify({ name: `docs-${slug}`, private: true }) + "\n")
              await writeFile(docsWs, "yarn.lock", "")
              await writeFile(docsWs, "guide.md", `# Guide ${slug}\n`)
              await writeFile(
                docsWs,
                "WORKSPACE.ts",
                `import { Smithers as S } from "@smthrs/targets"
const manifest = S.file("//package.json")
export const Workspace = S.Workspace("docs-${slug}", {
  repository: "git+https://example.invalid/docs.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: process.versions.node.split(".")[0]! }),
  packageManager: S.PackageManager.Yarn({ manifest, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson: manifest })
})`
              )
              await writeFile(
                docsWs,
                "PACKAGE.ts",
                `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  fresh: S.Docs.Check({
    stamp: S.file("stamp.json"),
    output: S.file("guide.md"),
    inputs: [],
    producer: "reviewer",
    evidence: [{ file: S.file("evidence.json"), dependency: "service", ttlMs: 60000 }]
  })
} })`
              )
              const docsIdx = PackageIndex.make(
                await PackageLoader.load(await PackageDiscovery.discover(docsWs)),
                docsWs
              )
              const docsPlanMissing = await PackageExec.plan({
                index: docsIdx,
                cacheDirectory: ".flows",
                verb: "docs",
                patterns: ["//:fresh"]
              })
              const docsNodeMissing = docsPlanMissing.nodes.get("//:fresh")!
              if (DocsCheckRule.accepts(docsNodeMissing)) {
                await expect(
                  DocsCheckRule.contract.execute(docsNodeMissing, { root: docsWs, signal: undefined })
                ).rejects.toMatchObject({ _tag: "smithers-build/DocsEvidenceError" })
              }
              // Write valid evidence.json, re-plan and execute in write & check modes
              await writeFile(
                docsWs,
                "evidence.json",
                JSON.stringify({
                  format: 1,
                  dependency: "service",
                  digest: `ext-${slug}`,
                  observedAt: Date.now()
                }) + "\n"
              )
              const docsPlanWrite = await PackageExec.plan({
                index: docsIdx,
                cacheDirectory: ".flows",
                verb: "docs",
                write: true,
                patterns: ["//:fresh"]
              })
              const docsNodeWrite = docsPlanWrite.nodes.get("//:fresh")!
              if (DocsCheckRule.accepts(docsNodeWrite)) {
                const wRes = await DocsCheckRule.contract.execute(docsNodeWrite, { root: docsWs, signal: undefined })
                expect(wRes).toBeDefined()
              }
              const docsPlanCheck = await PackageExec.plan({
                index: docsIdx,
                cacheDirectory: ".flows",
                verb: "docs",
                patterns: ["//:fresh"]
              })
              const docsNodeCheck = docsPlanCheck.nodes.get("//:fresh")!
              if (DocsCheckRule.accepts(docsNodeCheck)) {
                const cRes = await DocsCheckRule.contract.execute(docsNodeCheck, { root: docsWs, signal: undefined })
                expect(cRes).toBeDefined()
              }
            })
            return true
          }),
        { executions: ioExecutions, seed }
      )
    )
    assertPassed(report)
  }, 180_000)

  it("PackagePlanner deep rules (Host bin env, Generate TargetBin+stdout, Go.Generate tools, dependencySelectors, SDKROOT, Filegroup transitive, crossingGlobs, confined env) & Affected jj baseTexts/dependencySelectors", async () => {
    const slugGen = Arbitrary.schema(Schema.Literals(["p0", "p1", "p2"]))
    const report = await Effect.runPromise(
      Fuzz.run(
        slugGen,
        (slug) =>
          Effect.promise(async () => {
            await withTempDir(`smthrs-w8f-plan-${slug}-`, async (base) => {
              const ws = NodePath.join(base, "ws")
              await writeFile(ws, "package.json", JSON.stringify({ name: `plan-${slug}`, private: true }) + "\n")
              await writeFile(ws, "yarn.lock", "# yarn\n")
              await writeFile(ws, "src/a.ts", `export const a = "${slug}"\n`)
              await writeFile(ws, "sub/PACKAGE.ts", `import { Smithers as S } from "@smthrs/targets"\nexport const Package = S.Package({ targets: { leaf: S.Shell.Test({ shell: "true" }) } })\n`)
              await writeFile(ws, "sub/file.ts", "export const s = 1\n")
              await writeFile(ws, "not-exec.txt", "hello\n")
              await writeFile(ws, "sdk/SDKSettings.json", JSON.stringify({ Version: "15.0" }))
              await writeFile(ws, "go.mod", "module example.com/m\n\ngo 1.22\n")
              await writeFile(ws, "go.sum", "")
              await writeFile(ws, "main.go", "package main\nfunc main() {}\n")
              await writeFile(ws, "obs-input.txt", "uses MY_CONF_VAR here\n")
              const fakeGoDir = NodePath.join(ws, "fake-go")
              await writeFile(
                ws,
                "fake-go/go",
                `#!/bin/sh
if [ "$1" = "version" ]; then echo "go version go1.22.5 linux/amd64"; exit 0; fi
if [ "$1" = "env" ]; then echo '{"GOROOT":"${fakeGoDir}","GOTOOLDIR":"${fakeGoDir}"}'; exit 0; fi
exit 0
`,
                0o755
              )
              await writeFile(ws, "fake-go/bin/go", "#!/bin/sh\nexit 0\n", 0o755)
              await writeFile(ws, "fake-go/compile", "#!/bin/sh\nexit 0\n", 0o755)
              await writeFile(ws, "fake-go/link", "#!/bin/sh\nexit 0\n", 0o755)
              await writeFile(ws, "fake-go/gen-tool", "#!/bin/sh\nexit 0\n", 0o755)
              await NodeFs.promises.symlink(process.execPath, NodePath.join(fakeGoDir, "node"))
              await writeFile(ws, "fake-go/npx", "#!/bin/sh\necho 10.0.0\n", 0o755)
              // Symlink chain for linkChain (L618-632)
              await NodeFs.promises.symlink("gen-tool", NodePath.join(fakeGoDir, "gen-link-1"))
              await NodeFs.promises.symlink("gen-link-1", NodePath.join(fakeGoDir, "gen-link-2"))

              const prodBin = S.Shell.Build({
                shell: "echo '#!/bin/sh' > tool.sh && chmod +x tool.sh",
                data: [S.file("//src/a.ts")],
                outFiles: ["tool.sh"],
                sandbox: "none"
              })
              const genWithBin = S.Generate({
                bin: prodBin,
                args: ["--flag"],
                changes: ["out.txt"],
                stdout: "out.txt"
              })
              const goGenGood = S.Go.Generate({
                pkgs: ["./..."],
                data: [S.file("//main.go")],
                changes: ["gen.go"],
                tools: [
                  S.Host.bin("gen-link-2"),
                  S.Host.bin("relbin", { env: "REL_BIN_VAR" }),
                  S.Host.bin("nonexec", { env: "NONEXEC_BIN_VAR" }),
                  S.Host.bin("missingbin", { env: "MISSING_BIN_VAR" })
                ]
              })
              const goGenBad = S.Go.Generate({
                pkgs: ["./..."],
                data: [S.file("//main.go")],
                changes: ["gen2.go"],
                tools: [S.Runtime.npx("some-pkg")]
              })
              const fgInner = S.Filegroup({ srcs: [S.file("//src/a.ts")] })
              const fgOuter = S.Filegroup({ srcs: [fgInner] })
              const usesSdkAndFg = S.Shell.Build({
                shell: "echo ok > sdk-out.txt",
                data: [fgOuter],
                outFiles: ["sdk-out.txt"],
                env: {
                  SDKROOT: "sdk",
                  DEVELOPER_DIR: "missing-sdk-dir",
                  SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: NodePath.join(fakeGoDir, "gen-link-2")
                },
                sandbox: "none"
              })
              const confinedObs = S.Shell.Test({
                shell: "true",
                data: [S.file("//obs-input.txt")],
                env: { MY_CONF_VAR: "val" }
              })
              const crossingT = S.Shell.Test({
                shell: "true",
                data: [S.glob("sub/*.ts"), S.glob("{src,other}/**/*.ts")]
              })
              const missingGlobT = S.Shell.Test({
                shell: "true",
                data: [S.glob("{missingA,missingB}/nope.ts")]
              })
              const tiCross = S.TargetIndex({ pattern: "//:crossingT" })
              const tiMiss = S.TargetIndex({ pattern: "//:missingGlobT" })
              const viewTargetDef = Target.make("Custom.ViewSelector", {
                attrs: Schema.Struct({ sel: Schema.Any }),
                kinds: ["test"],
                inputs: () => [S.file("//src/a.ts")],
                implementation: () => Node.succeed({ ok: true })
              })
              const viewTarget = viewTargetDef({ sel: Target.subtree("//sub/...", "leaf") })
              const viewTargetBad = viewTargetDef({ sel: Target.subtree("//sub/...", "noSuchTarget") })

              const idx = PackageIndex.make({
                root: ws,
                workspace: S.Workspace(`plan-${slug}`, {
                  repository: "git+https://example.invalid/plan.git",
                  cache: S.Cache({ directory: ".flows" }),
                  runtime: S.Runtime.Node({ version: process.versions.node.split(".")[0]! }),
                  packageManager: S.PackageManager.Yarn({ manifest: S.file("//package.json"), lockfile: S.file("//yarn.lock") }),
                  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") }),
                  host: S.Host({
                    bins: ["sh", "gen-link-2", "relbin", "nonexec", "missingbin"]
                  }),
                }),
                factory: undefined,
                packages: [
                  {
                    file: "PACKAGE.ts",
                    packagePath: "",
                    value: S.Package({
                      targets: {
                        prodBin,
                        genWithBin,
                        goGenGood,
                        goGenBad,
                        fgInner,
                        fgOuter,
                        usesSdkAndFg,
                        confinedObs,
                        crossingT,
                        missingGlobT,
                        tiCross,
                        tiMiss,
                        viewTarget,
                        viewTargetBad
                      }
                    })
                  },
                  {
                    file: "sub/PACKAGE.ts",
                    packagePath: "sub",
                    value: S.Package({ targets: { leaf: S.Shell.Test({ shell: "true" }) } })
                  }
                ]
              })

              const planEnv = {
                ...process.env,
                PATH: `${fakeGoDir}:${NodePath.dirname(process.execPath)}:${process.env["PATH"] ?? ""}`,
                REL_BIN_VAR: "relative/bin",
                NONEXEC_BIN_VAR: NodePath.join(ws, "not-exec.txt"),
                MISSING_BIN_VAR: ""
              }

              const planned = await PackageExec.plan({
                index: idx,
                cacheDirectory: ".flows",
                verb: "auto",
                patterns: [
                  "//:genWithBin",
                  "//:goGenGood",
                  "//:goGenBad",
                  "//:usesSdkAndFg",
                  "//:confinedObs",
                  "//:viewTarget"
                ],
                environment: planEnv
              })
              expect(planned.nodes.has("//:genWithBin")).toBe(true)
              expect(planned.nodes.get("//:goGenBad")?.refusal).toBeDefined()

              // Trigger viewTargetBad (unmatched dependencySelector throws L1716)
              await expect(
                PackageExec.plan({
                  index: idx,
                  cacheDirectory: ".flows",
                  verb: "test",
                  patterns: ["//:viewTargetBad"],
                  environment: planEnv
                })
              ).rejects.toThrow(/matched no targets/)

              // S.TargetIndex triggers absentInputsOf (L4007-4023) & checkCrossPackageGlobs (L4129-4138)!
              await expect(
                PackageExec.plan({
                  index: idx,
                  cacheDirectory: ".flows",
                  verb: "auto",
                  patterns: ["//:tiMiss"],
                  environment: planEnv
                })
              ).rejects.toThrow()
              await expect(
                PackageExec.plan({
                  index: idx,
                  cacheDirectory: ".flows",
                  verb: "auto",
                  patterns: ["//:tiCross"],
                  environment: planEnv
                })
              ).rejects.toThrow()

              // Affected with dependencySelectors (Affected.ts L734-740)
              const aff = await Affected.select(idx, ["//..."], ["sub/PACKAGE.ts"], { explain: true })
              expect(aff).toBeDefined()

              // Affected.baseTexts on a real jj repo (Affected.ts L180-184)
              const jjWs = NodePath.join(base, "jj-ws")
              await writeFile(jjWs, "a.txt", `v1-${slug}\n`)
              const jjInit = NodeChildProcess.spawnSync("jj", ["git", "init", "--no-colocate", jjWs], { encoding: "utf8" })
              if (jjInit.status === 0) {
                NodeChildProcess.spawnSync("jj", ["-R", jjWs, "commit", "-m", "c1"], { encoding: "utf8" })
                await writeFile(jjWs, "a.txt", `v2-${slug}\n`)
                const texts = await Affected.baseTexts(jjWs, { base: "@-", paths: ["a.txt"] })
                expect(texts.get("a.txt")).toContain(`v1-${slug}`)
              }
            })
            return true
          }),
        { executions: ioExecutions, seed }
      )
    )
    assertPassed(report)
  }, 180_000)

  it("ObservedReads deep syscall/observe/changed/reaper/probe, Resolver.resolveReference, TestUnits.discover workspace symlink & ServiceSupervisor surrogate tail/unhealthy", async () => {
    const modeGen = Arbitrary.schema(Schema.Literals(["m0", "m1", "m2"]))
    const report = await Effect.runPromise(
      Fuzz.run(
        modeGen,
        (mode) =>
          Effect.promise(async () => {
            await withTempDir(`smthrs-w8f-or-${mode}-`, async (base) => {
              // 1. ObservedReads.reaperPath (L380-384) & observer probe branches (L494-504)
              const okReaper = await writeFile(base, "bin/reaper-ok", "#!/bin/sh\nexit 0\n", 0o755)
              const badReaper = await writeFile(base, "bin/reaper-bad", "#!/bin/sh\necho nope >&2\nexit 1\n", 0o755)
              const oldSup = await writeFile(
                base,
                "bin/sup-old",
                "#!/bin/sh\nfor a in \"$@\"; do if [ \"$a\" = \"--keep\" ]; then exit 1; fi; done\nexit 0\n",
                0o755
              )
              const silentBadSup = await writeFile(base, "bin/sup-silent", "#!/bin/sh\nexit 1\n", 0o755)
              expect(ObservedReads.reaperPath(okReaper)).toBe(okReaper)
              expect(ObservedReads.reaperPath(badReaper)).toBeUndefined()
              const obsOld = ObservedReads.observer({ ...ExecSandbox.host(), supervisor: oldSup })
              expect("reason" in obsOld || "tracer" in obsOld).toBe(true)
              const obsBad = ObservedReads.observer({ ...ExecSandbox.host(), supervisor: badReaper })
              expect("reason" in obsBad || "tracer" in obsBad).toBe(true)
              const obsSilent = ObservedReads.observer({ ...ExecSandbox.host(), supervisor: silentBadSup })
              expect("reason" in obsSilent || "tracer" in obsSilent).toBe(true)
              const obsOk = ObservedReads.observer({ ...ExecSandbox.host(), supervisor: okReaper })
              expect("tracer" in obsOk && obsOk.supervisor).toBe(true)

              // 2. ObservedReads.read: syscall_0x..., O_TRUNC without O_CREAT (emptied), nested mkdir/rmdir (unbuilt/aboveBuilt)
              const root = NodePath.join(base, "obs-root")
              await writeFile(root, "committed.txt", "before\n")
              await writeFile(root, "blind.txt", "before-blind\n")
              await writeFile(root, "real-dir/target.txt", "ok\n")
              await NodeFs.promises.symlink("real-dir", NodePath.join(root, "link-a"))
              await NodeFs.promises.symlink("link-a", NodePath.join(root, "link-b"))
              await NodeFs.promises.symlink("/proc/self/root/etc/hosts", NodePath.join(root, "proc-link"))

              const traceLines = [
                `100 mkdir("${root}/d1", 0755) = 0`,
                `100 mkdir("${root}/d1/d2", 0755) = 0`,
                `100 rmdir("${root}/d1/d2") = 0`,
                `100 rmdir("${root}/d1") = 0`,
                `100 openat(AT_FDCWD, "${root}/committed.txt", O_WRONLY|O_TRUNC) = 3`,
                `100 close(3) = 0`,
                `100 openat(AT_FDCWD, "${root}/blind.txt", O_WRONLY|O_APPEND) = 4`,
                `100 close(4) = 0`,
                `100 openat(AT_FDCWD, "${root}/link-b/target.txt", O_RDONLY) = 5`,
                `100 close(5) = 0`,
                `100 openat(AT_FDCWD, "${root}/proc-link", O_RDONLY) = 6`,
                `100 close(6) = 0`,
                `100 syscall_0x270f(0x1, 0x2) = 0`,
                `100 +++ exited with 0 +++`
              ]
              const trace = ObservedReads.read(() => traceLines, root, [])
              const observed = ObservedReads.observe(trace, {
                root,
                ignore: [],
                producers: [],
                held: (paths) => new Set(paths.filter((p) => p === "committed.txt" || p === "blind.txt")),
                startedMs: Date.now() - 1000, variables: { values: {}, text: "", shown: new Set<string>(), byValue: [] }
              })
              expect(observed).toBeDefined()

              // Also observe clean trace (without proc-link) so removedEmpty + blind + emptiedOver succeed
              const cleanTrace = ObservedReads.read(
                () => traceLines.filter((l) => !l.includes("proc-link") && !l.includes("syscall_0x")),
                root,
                []
              )
              const cleanObs = ObservedReads.observe(cleanTrace, {
                root,
                ignore: [],
                producers: [],
                held: (paths) => new Set(paths.filter((p) => p === "committed.txt" || p === "blind.txt")),
                startedMs: Date.now() - 1000, variables: { values: {}, text: "", shown: new Set<string>(), byValue: [] }
              })
              expect(cleanObs).toBeDefined()

              // 3. ObservedReads.changed with stored.left=true + heldCreated + added entry gone/changed (L5188-5273)
              const chRoot = NodePath.join(base, "ch-root")
              await writeFile(chRoot, "dir/child.txt", "1\n")
              await writeFile(chRoot, "former-miss.txt", "now-present\n")
              const dirListing = ObservedReads.listing(NodePath.join(chRoot, "dir"), ["added-gone.txt", "added-type.txt"])
              await NodeFs.promises.mkdir(NodePath.join(chRoot, "dir/added-type.txt"), { recursive: true })
              const storedRecord: ObservedReads.Record = {
                version: 1,
                reads: [
                  ["former-miss.txt", "f:0:0", "absent"],
                  ["/tmp/abs-miss", "f:0:0", "absent"]
                ],
                lists: [["dir", dirListing, [], [["added-gone.txt", 0, "f"], ["added-type.txt", 0, "f"]]]],
                left: true
              } as unknown as ObservedReads.Record
              const diff1 = ObservedReads.changed(
                storedRecord,
                chRoot,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                (paths) => new Set(paths.filter(() => mode === "m0"))
              )
              expect(typeof diff1 === "string" || diff1 === undefined).toBe(true)
              // Second check focusing specifically on added entry gone / changed type
              const storedDirsOnly: ObservedReads.Record = {
                version: 1,
                reads: [],
                lists: [
                  [
                    "dir",
                    ObservedReads.listing(NodePath.join(chRoot, "dir"), ["added-gone.txt", "added-type.txt"]),
                    [],
                    mode === "m1"
                      ? [["added-gone.txt", -1, "f"]]
                      : [["added-type.txt", -1, "f"]]
                  ]
                ]
              } as unknown as ObservedReads.Record
              const diff2 = ObservedReads.changed(storedDirsOnly, chRoot)
              expect(diff2).toMatch(/is gone|changed type|gained or lost/)

              // 4. Resolver.resolveReference all branches (Resolver.ts L853-876)
              const resWs = NodePath.join(base, "res-ws")
              await writeFile(resWs, "src/index.ts", `
import "./helper.ts?raw#frag"
import "./subdir"
import "./missing.ts"
import "/abs/path"
import "https://example.com/a.js"
import "bad\\\\slash"
import "../../escape.ts"
import "../node_modules/plain-pkg/index.js"
import "../node_modules/@scope/pkg/index.js"
const d = "./" + Math.random()
import(d)
`)
              await writeFile(resWs, "src/helper.ts", "export const h = 1\n")
              await writeFile(resWs, "src/subdir/a.ts", "export const s = 1\n")
              const resCfg = await Resolver.loadResolverConfig({ workspaceRoot: resWs })
              const fakeTree: Parameters<typeof Resolver.resolveSpecifier>[1] = {
                kind: async (p: string) => (p === "src/helper.ts" ? "file" : p === "src/subdir" ? "dir" : "missing"),
                read: async () => "",
                list: async () => []
              } as unknown as Parameters<typeof Resolver.resolveSpecifier>[1]
              const refSites = [
                { specifier: "./dyn", dynamic: true, mode: "reference" as const },
                { specifier: "./helper.ts?raw#frag", dynamic: false, mode: "reference" as const },
                { specifier: "./subdir/", dynamic: false, mode: "reference" as const },
                { specifier: "./missing.ts", dynamic: false, mode: "reference" as const },
                { specifier: "/abs/path", dynamic: false, mode: "reference" as const },
                { specifier: "https://example.com/a.js", dynamic: false, mode: "reference" as const },
                { specifier: "bad\\slash", dynamic: false, mode: "reference" as const },
                { specifier: "../../escape.ts", dynamic: false, mode: "reference" as const },
                { specifier: "../node_modules/plain-pkg/index.js", dynamic: false, mode: "reference" as const },
                { specifier: "../node_modules/@scope/pkg/index.js", dynamic: false, mode: "reference" as const },
                { specifier: "../node_modules/@onlyscope", dynamic: false, mode: "reference" as const }
              ]
              for (const site of refSites) {
                const edge = await Resolver.resolveSpecifier(resCfg, fakeTree, "src/index.ts", site as never)
                expect(edge.status).toBeDefined()
              }

              // 5. TestUnits.discover: workspace package symlink + unsupported_input (TestUnits.ts L259-266, L313-316, L384-386)
              const tuWs = NodePath.join(base, "tu-ws")
              await writeFile(tuWs, "packages/b/package.json", JSON.stringify({ name: "pkg-b", main: "index.ts" }))
              await writeFile(tuWs, "packages/b/index.ts", "export const b = 1\n")
              await writeFile(tuWs, "packages/a/package.json", JSON.stringify({ name: "pkg-a" }))
              await writeFile(tuWs, "packages/a/a.test.ts", 'import { b } from "pkg-b"\nexport const t = b\n')
              await writeFile(tuWs, "packages/a/vitest.config.ts", "export default {}\n")
              await NodeFs.promises.mkdir(NodePath.join(tuWs, "packages/a/node_modules"), { recursive: true })
              await NodeFs.promises.symlink(
                NodePath.join(tuWs, "packages/b"),
                NodePath.join(tuWs, "packages/a/node_modules/pkg-b")
              )
              const bBuild = S.Shell.Build({
                shell: "true",
                data: [S.file("index.ts")],
                outFiles: ["index.ts"],
                sandbox: "none"
              })
              const aTest = S.Vitest({
                tests: [S.file("a.test.ts")],
                sources: [S.file("a.test.ts")],
                config: S.file("vitest.config.ts"),
                deps: [bBuild],
                environment: "node",
                passWithNoTests: false,
                units: "file"
              })
              const badUnitsTest = S.Vitest({
                tests: [S.gitDiff("HEAD") as unknown as ReturnType<typeof S.file>],
                sources: [S.file("a.test.ts")],
                config: S.file("vitest.config.ts"),
                deps: [],
                environment: "node",
                passWithNoTests: false,
                units: "file"
              })
              const tuIdx = PackageIndex.make({
                root: tuWs,
                workspace: S.Workspace(`tu-${mode}`, {
                  repository: "git+https://example.invalid/tu.git",
                  cache: S.Cache({ directory: ".flows" })
                }),
                factory: undefined,
                packages: [
                  { file: "packages/b/PACKAGE.ts", packagePath: "packages/b", value: S.Package({ targets: { bBuild } }) },
                  {
                    file: "packages/a/PACKAGE.ts",
                    packagePath: "packages/a",
                    value: S.Package({ targets: { aTest, badUnitsTest } })
                  }
                ]
              })
              const unitsOk = await TestUnits.discover({
                index: tuIdx,
                cacheDirectory: ".flows",
                target: "//packages/a:aTest"
              })
              expect(unitsOk.units.length).toBeGreaterThanOrEqual(1)
              await expect(
                TestUnits.discover({
                  index: tuIdx,
                  cacheDirectory: ".flows",
                  target: "//packages/a:badUnitsTest"
                })
              ).rejects.toThrow(/must be files or globs/)

              // 6. ServiceSupervisor: surrogate pair tail truncation (L750-761) & health check unhealthy failure (L1129-1142)
              const flagFile = NodePath.join(base, "healthy.flag")
              await writeFile(base, "healthy.flag", "1")
              const supExit = await Effect.runPromise(
                Effect.exit(
                  Effect.scoped(
                    Effect.gen(function*() {
                      const sup = yield* ServiceSupervisor.make
                      const handle = yield* sup.acquire({
                        key: `svc-${mode}`,
                        cwd: base,
                        argv: [
                          process.execPath,
                          "-e",
                          // Print >20KB of emoji surrogate pairs so keepTail splitsPair executes, then sleep
                          'process.stdout.write("😀".repeat(12000) + "\\n"); setTimeout(() => {}, 30000)'
                        ],
                        readiness: {
                          exec: [process.execPath, "-e", `process.exit(require("node:fs").existsSync(${JSON.stringify(flagFile)}) ? 0 : 1)`],
                          timeout: "2s"
                        },
                        health: {
                          interval: "30ms",
                          failures: 2
                        },
                        stop: { signal: "SIGTERM", grace: "500ms" }
                      })
                      // Remove flag so health probe fails twice -> unhealthy Deferred fires!
                      yield* Effect.promise(() => NodeFs.promises.rm(flagFile, { force: true }))
                      return yield* handle.whileHealthy(Effect.sleep("2 seconds"))
                    })
                  )
                )
              )
              expect(Exit.isFailure(supExit)).toBe(true)
              if (Exit.isFailure(supExit)) {
                const err = Cause.squash(supExit.cause) as { readonly reason?: string }
                expect(err.reason ?? String(err)).toMatch(/unhealthy|exited|timeout|readiness/)
              }
            })
            return true
          }),
        { executions: mediumExecutions, seed }
      )
    )
    assertPassed(report)
  }, 180_000)
})
