import { Fuzz } from "@smthrs/fuzz"
import { Smithers as S } from "@smthrs/targets"
import { Arbitrary, Effect, Schema } from "effect"
import { execFileSync } from "node:child_process"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as AgentSession from "../src/AgentSession.ts"
import * as Executor from "../src/Executor.ts"
import * as Machine from "../src/internal/Machine.ts"
import { executeEffect, ExecutionServices, executionServicesLive } from "../src/internal/PackageRunner.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as Resolver from "../src/Resolver.ts"
import * as ServiceSupervisor from "../src/ServiceSupervisor.ts"
import * as StampExec from "../src/StampExec.ts"
import { serve } from "./helpers/ServeCli.ts"

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
    await Machine.remove(dir)
  }
}

const writeExecutable = async (path: string, content: string): Promise<void> => {
  await Fs.writeFile(path, content, { mode: 0o755 })
  await Fs.chmod(path, 0o755)
}

const findSetuidBinary = (): string | undefined => {
  for (const candidate of ["/usr/bin/sudo", "/usr/bin/passwd", "/usr/bin/su", "/bin/su", "/usr/bin/chsh"]) {
    try {
      const st = NodeFs.statSync(candidate)
      if ((st.mode & 0o6000) !== 0) return candidate
    } catch {
      // skip
    }
  }
  return undefined
}

const slugArb = Schema.Literals(["aa", "b1", "c2", "d3"])

describe("@smthrs/build-cli Wave-6H: PackageRunner putBack/runKept/restoreManifests/withRights, PackagePlanner approval+stamps+RepoResolution+GoExec, Cli watch/affected/units & AgentSession CLI/patchPath fuzz", () => {
  it(
    "PackageRunner machine putBack/runKept, CAS restoreManifests on deleted outputs & withRights/rememberRights",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          slug: slugArb,
          leaveDaemon: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ slug, leaveDaemon }) =>
            Effect.promise(async () => {
              await withTempDir("smthrs-w6h-run-", async (root) => {
                execFileSync("git", ["init", "-q"], { cwd: root })
                execFileSync("git", ["config", "user.email", "w6h@example.invalid"], { cwd: root })
                execFileSync("git", ["config", "user.name", "w6h"], { cwd: root })

                await Fs.writeFile(
                  NodePath.join(root, "package.json"),
                  JSON.stringify({ name: `w6h-${slug}`, version: "1.0.0", packageManager: "pnpm@11.21.0" })
                )
                await Fs.writeFile(NodePath.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
                await Fs.writeFile(NodePath.join(root, "src.txt"), `v1-${slug}\n`)
                await Fs.writeFile(NodePath.join(root, "cons-in.txt"), `c1-${slug}\n`)
                await Fs.writeFile(NodePath.join(root, ".gitignore"), ".flows/\ndist/\nsingle.txt\nkept-file.txt\n")

                execFileSync("git", ["add", "."], { cwd: root })
                execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: root })

                const manifest = S.file("//package.json")
                // 1. Build target with BOTH outDirs and outFiles -> delete outputs -> re-run triggers answerTargetHit + restoreManifests!
                const prodOut = S.Shell.Build({
                  shell: `mkdir -p dist && printf 'dir-${slug}' > dist/a.txt && printf 'file-${slug}' > single.txt`,
                  outDirs: ["dist"],
                  outFiles: ["single.txt"],
                  data: [S.file("//src.txt")],
                  sandbox: "none"
                })
                // 2. Machine-scoped producer -> consumer for putBack / runKept
                const prodScript = leaveDaemon
                  ? `node -e 'setTimeout(() => {}, 2500)' </dev/null >/dev/null 2>&1 & echo daemon-${slug} > kept-file.txt`
                  : `echo file-${slug} > kept-file.txt`
                const keptProd = S.Shell.Test({
                  shell: prodScript,
                  data: [S.file("//src.txt")],
                  machine: "job",
                  sandbox: "none"
                })
                const keptCons = S.Shell.Test({
                  shell: "cat kept-file.txt cons-in.txt >/dev/null",
                  data: [keptProd, S.file("//cons-in.txt")],
                  machine: "job",
                  sandbox: "none"
                })

                // 3. Target invoking a real setuid binary (if available on host) to hit ObservedReads.rightsIn -> withRights -> rememberRights
                const setuidBin = findSetuidBinary()
                const rightsTarget = S.Shell.Test({
                  shell: setuidBin !== undefined ? `${setuidBin} --help >/dev/null 2>&1 || true` : "true",
                  data: [S.file("//src.txt")],
                  machine: "job",
                  sandbox: "none"
                })

                const index = PackageIndex.make({
                  root,
                  workspace: S.Workspace("w6h-run", {
                    repository: "git+https://example.invalid/w6h-run.git",
                    cache: S.Cache({ directory: ".flows" }),
                    runtime: S.Runtime.Node({ version: ">=26.4.0" }),
                    packageManager: S.PackageManager.Pnpm({ manifest, lockfile: S.file("//pnpm-lock.yaml") }),
                    nodeModules: S.Npm.NodeModules({ packageJson: manifest }),
                    host: S.Host({ bins: ["sh", "cat", "mkdir", "printf", "node"] }),
                    sandboxes: S.Sandboxes({ default: S.Sandbox.None() })
                  }),
                  factory: undefined,
                  packages: [
                    {
                      file: "PACKAGE.ts",
                      packagePath: "",
                      value: S.Package({
                        targets: { prodOut, keptProd, keptCons, rightsTarget }
                      })
                    }
                  ]
                })

                const keptDir = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-w6h-keep-")))
                const env: Record<string, string | undefined> = {
                  ...process.env,
                  [Machine.keepVariable]: JSON.stringify({ [root]: keptDir })
                }
                const runSet = async (patterns: ReadonlyArray<string>, extraServices?: Partial<ExecutionServices>) => {
                  const opts: PackageExec.RunOptions = {
                    index,
                    patterns,
                    verb: "auto",
                    cacheDirectory: ".flows",
                    jobs: 2,
                    environment: env,
                    log: () => {}
                  }
                  const pl = await PackageExec.plan(opts)
                  const svc: ExecutionServices = { ...executionServicesLive, ...extraServices }
                  return await Effect.runPromise(
                    executeEffect(pl, opts).pipe(Effect.provideService(ExecutionServices, svc))
                  )
                }

                try {
                  // Step A: Run prodOut -> delete dist & single.txt -> re-run prodOut (exercises answerTargetHit + restoreManifests!)
                  const b1 = await runSet(["//:prodOut"])
                  expect(b1.ok).toBe(true)
                  await Fs.rm(NodePath.join(root, "dist"), { recursive: true, force: true })
                  await Fs.rm(NodePath.join(root, "single.txt"), { force: true })
                  const b2 = await runSet(["//:prodOut"])
                  expect(b2.ok).toBe(true)
                  expect(b2.results.find((r) => r.label === "//:prodOut")?.status).toBe("hit")
                  expect(await Fs.readFile(NodePath.join(root, "single.txt"), "utf8")).toBe(`file-${slug}`)
                  expect(await Fs.readFile(NodePath.join(root, "dist/a.txt"), "utf8")).toBe(`dir-${slug}`)

                  // Step B: Machine keptProd -> keptCons (Build 1 records; Build 2 mutates cons-in.txt -> putBack / runKept!)
                  const k1 = await runSet(["//:keptCons"])
                  expect(k1.ok).toBe(true)
                  await Fs.writeFile(NodePath.join(root, "cons-in.txt"), `c2-${slug}\n`)
                  const k2 = await runSet(["//:keptCons"])
                  expect(k2.ok).toBe(true)

                  // Step C: Rights-needing binary under machine (with noNewPrivileges: false, then true!)
                  const rOk = await runSet(["//:rightsTarget"])
                  expect(rOk.ok).toBe(true)
                  if (setuidBin !== undefined) {
                    await Fs.writeFile(NodePath.join(root, "src.txt"), `v2-${slug}\n`)
                    const rNnp = await runSet(["//:rightsTarget"], { noNewPrivileges: () => true })
                    expect(rNnp.results.length).toBeGreaterThanOrEqual(1)
                  }
                } finally {
                  await Machine.remove(keptDir)
                }
              })
              return true
            }),
          { seed: 20262001, executions: 2 }
        )
      )
      assertPassed(report)
    },
    120_000
  )

  it(
    "PackagePlanner approval+stamps, Repo.Target childPlan + RepoResolution refusals, GoExec Go.Packages/Go.ModDownload/Toolchain & PackageDiscovery refusals",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          slug: slugArb,
          badStamp: Schema.Boolean,
          badChild: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ slug, badStamp, badChild }) =>
            Effect.promise(async () => {
              await withTempDir("smthrs-w6h-plan-", async (root) => {
                execFileSync("git", ["init", "-q"], { cwd: root })
                execFileSync("git", ["config", "user.email", "w6h@example.invalid"], { cwd: root })
                execFileSync("git", ["config", "user.name", "w6h"], { cwd: root })

                const binDir = NodePath.join(root, "fake-bin")
                await Fs.mkdir(binDir, { recursive: true })
                await writeExecutable(
                  NodePath.join(binDir, "go"),
                  `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "version") { console.log("go version go1.24.0 linux/amd64"); process.exit(0); }
if (args[0] === "env") { console.log(JSON.stringify({ GOROOT: "/usr/local/go", GOOS: "linux", GOARCH: "amd64", CGO_ENABLED: "0" })); process.exit(0); }
if (args[0] === "list") {
  console.log(JSON.stringify({ ImportPath: "example.invalid/mod", Dir: process.cwd(), GoFiles: ["main.go"], Module: { Path: "example.invalid/mod", Dir: process.cwd() } }));
  process.exit(0);
}
process.exit(0);
`
                )
                await writeExecutable(
                  NodePath.join(binDir, "pnpm"),
                  `#!${process.execPath}\nif (process.argv[2] === "--version") { console.log("11.21.0"); process.exit(0); }\nprocess.exit(0);\n`
                )

                // Main workspace files + Go module + child repository
                await Fs.writeFile(
                  NodePath.join(root, "package.json"),
                  JSON.stringify({ name: `w6h-p-${slug}`, version: "1.0.0", packageManager: "pnpm@11.21.0" })
                )
                await Fs.writeFile(NodePath.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
                await Fs.writeFile(NodePath.join(root, "go.mod"), "module example.invalid/mod\n\ngo 1.24.0\n")
                await Fs.writeFile(NodePath.join(root, "go.sum"), "")
                await Fs.writeFile(NodePath.join(root, "go-versions.json"), JSON.stringify({ go: "1.24.0" }))
                await Fs.writeFile(NodePath.join(root, "main.go"), "package main\nfunc main() {}\n")

                const childDir = NodePath.join(root, "child-repo")
                await Fs.mkdir(childDir, { recursive: true })
                if (!badChild) {
                  execFileSync("git", ["init", "-q"], { cwd: childDir })
                  execFileSync("git", ["config", "user.email", "c@example.invalid"], { cwd: childDir })
                  execFileSync("git", ["config", "user.name", "c"], { cwd: childDir })
                  await Fs.writeFile(
                    NodePath.join(childDir, "WORKSPACE.ts"),
                    `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("child-${slug}", {
  repository: "git+https://example.invalid/child.git",
  cache: S.Cache({ directory: ".flows" }),
  host: S.Host({ bins: ["sh"] }),
  sandboxes: S.Sandboxes({ default: S.Sandbox.None() })
})
`
                  )
                  await Fs.writeFile(
                    NodePath.join(childDir, "PACKAGE.ts"),
                    `import { Smithers as S } from "@smthrs/targets"
const bld = S.Shell.Build({ shell: "mkdir -p out && echo ok > out/a.txt", outDirs: ["out"], sandbox: "none" })
export const Package = S.Package({ targets: { bld } })
`
                  )
                  execFileSync("git", ["add", "."], { cwd: childDir })
                  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: childDir })
                }

                execFileSync("git", [
                  "add",
                  "package.json",
                  "pnpm-lock.yaml",
                  "go.mod",
                  "go.sum",
                  "go-versions.json",
                  "main.go"
                ], { cwd: root })
                execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root })

                const manifest = S.file("//package.json")
                const approvedTarget = S.Shell.Run({
                  bin: S.Host.bin("sh"),
                  args: ["-c", "echo $STAMP_VAL"],
                  env: {
                    STAMP_VAL: badStamp
                      ? StampExec.token("buildTime", S.Stamp.buildTime)
                      : StampExec.token("commit", S.Stamp.commit)
                  },
                  approval: "required",
                  sandbox: "none"
                })
                const goPkgs = S.Go.Packages({ pkgs: ["./..."] })
                const goMod = S.Go.ModDownload({
                  mod: S.file("//go.mod"),
                  sum: S.file("//go.sum"),
                  outDirs: ["//.go-mod-cache"]
                })
                const goTest = S.Go.Test({ pkgs: goPkgs, data: [goMod] })
                const repoTarget = S.Repo.Target("child", "//:bld")

                const index = PackageIndex.make({
                  root,
                  workspace: S.Workspace("w6h-plan", {
                    repository: "git+https://example.invalid/w6h-plan.git",
                    cache: S.Cache({ directory: ".flows" }),
                    runtime: S.Runtime.Node({ version: ">=26.4.0" }),
                    packageManager: S.PackageManager.Pnpm({ manifest, lockfile: S.file("//pnpm-lock.yaml") }),
                    nodeModules: S.Npm.NodeModules({ packageJson: manifest }),
                    toolchains: [S.Go.Toolchain({
                      mod: S.file("//go.mod"),
                      sum: S.file("//go.sum"),
                      versions: S.Mise({ config: S.file("//go-versions.json") })
                    })],
                    repos: { child: S.LocalRepository("child-repo") },
                    host: S.Host({ bins: ["sh", "go", "pnpm"] }),
                    sandboxes: S.Sandboxes({ default: S.Sandbox.None() })
                  }),
                  factory: undefined,
                  packages: [
                    {
                      file: "PACKAGE.ts",
                      packagePath: "",
                      value: S.Package({
                        targets: { approvedTarget, goPkgs, goMod, goTest, repoTarget }
                      })
                    }
                  ]
                })

                const env = { PATH: `${binDir}:${process.env["PATH"] ?? "/usr/bin:/bin"}` }
                const planned = await PackageExec.plan({
                  index,
                  patterns: ["//..."],
                  verb: "auto",
                  cacheDirectory: ".flows",

                  environment: env,
                  log: () => {}
                })
                const approvedNode = planned.nodes.get("//:approvedTarget")
                expect(approvedNode).toBeDefined()
                if (badStamp) {
                  expect(approvedNode?.refusal).toContain("buildTime")
                } else {
                  expect(approvedNode?.refusal ?? "").not.toContain("buildTime")
                }

                // PackageDiscovery refusal paths: legacy BUILD.ts, invalid local repository (not dir / no WORKSPACE.ts), symlinked FACTORY.ts
                await withTempDir("smthrs-w6h-disc-", async (droot) => {
                  await Fs.writeFile(NodePath.join(droot, "WORKSPACE.ts"), "export const Workspace = {}\n")
                  await Fs.writeFile(NodePath.join(droot, "BUILD.ts"), "export default {}\n")
                  await expect(PackageDiscovery.discover(droot)).rejects.toThrow(/BUILD\.ts/)
                  await Fs.rm(NodePath.join(droot, "BUILD.ts"))

                  await Fs.writeFile(NodePath.join(droot, "not-a-dir"), "file")
                  await expect(
                    PackageDiscovery.discover(droot, {
                      repositories: { r1: { path: "not-a-dir" } }
                    })
                  ).rejects.toThrow(/not a directory/)

                  await Fs.mkdir(NodePath.join(droot, "empty-repo"), { recursive: true })
                  await expect(
                    PackageDiscovery.discover(droot, {
                      repositories: { r2: { path: "empty-repo" } }
                    })
                  ).rejects.toThrow(/WORKSPACE\.ts/)
                })
              })
              return true
            }),
          { seed: 20262002, executions: 2 }
        )
      )
      assertPassed(report)
    },
    90_000
  )

  it(
    "Cli watch --once + affected run + units, AgentSession CLI codex/claude + quoted patchPath, Executor truncateToBudget, Resolver resolveReference & ServiceSupervisor docker late-reap",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          slug: slugArb,
          badCliOutput: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ slug, badCliOutput }) =>
            Effect.promise(async () => {
              // 1. Executor.describeFailure exceeding budget -> exercises truncateToBudget with UTF-16 surrogates!
              const hugeFailure = Executor.describeFailure({
                msg: "😀".repeat(25_000) + `END-${slug}`
              })
              expect(hugeFailure).toContain("truncated")

              await withTempDir("smthrs-w6h-misc-", async (root) => {
                execFileSync("git", ["init", "-q"], { cwd: root })
                execFileSync("git", ["config", "user.email", "w6h@example.invalid"], { cwd: root })
                execFileSync("git", ["config", "user.name", "w6h"], { cwd: root })
                execFileSync("git", ["config", "core.quotepath", "true"], { cwd: root })

                // 2. AgentSession.expandDiffSlice with core.quotepath=true + C-quoted octal & backslash escapes in patchPath!
                await Fs.mkdir(NodePath.join(root, "src"), { recursive: true })
                const quotedFile = `src/café "q" \\ ${slug}.ts`
                await Fs.writeFile(NodePath.join(root, quotedFile), "export const a = 1\n")
                await Fs.writeFile(NodePath.join(root, "src/sub.ts"), "export const b = 1\n")
                await Fs.writeFile(
                  NodePath.join(root, "package.json"),
                  JSON.stringify({ name: `w6h-m-${slug}`, version: "1.0.0" })
                )
                await Fs.writeFile(
                  NodePath.join(root, "WORKSPACE.ts"),
                  `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("w6h-m-${slug}", {
  repository: "git+https://example.invalid/w6h-m.git",
  cache: S.Cache({ directory: ".flows" }),
  host: S.Host({ bins: ["sh"] }),
  sandboxes: S.Sandboxes({ default: S.Sandbox.None() })
})
`
                )
                await Fs.writeFile(
                  NodePath.join(root, "PACKAGE.ts"),
                  `import { Smithers as S } from "@smthrs/targets"
const bld = S.Shell.Build({
  shell: "mkdir -p out && echo ok > out/x.txt",
  outDirs: ["out"],
  data: [S.file("//src/sub.ts")],
  sandbox: "none"
})
const t1 = S.Shell.Test({ shell: "true", data: [bld], sandbox: "none" })
export const Package = S.Package({ targets: { bld, t1 } })
`
                )
                execFileSync("git", ["add", "."], { cwd: root })
                execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root })

                await Fs.writeFile(NodePath.join(root, quotedFile), `export const a = 2 // HIT_${slug}\n`)
                await Fs.writeFile(NodePath.join(root, "src/sub.ts"), `export const b = 2 // HIT_${slug}\n`)

                const slice = await Effect.runPromise(
                  AgentSession.expandDiffSlice(root, [S.gitDiff({ base: "HEAD", addedLines: `HIT_${slug}` })])
                )
                expect(slice.files.length).toBeGreaterThanOrEqual(2)

                // 3. AgentSession.makeCliSessionFactory with fake codex & claude CLIs (exercises extractCodexText / extractClaudeText!)
                const binDir = NodePath.join(root, "fake-bin")
                await Fs.mkdir(binDir, { recursive: true })
                const envEnvelope = JSON.stringify({ findings: [], edits: [], note: `ok-${slug}` })
                await writeExecutable(
                  NodePath.join(binDir, "codex"),
                  `#!${process.execPath}
if (${badCliOutput}) { console.log(JSON.stringify({ type: "other" })); process.exit(0); }
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: ${
                    JSON.stringify(envEnvelope)
                  } } }));
process.exit(0);
`
                )
                await writeExecutable(
                  NodePath.join(binDir, "claude"),
                  `#!${process.execPath}
if (${badCliOutput}) { console.log(JSON.stringify({ notResult: 1 })); process.exit(0); }
console.log(JSON.stringify({ result: ${JSON.stringify(envEnvelope)} }));
process.exit(0);
`
                )
                const factory = AgentSession.makeCliSessionFactory({
                  workspaceRoot: root,
                  agents: S.Agents({}),
                  environment: { PATH: `${binDir}:${process.env["PATH"] ?? "/usr/bin:/bin"}` }
                })
                const codexSess = await Effect.runPromise(factory.open(S.Agent.Codex({ model: "gpt-5" })))
                const codexExit = await Effect.runPromiseExit(codexSess.run({ purpose: "lint", prompt: "hi" }))
                expect(codexExit._tag).toBe(badCliOutput ? "Failure" : "Success")

                const claudeSess = await Effect.runPromise(
                  factory.open(S.Agent.ClaudeCode({ model: "claude-sonnet-4" }))
                )
                const claudeExit = await Effect.runPromiseExit(claudeSess.run({ purpose: "lint", prompt: "hi" }))
                expect(claudeExit._tag).toBe(badCliOutput ? "Failure" : "Success")

                // 4. Resolver.resolveSpecifier with kind: "reference" (file, dir, node_modules, absolute, dynamic)
                const resRoot = NodePath.join(root, "res-ref")
                await Fs.mkdir(NodePath.join(resRoot, "src/sub"), { recursive: true })
                await Fs.mkdir(NodePath.join(resRoot, "node_modules/@org/lib"), { recursive: true })
                await Fs.writeFile(NodePath.join(resRoot, "src/asset.txt"), "hi")
                await Fs.writeFile(NodePath.join(resRoot, "node_modules/@org/lib/a.js"), "export const a = 1\n")
                await Fs.writeFile(
                  NodePath.join(resRoot, "src/index.ts"),
                  [
                    "export const a = new URL(\"./asset.txt?raw#h\", import.meta.url)",
                    "export const b = new URL(\"./sub/\", import.meta.url)",
                    "export const c = new URL(\"../node_modules/@org/lib/a.js\", import.meta.url)",
                    "export const d = new URL(\"/abs/x.txt\", import.meta.url)",
                    "export const e = new URL(globalThis.dyn, import.meta.url)"
                  ].join("\n")
                )
                const resCfg = await Resolver.loadResolverConfig({ workspaceRoot: resRoot })
                const closure = await Resolver.computeClosure({
                  entries: ["src/index.ts"],
                  config: resCfg
                })
                expect(closure.result.files.length).toBeGreaterThanOrEqual(1)

                // 5. Cli watch --results-file refusal, watch --once --plan, affected test live run
                const watchRefuse = await serve(root, ["watch", "build", "//:bld", "--results-file", "r.json"])
                expect(watchRefuse.exitCode).not.toBe(0)
                const watchOnce = await serve(root, ["watch", "build", "//:bld", "--once", "--plan", "--verbose"])
                expect(watchOnce.exitCode).toBe(0)
                const affRun = await serve(root, ["affected", "test", "//...", "--base", "HEAD"])
                expect(affRun.exitCode).toBe(0)

                // 6. ServiceSupervisor docker create timeout -> exercises reapLateContainer!
                await writeExecutable(
                  NodePath.join(binDir, "docker-slow"),
                  `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "create") { setTimeout(() => { console.log("b".repeat(64)); process.exit(0); }, 2000); return; }
if (args[0] === "ps") { console.log("b".repeat(64)); process.exit(0); }
process.exit(0);
`
                )
                const slowDockerExit = await Effect.runPromiseExit(
                  Effect.scoped(
                    Effect.gen(function*() {
                      const sup = yield* ServiceSupervisor.make
                      return yield* sup.acquire({
                        key: `//:slow-dk-${slug}`,
                        cwd: root,
                        docker: `smthrs-late-${slug}`,
                        argv: [NodePath.join(binDir, "docker-slow"), "create", "alpine"],
                        readiness: { exec: ["true"], timeout: "150ms" },
                        stop: { signal: "SIGTERM", grace: "100ms" }
                      })
                    })
                  )
                )
                expect(slowDockerExit._tag).toBe("Failure")
              })
              return true
            }),
          { seed: 20262003, executions: 2 }
        )
      )
      assertPassed(report)
    },
    120_000
  )
})
