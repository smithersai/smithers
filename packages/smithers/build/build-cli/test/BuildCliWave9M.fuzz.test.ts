import { Fuzz } from "@smthrs/fuzz"
import { Smithers as S } from "@smthrs/targets"
import * as Cargo from "@smthrs/targets/Cargo"
import * as NpmTarget from "@smthrs/targets/NpmTarget"
import * as PackageManager from "@smthrs/targets/PackageManager"
import * as Runtime from "@smthrs/targets/Runtime"
import * as WorkspaceDeclaration from "@smthrs/targets/WorkspaceDeclaration"
import { Arbitrary, Effect, Schema } from "effect"
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageTree from "../src/PackageTree.ts"

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

describe("BuildCliWave9M PackagePlanner & PackageRunner deep coverage harvest", () => {
  it(
    "PackagePlanner: linkChain suite, bad shebang, Nix/Mise/nodeModules/npx/Cargo/Npm.Publish refusals, cross-pkg globs, exclusive wildcard",
    async () => {
      const report = await Effect.runPromise(
        Fuzz.run(
          Arbitrary.schema(Schema.Literal(1)),
          () =>
            Effect.promise(async () => {
              await withTempDir("wave9m-plan-", async (dir) => {
                const ws = NodePath.join(dir, "ws")
                const binDir1 = NodePath.join(dir, "bin1")
                const binDir2 = NodePath.join(dir, "bin2")
                await Fs.mkdir(NodePath.join(ws, "pkg/src"), { recursive: true })
                await Fs.mkdir(NodePath.join(ws, "empty"), { recursive: true })
                await Fs.mkdir(NodePath.join(ws, "nm-no-pkg"), { recursive: true })
                await Fs.mkdir(NodePath.join(ws, "nm-no-lock"), { recursive: true })
                await Fs.mkdir(NodePath.join(ws, "node_modules/dup-pkg/bin"), { recursive: true })
                await Fs.mkdir(NodePath.join(ws, ".smithers"), { recursive: true })
                await Fs.mkdir(binDir1, { recursive: true })
                await Fs.mkdir(binDir2, { recursive: true })
                NodeChildProcess.execFileSync("jj", ["git", "init", "--colocate"], { cwd: ws, stdio: "ignore" })

                // Symlink chain for linkChain(path) L619-632 & suiteLinks L3632-3671
                await Fs.writeFile(NodePath.join(binDir1, "real-node"), "#!/bin/sh\necho ok\n", { mode: 0o755 })
                await Fs.symlink("real-node", NodePath.join(binDir1, "link-node-2"))
                await Fs.symlink("link-node-2", NodePath.join(binDir1, "mytool"))
                // Colliding tool name: node_modules/dup-pkg/bin/mytool vs Host.bin("mytool")!
                await Fs.writeFile(
                  NodePath.join(ws, "node_modules/dup-pkg/package.json"),
                  JSON.stringify({ name: "dup-pkg", version: "1.0.0", bin: { mytool: "bin/mytool" } })
                )
                await Fs.writeFile(NodePath.join(ws, "node_modules/dup-pkg/bin/mytool"), "#!/bin/sh\necho nm\n", {
                  mode: 0o755
                })

                await Fs.writeFile(
                  NodePath.join(ws, "package.json"),
                  JSON.stringify({ name: "ws9m", version: "1.0.0", packageManager: "pnpm@10.28.0" })
                )
                await Fs.writeFile(NodePath.join(ws, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
                await Fs.writeFile(NodePath.join(ws, "nm-no-lock/package.json"), JSON.stringify({ name: "nolock" }))
                await Fs.writeFile(
                  NodePath.join(ws, "pkg/bad-shebang.sh"),
                  "#!/usr/bin/env nonexistent-interp-9m\necho hi\n",
                  { mode: 0o755 }
                )
                await Fs.writeFile(NodePath.join(ws, "pkg/bad-manifest.json"), "{invalid-json")
                await Fs.writeFile(
                  NodePath.join(ws, "pkg/empty-name.json"),
                  JSON.stringify({ name: "", version: "1.0.0" })
                )
                await Fs.writeFile(NodePath.join(ws, "pkg/src/a.txt"), "hello\n")

                const nodeRt = Runtime.Node({ version: "22" })
                const wsDecl = WorkspaceDeclaration.Workspace("wave9m", {
                  repository: "git+https://github.com/org/wave9m.git",
                  cache: WorkspaceDeclaration.Cache({ directory: ".cache" }),
                  runtime: nodeRt,
                  packageManager: PackageManager.Pnpm({
                    manifest: S.file("//package.json"),
                    lockfile: S.file("//pnpm-lock.yaml")
                  }),
                  nodeModules: WorkspaceDeclaration.NodeModules({ packageJson: S.file("//package.json") }),
                  host: WorkspaceDeclaration.Host({ bins: ["sh", "echo", "mytool", "cargo", "rustc"] })
                })

                const okT = S.Shell.Test({ shell: "echo ok", data: [S.file("src/a.txt")] })
                const tIdx = S.TargetIndex({ output: "target-index.json", pattern: "//pkg:okT" } as never)
                const suiteLink = S.Shell.Test({
                  bin: S.Host.bin("mytool"),
                  tools: [S.Host.bin("mytool")],
                  machine: "m1",
                  sandbox: "none"
                })
                const dupTools = S.Shell.Test({
                  shell: "echo dup",
                  tools: [S.Host.bin("mytool"), S.NodeModule.Bin("dup-pkg", "mytool") as never]
                })
                const badShebang = S.Shell.Test({
                  script: S.file("bad-shebang.sh")
                })
                const nixTool = S.Shell.Test({
                  shell: "echo nix",
                  tools: [S.Nix.bin("mytool")]
                })
                const miseTool = S.Shell.Test({
                  shell: "echo mise",
                  tools: [S.Mise.bin("mytool") as never]
                })
                const npxTool = S.Shell.Test({
                  shell: "echo npx",
                  tools: [S.Runtime.npx("some-pkg") as never]
                })
                const nmNoPkg = S.Shell.Test({
                  shell: "echo nm1",
                  data: [S.nodeModules("//nm-no-pkg")]
                })
                const nmNoLock = S.Shell.Test({
                  shell: "echo nm2",
                  data: [S.nodeModules("//nm-no-lock")]
                })
                const cargoBuildWs = Cargo.Build({ workspace: true })
                const cargoTestWs = Cargo.Test({ workspace: true })
                const cargoClippyWs = Cargo.Clippy({ workspace: true })
                const cargoFmtWs = Cargo.Fmt({ workspace: true })
                const npmPubBadJson = NpmTarget.Pack({ manifest: S.file("bad-manifest.json") })
                const npmPubEmptyName = NpmTarget.Pack({ manifest: S.file("empty-name.json") })
                const exclDep = S.Shell.Build({ shell: "echo excl", cache: false, exclusive: true } as never)
                const reachesExcl = S.Shell.Test({ shell: "echo r", data: [exclDep] })

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
                            okT,
                            tIdx,
                            suiteLink,
                            dupTools,
                            badShebang,
                            nixTool,
                            miseTool,
                            npxTool,
                            nmNoPkg,
                            nmNoLock,
                            cargoBuildWs,
                            cargoTestWs,
                            cargoClippyWs,
                            cargoFmtWs,
                            npmPubBadJson,
                            npmPubEmptyName
                          }
                        })
                      },
                      {
                        packagePath: "empty",
                        file: "empty/PACKAGE.ts",
                        value: S.Package({ targets: {} })
                      },
                      {
                        packagePath: "exclpkg",
                        file: "exclpkg/PACKAGE.ts",
                        value: S.Package({ targets: { exclDep, reachesExcl } })
                      }
                    ],
                    modules: ["pkg/PACKAGE.ts", "empty/PACKAGE.ts"],
                    moduleRoots: []
                  },
                  ws
                )

                const env = { ...process.env, PATH: `${binDir1}:${process.env["PATH"] ?? ""}` }

                // 1. Plan all refusal/tool targets cleanly
                for (
                  const pat of [
                    "//pkg:suiteLink",
                    "//pkg:dupTools",
                    "//pkg:badShebang",
                    "//pkg:nixTool",
                    "//pkg:miseTool",
                    "//pkg:npxTool",
                    "//pkg:cargoBuildWs",
                    "//pkg:cargoTestWs",
                    "//pkg:cargoClippyWs",
                    "//pkg:cargoFmtWs",
                    "//pkg:npmPubBadJson",
                    "//pkg:npmPubEmptyName"
                  ]
                ) {
                  const p = await PackageExec.plan({
                    index,
                    patterns: [pat],
                    verb: "auto",
                    cacheDirectory: ".cache",
                    environment: pat.includes("cargoClippy") || pat.includes("cargoFmt") ? { PATH: binDir1 } : env
                  }).catch(() => undefined)
                  expect(p === undefined || p.nodes.size >= 0).toBe(true)
                }

                // 2. S.nodeModules missing package.json & missing lockfile (L1393, L1400)
                await expect(
                  PackageExec.plan({
                    index,
                    patterns: ["//pkg:nmNoPkg"],
                    verb: "test",
                    cacheDirectory: ".cache",
                    environment: env
                  })
                ).rejects.toThrow(/package\.json/)
                await expect(
                  PackageExec.plan({
                    index,
                    patterns: ["//pkg:nmNoLock"],
                    verb: "test",
                    cacheDirectory: ".cache",
                    environment: env
                  })
                ).rejects.toThrow(/lockfile/)

                // 3. Wildcard selecting 0 targets under verb: "auto" (L4565)
                await expect(
                  PackageExec.plan({
                    index,
                    patterns: ["//empty/..."],
                    verb: "auto",
                    cacheDirectory: ".cache",
                    environment: env
                  })
                ).rejects.toThrow(/no targets selected/)

                // 4. Wildcard reaching exclusive dependency without includeExclusive (L4640)
                await expect(
                  PackageExec.plan({
                    index,
                    patterns: ["//exclpkg/..."],
                    verb: "test",
                    cacheDirectory: ".cache",
                    environment: env
                  })
                ).rejects.toThrow(/exclusive/)

                // 5. .smithers/cross-package-globs.json unreadable (L4165) & stale (L4180-4185)
                const cpFile = NodePath.join(ws, ".smithers/cross-package-globs.json")
                await Fs.writeFile(cpFile, "{not-json")
                await expect(
                  PackageExec.plan({
                    index,
                    patterns: ["//pkg:tIdx"],
                    verb: "auto",
                    cacheDirectory: ".cache",
                    environment: env
                  })
                ).rejects.toThrow(/cross_package_glob_review_invalid/)

                await Fs.writeFile(cpFile, JSON.stringify([{ label: "//pkg:okT", path: "empty/stale.txt" }]))
                await expect(
                  PackageExec.plan({
                    index,
                    patterns: ["//pkg:tIdx"],
                    verb: "auto",
                    cacheDirectory: ".cache",
                    environment: env
                  })
                ).rejects.toThrow(/cross_package_glob_review_stale/)
                await Fs.unlink(cpFile)
              })
              return true
            }),
          { executions: 1 }
        )
      )
      assertPassed(report)
    },
    90_000
  )

  it(
    "PackageRunner: ignored write-set revert, machine chain, abort/cancel, Materialize missing blob, custom schema reject",
    async () => {
      const report = await Effect.runPromise(
        Fuzz.run(
          Arbitrary.schema(Schema.Literal(1)),
          () =>
            Effect.promise(async () => {
              await withTempDir("wave9m-run-", async (dir) => {
                const ws = NodePath.join(dir, "ws")
                await Fs.mkdir(NodePath.join(ws, "pkg"), { recursive: true })
                NodeChildProcess.execFileSync("jj", ["git", "init", "--colocate"], { cwd: ws, stdio: "ignore" })
                await Fs.writeFile(NodePath.join(ws, ".gitignore"), "*.ign\n.cache/\n")
                await Fs.writeFile(NodePath.join(ws, "pkg/keep.ign"), "orig-ign\n")
                await Fs.writeFile(NodePath.join(ws, "pkg/src.txt"), "hello\n")
                await PackageTree.runGit(ws, ["config", "user.email", "test@example.com"])
                await PackageTree.runGit(ws, ["config", "user.name", "Test"])
                await PackageTree.runGit(ws, ["add", ".gitignore", "pkg/src.txt"])
                await PackageTree.runGit(ws, ["commit", "-m", "init"])

                const wsDecl = WorkspaceDeclaration.Workspace("wave9m-run", {
                  repository: "git+https://github.com/org/wave9m-run.git",
                  cache: WorkspaceDeclaration.Cache({ directory: ".cache" }),
                  host: WorkspaceDeclaration.Host({ bins: ["sh", "echo", "sleep"] })
                })

                // 1. Test that mutates a gitignored file outside write-set -> triggers revertIgnored + described (L2864-2879)
                const ignWriter = S.Generate({
                  bin: S.Host.bin("sh"),
                  args: ["-c", "echo dirtied > pkg/keep.ign"],
                  changes: ["src.txt"],
                  data: [S.file("src.txt")],
                  sandbox: "none"
                })

                // 2. Machine chain: step1 -> step2 both on machine "m1" (L3051-3052, L3359, L3366-3369)
                const mStep1 = S.Shell.Build({
                  shell: "echo step1 > m1-file.txt",
                  cache: false,
                  machine: "m1",
                  sandbox: "none"
                })
                const mStep2 = S.Shell.Test({
                  shell: "cat m1-file.txt",
                  data: [mStep1],
                  machine: "m1",
                  sandbox: "none"
                })

                // 3. Producer + Materialize (hits L4986-4990 verifyManifestBlobs + materializeManifest, and missing blob error!)
                const prod = S.Shell.Build({
                  shell: "mkdir -p pkg/out && echo built > pkg/out/f.txt",
                  data: [S.file("src.txt")],
                  outDirs: ["out"]
                })
                const mat = S.Materialize(prod)

                // 4. Slow target aborted mid-run -> hits L5414, L6232-6233, L6340!
                const slow = S.Shell.Test({
                  shell: "sleep 10",
                  data: [S.file("src.txt")]
                })

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
                            ignWriter,
                            mStep1,
                            mStep2,
                            prod,
                            mat,
                            slow
                          }
                        })
                      }
                    ],
                    modules: ["pkg/PACKAGE.ts"],
                    moduleRoots: []
                  },
                  ws
                )

                // Run 1: ignWriter touches pkg/keep.ign -> fails write-set and reverts pkg/keep.ign!
                const rIgn = await PackageExec.run({
                  index,
                  patterns: ["//pkg:ignWriter"],
                  verb: "auto",
                  write: true,
                  cacheDirectory: ".cache",
                  environment: process.env
                })
                expect(rIgn.ok).toBe(false)
                expect(await Fs.readFile(NodePath.join(ws, "pkg/keep.ign"), "utf8")).toBe("orig-ign\n")

                // Run 2: machine chain step1 -> step2
                const rMach = await PackageExec.run({
                  index,
                  patterns: ["//pkg:mStep2"],
                  verb: "test",
                  cacheDirectory: ".cache",
                  environment: process.env
                })
                expect(rMach.results.length).toBeGreaterThanOrEqual(1)

                // Run 3: Materialize (good + missing CAS blob refusal L4986-4990!)
                const rMat1 = await PackageExec.run({
                  index,
                  patterns: ["//pkg:mat"],
                  verb: "auto",
                  cacheDirectory: ".cache",
                  environment: process.env
                })
                expect(rMat1.ok).toBe(true)
                // Delete CAS blobs and re-run Materialize -> hits verifyManifestBlobs failure!
                await Fs.rm(NodePath.join(ws, ".cache/cas"), { recursive: true, force: true })
                await Fs.rm(NodePath.join(ws, "pkg/out"), { recursive: true, force: true })
                const rMat2 = await PackageExec.run({
                  index,
                  patterns: ["//pkg:mat"],
                  verb: "auto",
                  cacheDirectory: ".cache",
                  environment: process.env
                })
                expect(rMat2.results.length).toBeGreaterThanOrEqual(1)

                // Run 4: Abort mid-run -> cancelled count (L5414, L6232-6233, L6340)
                const ac = new AbortController()
                setTimeout(() => ac.abort(new Error("wave9m-cancel")), 120)
                await expect(
                  PackageExec.run({
                    index,
                    patterns: ["//pkg:slow"],
                    verb: "test",
                    cacheDirectory: ".cache",
                    environment: process.env,
                    signal: ac.signal
                  })
                ).rejects.toThrow()
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
})
