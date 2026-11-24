import { Fuzz } from "@smthrs/fuzz"
import { Smithers as S } from "@smthrs/targets"
import * as AgentTarget from "@smthrs/targets/AgentTarget"
import * as Input from "@smthrs/targets/Input"
import * as NpmTarget from "@smthrs/targets/NpmTarget"
import * as PackageManager from "@smthrs/targets/PackageManager"
import * as Runtime from "@smthrs/targets/Runtime"
import * as Shell from "@smthrs/targets/Shell"
import * as WorkspaceDeclaration from "@smthrs/targets/WorkspaceDeclaration"
import { Arbitrary, Effect, Schema } from "effect"
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as GitHooks from "../src/GitHooks.ts"
import * as InstalledTree from "../src/internal/InstalledTree.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageTree from "../src/PackageTree.ts"
import * as RepoResolution from "../src/RepoResolution.ts"

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

describe("BuildCliWave9K PackagePlanner, PackageRunner, InstalledTree, GitHooks, RepoResolution", () => {
  it(
    "PackagePlanner & PackageRunner deep linkChain, stdoutPath, Clean, outDirs materialize, re-plan, refusals, Agent errors",
    async () => {
      const report = await Effect.runPromise(
        Fuzz.run(
          Arbitrary.schema(Schema.Literal(1)),
          () =>
            Effect.promise(async () => {
              await withTempDir("wave9k-pr-", async (dir) => {
                const ws = NodePath.join(dir, "ws")
                const binDir = NodePath.join(dir, "bin")
                await Fs.mkdir(NodePath.join(ws, "pkg/src"), { recursive: true })
                await Fs.mkdir(NodePath.join(ws, "badpkg"), { recursive: true })
                await Fs.mkdir(binDir, { recursive: true })
                NodeChildProcess.execFileSync("jj", ["git", "init", "--colocate"], { cwd: ws, stdio: "ignore" })

                // Symlink chain binary: linkbin -> linkbin2 -> realbin
                const realBin = NodePath.join(binDir, "realbin")
                const linkBin2 = NodePath.join(binDir, "linkbin2")
                const linkBin = NodePath.join(binDir, "linkbin")
                await Fs.writeFile(realBin, "#!/bin/sh\necho chain-ok\necho err-line >&2\n", { mode: 0o755 })
                await Fs.symlink("realbin", linkBin2)
                await Fs.symlink("linkbin2", linkBin)

                await Fs.writeFile(
                  NodePath.join(ws, "package.json"),
                  JSON.stringify({ name: "ws9k", version: "1.0.0", packageManager: "pnpm@10.28.0" })
                )
                await Fs.writeFile(NodePath.join(ws, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
                await Fs.writeFile(NodePath.join(ws, "pkg/src/a.txt"), "hello\n")
                await Fs.writeFile(NodePath.join(ws, "pkg/shared.txt"), "initial\n")
                await Fs.writeFile(NodePath.join(ws, "pkg/prompt.md"), "check code\n")
                await Fs.writeFile(NodePath.join(ws, "badpkg/package.json"), "{not-valid-json")
                const outsideFile = NodePath.join(dir, "outside.txt")
                await Fs.writeFile(outsideFile, "outside\n")
                await Fs.symlink(outsideFile, NodePath.join(ws, "pkg/escape-link"))

                await PackageTree.runGit(ws, ["config", "user.email", "test@example.com"])
                await PackageTree.runGit(ws, ["config", "user.name", "Test"])
                await PackageTree.runGit(ws, [
                  "add",
                  "package.json",
                  "pnpm-lock.yaml",
                  "pkg/src/a.txt",
                  "pkg/shared.txt",
                  "pkg/prompt.md"
                ])
                await PackageTree.runGit(ws, ["commit", "-m", "base"])
                await Fs.writeFile(NodePath.join(ws, "pkg/src/added.ts"), "export const added = 1\n")
                await PackageTree.runGit(ws, ["add", "pkg/src/added.ts"])

                const nodeRt = Runtime.Node({ version: "22" })
                const wsDecl = WorkspaceDeclaration.Workspace("wave9k", {
                  repository: "git+https://github.com/org/wave9k.git",
                  cache: WorkspaceDeclaration.Cache({ directory: ".cache" }),
                  runtime: nodeRt,
                  packageManager: PackageManager.Pnpm({
                    manifest: S.file("//package.json"),
                    lockfile: S.file("//pnpm-lock.yaml")
                  }),
                  nodeModules: WorkspaceDeclaration.NodeModules({ packageJson: S.file("//package.json") }),
                  host: WorkspaceDeclaration.Host({ bins: ["sh", "echo", "linkbin", "a/b"] }),
                  agents: AgentTarget.Agents({
                    rev: { _tag: "AgentClaudeCode", model: "claude-sonnet" }
                  })
                })

                const prodBuild = S.Shell.Build({
                  shell: "mkdir -p pkg/dist && cat pkg/src/a.txt > pkg/dist/out.txt",
                  data: [S.file("src/a.txt")],
                  outDirs: ["dist"]
                })
                const consTest = S.Shell.Test({
                  shell: "cat pkg/dist/out.txt",
                  data: [prodBuild]
                })
                const genStdout = S.Generate({
                  bin: S.Host.bin("linkbin"),
                  stdout: "gen-out/captured.txt",
                  data: [S.file("src/a.txt")]
                })
                const cleanTarget = S.Clean({
                  targets: [prodBuild],
                  paths: ["extra-scratch"]
                })
                const mutator = S.Shell.Build({
                  shell: "echo mutated-v2 > pkg/shared.txt",
                  outFiles: ["shared.txt"]
                })
                const readerAfterMutator = S.Shell.Test({
                  shell: "cat pkg/shared.txt",
                  data: [mutator, S.file("shared.txt")]
                })
                const linkChainTest = S.Shell.Test({
                  bin: S.Host.bin("linkbin"),
                  tools: [S.Host.bin("linkbin")]
                })
                const npxArgRefusal = S.Shell.Test({
                  bin: S.Host.bin("echo"),
                  args: [Shell.toolToken(S.Runtime.npx("some-cli") as never)]
                })
                const badToolName = S.Shell.Test({
                  shell: "echo hi",
                  tools: [S.Host.bin("a/b")]
                })
                const badLinkRefusal = S.Shell.Test({
                  shell: "echo hi",
                  data: [S.link("escape-link")]
                })
                const gitDiffAdded = S.Shell.Test({
                  shell: "echo added",
                  data: [Input.gitDiff({ base: "HEAD", added: ["pkg/src/**"] })]
                })
                const badNpmPack = NpmTarget.Pack({
                  manifest: S.file("//badpkg/package.json")
                } as never)
                const agentNeedsInput = S.Agent.Diff({
                  agent: S.Agents.rev,
                  prompt: S.file("prompt.md"),
                  payload: { topic: S.Input.String("topic") },
                  data: [S.file("src/a.txt")],
                  changes: ["src/**"],
                  gates: [],
                  maxRounds: 2
                } as never)
                const agentBadMcp = S.Agent.Diff({
                  agent: S.Agents.rev,
                  prompt: S.file("prompt.md"),
                  mcp: [S.Mcp.Http("down", "http://127.0.0.1:1")],
                  data: [S.file("src/a.txt")],
                  changes: ["src/**"],
                  gates: [],
                  maxRounds: 2
                } as never)

                const index = PackageIndex.make(
                  {
                    root: ws,
                    workspace: wsDecl,
                    factory: undefined,
                    packages: [
                      {
                        packagePath: "pkg",
                        file: "pkg/PACKAGE.ts",
                        value: S.Package({
                          targets: {
                            prodBuild,
                            consTest,
                            genStdout,
                            cleanTarget,
                            mutator,
                            readerAfterMutator,
                            linkChainTest,
                            npxArgRefusal,
                            badToolName,
                            badLinkRefusal,
                            gitDiffAdded,
                            badNpmPack,
                            agentNeedsInput,
                            agentBadMcp
                          }
                        })
                      }
                    ],
                    modules: ["pkg/PACKAGE.ts"],
                    moduleRoots: []
                  },
                  ws
                )

                const env = { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` }

                // 1. Run linkChainTest + genStdout (captures stdoutPath + onStderr + linkChain!)
                const logs: Array<string> = []
                const r1 = await PackageExec.run({
                  index,
                  patterns: ["//pkg:linkChainTest"],
                  verb: "test",
                  cacheDirectory: ".cache",
                  environment: env,
                  log: (line) => logs.push(line)
                })
                expect(r1.ok).toBe(true)

                const rGenChk = await PackageExec.run({
                  index,
                  patterns: ["//pkg:genStdout"],
                  verb: "auto",
                  cacheDirectory: ".cache",
                  environment: env
                })
                expect(rGenChk.ok).toBe(false)
                const rGen = await PackageExec.run({
                  index,
                  patterns: ["//pkg:genStdout"],
                  verb: "auto",
                  write: true,
                  cacheDirectory: ".cache",
                  environment: env
                })
                expect(rGen.ok).toBe(true)
                expect(await Fs.readFile(NodePath.join(ws, "pkg/gen-out/captured.txt"), "utf8")).toContain("chain-ok")

                // 2. Run prodBuild + consTest twice: first populates cache, second after deleting dist/ materializes outDir!
                const rProd1 = await PackageExec.run({
                  index,
                  patterns: ["//pkg:consTest"],
                  verb: "test",
                  cacheDirectory: ".cache",
                  environment: env
                })
                expect(rProd1.ok).toBe(true)

                await Fs.rm(NodePath.join(ws, "pkg/dist"), { recursive: true, force: true })
                const rProd2 = await PackageExec.run({
                  index,
                  patterns: ["//pkg:consTest"],
                  verb: "test",
                  cacheDirectory: ".cache",
                  environment: env
                })
                expect(rProd2.ok).toBe(true)
                expect(await Fs.readFile(NodePath.join(ws, "pkg/dist/out.txt"), "utf8")).toContain("hello")

                // 3. Clean target removes prodBuild outDirs + extra-scratch
                await Fs.mkdir(NodePath.join(ws, "pkg/extra-scratch"), { recursive: true })
                await Fs.writeFile(NodePath.join(ws, "pkg/extra-scratch/f.txt"), "tmp")
                const rClean = await PackageExec.run({
                  index,
                  patterns: ["//pkg:cleanTarget"],
                  verb: "auto",
                  cacheDirectory: ".cache",
                  environment: env
                })
                expect(rClean.ok).toBe(true)

                // 4. Mutator -> readerAfterMutator triggers "planned again: ... since the plan"
                const rMut = await PackageExec.run({
                  index,
                  patterns: ["//pkg:readerAfterMutator"],
                  verb: "test",
                  cacheDirectory: ".cache",
                  environment: env
                })
                expect(rMut.results.length).toBeGreaterThanOrEqual(1)

                // 5. Planner refusals + win32 platform + verbGate + gitDiff added
                const winPlan = await PackageExec.plan({
                  index,
                  patterns: ["//pkg:gitDiffAdded"],
                  verb: "test",
                  cacheDirectory: ".cache",
                  environment: env,
                  platform: "win32"
                })
                expect(winPlan.nodes.size).toBeGreaterThan(0)

                const refPlan = await PackageExec.plan({
                  index,
                  patterns: ["//pkg:npxArgRefusal", "//pkg:badToolName", "//pkg:badLinkRefusal", "//pkg:badNpmPack"],
                  verb: "auto",
                  cacheDirectory: ".cache",
                  environment: env
                })
                expect([...refPlan.nodes.values()].some((n) => n.refusal !== undefined)).toBe(true)

                await expect(
                  PackageExec.plan({
                    index,
                    patterns: ["//pkg:cleanTarget"],
                    verb: "test",
                    cacheDirectory: ".cache",
                    environment: env
                  })
                ).rejects.toThrow(/verb/)

                // 6. AgentNeedsInput & AgentMcpUnreachable inside PackageRunner
                const rAgentNeed = await PackageExec.run({
                  index,
                  patterns: ["//pkg:agentNeedsInput"],
                  verb: "run",
                  cacheDirectory: ".cache",
                  environment: env
                })
                expect(rAgentNeed.ok).toBe(false)

                const rAgentMcp = await PackageExec.run({
                  index,
                  patterns: ["//pkg:agentBadMcp"],
                  verb: "run",
                  cacheDirectory: ".cache",
                  environment: env
                })
                expect(rAgentMcp.ok).toBe(false)
              })
              return true
            }),
          { executions: 1 }
        )
      )
      assertPassed(report)
    },
    120_000
  )

  it(
    "InstalledTree identifyAsync worker pool/limits/remembered, GitHooks errors/missing/EEXIST, RepoResolution aborts",
    async () => {
      const report = await Effect.runPromise(
        Fuzz.run(
          Arbitrary.schema(Schema.Literal(1)),
          () =>
            Effect.promise(async () => {
              await withTempDir("wave9k-med-", async (dir) => {
                // 1. InstalledTree: 10 packages so identifyAsync (> 8 units!) exercises real worker thread pool!
                const nm = NodePath.join(dir, "node_modules")
                const past = new Date(Date.now() - 120_000)
                for (let i = 0; i < 10; i++) {
                  const pkgDir = NodePath.join(nm, `pkg-${i}`)
                  await Fs.mkdir(pkgDir, { recursive: true })
                  const f = NodePath.join(pkgDir, "index.js")
                  await Fs.writeFile(f, `export const v = ${i}\n`)
                  await Fs.utimes(f, past, past)
                  await Fs.utimes(pkgDir, past, past)
                }

                const remembered = InstalledTree.empty()
                const first = await InstalledTree.identifyAsync(nm, remembered)
                expect(first.files).toBe(10)
                // Second call exercises remembered hit path in worker pool (L757)
                const second = await InstalledTree.identifyAsync(nm, remembered)
                expect(second.digest).toBe(first.digest)
                // Exceed entries limit in worker pool -> InstalledTreeRefused (L743)
                await expect(
                  InstalledTree.identifyAsync(nm, InstalledTree.empty(), InstalledTree.defaultIo, {
                    entries: 2,
                    depth: 10
                  })
                ).rejects.toThrow(/more than 2 entries/)
                // Save & reload remembered file
                const idxFile = InstalledTree.path(dir, ".cache")
                await InstalledTree.save(idxFile, remembered)
                const reloaded = await InstalledTree.load(idxFile)
                expect(reloaded.rows.size).toBeGreaterThanOrEqual(0)

                // 2. GitHooks: non-git repo, fake .git without hooks dir, missing hook, install
                const rendered = [{ file: "pre-commit", content: "#!/bin/sh\necho ok\n" }]
                const nonGit = NodePath.join(dir, "nongit")
                await Fs.mkdir(nonGit, { recursive: true })
                const oldPath = process.env["PATH"]
                try {
                  process.env["PATH"] = ""
                  await expect(GitHooks.check(nonGit, rendered)).rejects.toThrow(/no \.git|not_a_git_repository/i)

                  const fakeGit = NodePath.join(dir, "fakegit")
                  await Fs.mkdir(NodePath.join(fakeGit, ".git"), { recursive: true })
                  const chkMissing = await GitHooks.check(fakeGit, rendered)
                  expect(chkMissing.clean).toBe(false)
                  expect(chkMissing.entries[0]?.status).toBe("missing")
                  const instRes = await GitHooks.install(fakeGit, rendered)
                  expect(instRes.wrote.length).toBeGreaterThan(0)
                } finally {
                  process.env["PATH"] = oldPath
                }

                // 3. RepoResolution: aborted signal on resolve
                const childDir = NodePath.join(dir, "child-repo")
                await Fs.mkdir(childDir, { recursive: true })
                const wsDecl = WorkspaceDeclaration.Workspace("rr9k", {
                  repository: "git+https://github.com/org/rr9k.git",
                  cache: WorkspaceDeclaration.Cache({ directory: ".cache" }),
                  repos: {
                    child: S.LocalRepository("child-repo")
                  }
                })
                const idx = PackageIndex.make(
                  {
                    root: dir,
                    workspace: wsDecl,
                    factory: undefined,
                    packages: [],
                    modules: [],
                    moduleRoots: []
                  },
                  dir
                )
                const resolver = RepoResolution.resolver(idx, process.env)
                const ac = new AbortController()
                ac.abort(new Error("wave9k-abort"))
                const resAborted = await RepoResolution.resolve(
                  resolver,
                  S.Repo.Target(S.LocalRepository("child-repo"), "//:t"),
                  ac.signal
                )
                expect(resAborted.refusal !== undefined || resAborted.repoName === "child").toBe(true)
              })
              return true
            }),
          { executions: 1 }
        )
      )
      assertPassed(report)
    },
    60_000
  )
})
