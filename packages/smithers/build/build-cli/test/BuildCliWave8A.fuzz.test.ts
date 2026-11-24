import { Fuzz } from "@smthrs/fuzz"
import * as Node from "@smthrs/plan/Node"
import { Smithers as S } from "@smthrs/targets"
import * as ExecSandbox from "@smthrs/targets/ExecSandbox"
import * as Target from "@smthrs/targets/Target"
import { Arbitrary, Effect, Schema } from "effect"
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import type * as AgentFake from "../src/AgentFake.ts"
import * as Cache from "../src/Cache.ts"
import * as CacheEvidence from "../src/internal/CacheEvidence.ts"
import * as Machine from "../src/internal/Machine.ts"
import * as ObservedReads from "../src/internal/ObservedReads.ts"
import * as PackagePlanner from "../src/internal/PackagePlanner.ts"
import * as PackageRunner from "../src/internal/PackageRunner.ts"
import * as SdkIdentity from "../src/internal/SdkIdentity.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as Planner from "../src/Planner.ts"
import * as ServiceSupervisor from "../src/ServiceSupervisor.ts"
import { writeExecutable } from "./helpers/Executable.ts"

const executions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? "100")
const heavyExecutions = Math.max(4, Math.min(executions, 6))
const fastExecutions = Math.max(12, Math.min(executions, 24))
const seed = Number(process.env["EFFECT_FUZZ_SEED"] ?? "20261124")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const withTempDir = async <A>(prefix: string, body: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix)))
  try {
    return await body(dir)
  } finally {
    await Machine.remove(dir).catch(() => Fs.rm(dir, { recursive: true, force: true }))
  }
}

const writeFile = async (root: string, rel: string, content: string, mode = 0o644): Promise<string> => {
  const full = NodePath.isAbsolute(rel) ? rel : NodePath.join(root, rel)
  await Fs.mkdir(NodePath.dirname(full), { recursive: true })
  await Fs.writeFile(full, content, { mode })
  if (mode !== 0o644) await Fs.chmod(full, mode)
  return full
}

const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "user.name=Fuzz", "-c", "user.email=fuzz@example.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim()

const slugArb = Schema.Literals(["a0", "b1", "c2", "d3"])

describe("@smthrs/build-cli Wave-8A: SdkIdentity, PackagePlanner & PackageRunner deep fuzz", () => {
  it(
    "SdkIdentity.identify & PackagePlanner deep planning branches (SDKs, symlinks, TargetBin, bunTemplate, GoRun/Npx, scripts, globs, Cargo.Fetch, Agent refusals)",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          slug: slugArb,
          hasManifest: Schema.Boolean,
          xcodeLayout: Schema.Boolean,
          exceedLimits: Schema.Boolean,
          validSdk: Schema.Boolean,
          scriptExists: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ slug, hasManifest, xcodeLayout, exceedLimits, validSdk, scriptExists }) =>
            Effect.promise(async () => {
              await withTempDir("smthrs-w8a-plan-", async (base) => {
                const root = NodePath.join(base, "ws")
                const binDir = NodePath.join(base, "bin")
                const sdkBase = NodePath.join(base, "sdks")
                await Fs.mkdir(root, { recursive: true })
                await Fs.mkdir(binDir, { recursive: true })
                await Fs.mkdir(sdkBase, { recursive: true })

                // 1. SdkIdentity.identify fuzz across manifests, Xcode Contents/Developer, smallTree, symlinks, limits & errors
                const sdkDir = xcodeLayout
                  ? NodePath.join(sdkBase, "Xcode.app/Contents/Developer")
                  : NodePath.join(sdkBase, `sdk-${slug}`)
                await Fs.mkdir(sdkDir, { recursive: true })
                if (hasManifest) {
                  if (xcodeLayout) {
                    await writeFile(sdkBase, "Xcode.app/Contents/version.plist", `<plist>${slug}</plist>\n`)
                  } else {
                    await writeFile(sdkDir, "SDKSettings.json", JSON.stringify({ Version: slug }))
                    await Fs.mkdir(NodePath.join(sdkDir, "version.plist"), { recursive: true })
                  }
                }
                await writeFile(sdkDir, "usr/include/a.h", `/* ${slug} */\n`)
                await writeFile(sdkDir, "usr/bin/helper", "#!/bin/sh\necho ok\n", 0o755)
                await Fs.symlink("a.h", NodePath.join(sdkDir, "usr/include/link-ok.h"))
                const limits = exceedLimits ? { entries: 1, bytes: 4 } : SdkIdentity.defaultLimits
                const id1 = SdkIdentity.identify(sdkDir, root, limits)
                if (exceedLimits) {
                  expect(id1).toBeNull()
                } else {
                  expect(id1).toMatch(/^[0-9a-f]{64}$/)
                }
                await Fs.symlink("does-not-exist", NodePath.join(sdkDir, "usr/include/link-broken.h"))
                expect(SdkIdentity.identify(sdkDir, root, limits)).toBeNull()
                expect(SdkIdentity.identify(base, root)).toBeNull()
                expect(SdkIdentity.identify(NodePath.join(base, "missing-sdk"), root)).toBeNull()

                if (!hasManifest) {
                  const byteLimited = SdkIdentity.identify(sdkDir, root, { entries: 100, bytes: 1 })
                  expect(byteLimited).toBeNull()
                }

                // 2. Symlink chain for PackagePlanner.linkChain + fake tools
                const realTool = await writeExecutable(NodePath.join(binDir, "real-tool"), "#!/bin/sh\necho real\n")
                const link1 = NodePath.join(binDir, "link1-tool")
                const link2 = NodePath.join(binDir, "mytool")
                await Fs.symlink(realTool, link1)
                await Fs.symlink(link1, link2)
                const bunBin = await writeExecutable(
                  NodePath.join(binDir, "bun"),
                  "#!/bin/sh\necho bun-ok\n"
                )
                await writeExecutable(
                  NodePath.join(binDir, "go"),
                  "#!/bin/sh\necho 'go version go1.23.0 linux/amd64'\n"
                )
                await writeExecutable(NodePath.join(binDir, "npx"), "#!/bin/sh\necho npx-ok\n")
                await writeExecutable(NodePath.join(binDir, "cargo"), "#!/bin/sh\necho 'cargo 1.82.0'\n")
                await writeExecutable(NodePath.join(binDir, "rustc"), "#!/bin/sh\necho 'rustc 1.82.0'\n")
                await writeExecutable(NodePath.join(binDir, "rustfmt"), "#!/bin/sh\necho 'rustfmt 1.8.0'\n")
                await writeExecutable(NodePath.join(binDir, "rustc"), "#!/bin/sh\necho 'rustc 1.82.0'\n")
                await writeExecutable(NodePath.join(binDir, "cargo-nextest"), "#!/bin/sh\necho nextest\n")
                await writeExecutable(NodePath.join(binDir, "sh"), "#!/bin/sh\nexec /bin/sh \"$@\"\n")
                await writeExecutable(NodePath.join(binDir, "docker"), "#!/bin/sh\necho docker 27.0\n")
                await writeExecutable(NodePath.join(binDir, "anvil"), "#!/bin/sh\necho anvil 0.2\n")
                await writeExecutable(NodePath.join(binDir, "jj-export"), "#!/bin/sh\necho jj-export\n")

                await writeFile(root, "package.json", JSON.stringify({ name: "w8a", version: "1.0.0" }))
                await writeFile(root, "yarn.lock", "")
                await writeFile(root, "Cargo.toml", "[workspace]\nmembers = [\"crates/a\"]\n")
                await writeFile(root, "Cargo.lock", "version = 3\n")
                await writeFile(root, "crates/a/Cargo.toml", "[package]\nname = \"a\"\nversion = \"0.1.0\"\n")
                await writeFile(root, "crates/a/src/main.rs", "fn main() {}\n")
                await writeFile(root, "go.mod", "module example.com/w8a\n\ngo 1.23\n")
                await writeFile(root, "src/data.txt", `data-${slug}\n`)
                await writeFile(root, "sub/inside.txt", `sub-${slug}\n`)
                await writeFile(root, "prompt.md", "Make a small change.\n")
                if (scriptExists) {
                  await writeFile(root, "scripts/gen.mjs", "console.log('gen')\n")
                }
                await Fs.mkdir(NodePath.join(root, "node_modules/vitest"), { recursive: true })
                await writeFile(
                  root,
                  "node_modules/vitest/package.json",
                  JSON.stringify({ name: "vitest", version: "5.0.0", bin: { vitest: "bin.js" } })
                )
                await writeExecutable(
                  NodePath.join(root, "node_modules/vitest/bin.js"),
                  "#!/bin/sh\necho 'bench 1.23 ms'\n"
                )
                await Fs.mkdir(NodePath.join(root, "node_modules/.bin"), { recursive: true })
                await Fs.symlink("../vitest/bin.js", NodePath.join(root, "node_modules/.bin/vitest"))

                const fgInner = S.Filegroup({ srcs: [S.file("//src/data.txt")] })
                const fgOuter = S.Filegroup({ srcs: [...S.glob(["src/**", "sub/**"]), fgInner] })
                const singleBinBuild = S.Shell.Build({
                  shell:
                    `mkdir -p dist && printf '#!/bin/sh\\necho built-${slug}\\n' > dist/tool.sh && chmod +x dist/tool.sh`,
                  data: [fgOuter, fgInner],
                  outFiles: ["dist/tool.sh"],
                  sandbox: "none"
                })
                const multiOutBuild = S.Shell.Build({
                  shell: "mkdir -p dist2 && touch dist2/a dist2/b",
                  outFiles: ["dist2/a", "dist2/b"],
                  sandbox: "none"
                })
                const cargoCrates = S.Cargo.AppSet({ manifests: S.glob(["crates/*/Cargo.toml"]) })
                const cargoOneBin = S.Cargo.Build({
                  workspace: true,
                  bins: ["a"],
                  outDirs: ["//target"],
                  sandbox: "none"
                })
                const cargoNoBin = S.Cargo.Build({
                  workspace: true,
                  outDirs: ["//target"],
                  sandbox: "none"
                })
                const cargoCrateSet = S.Cargo.Build({
                  crates: cargoCrates,
                  lib: true,
                  sandbox: "none"
                })
                const cargoFetch = S.Cargo.Fetch({
                  workspace: S.file("//Cargo.toml"),
                  outDirs: ["//.cargo-home"],
                  outFiles: ["//Cargo.lock"],
                  sandbox: { network: true }
                })
                const cargoNextest = S.Cargo.Nextest({
                  workspace: true,
                  data: [cargoFetch],
                  sandbox: "none"
                })

                const useSingleBin = S.Shell.Test({
                  bin: singleBinBuild,
                  args: ["--version"],
                  data: [singleBinBuild],
                  sandbox: "none"
                })
                const useMultiBin = S.Shell.Test({ bin: multiOutBuild, sandbox: "none" })
                const useCargoBin = S.Shell.Test({ bin: cargoOneBin, sandbox: "none" })
                const useCargoNoBin = S.Shell.Test({ bin: cargoNoBin, sandbox: "none" })
                const useCargoCrates = S.Shell.Test({ bin: cargoCrateSet, sandbox: "none" })
                const useFgBin = S.Shell.Test({ bin: fgInner, sandbox: "none" })

                const symToolTest = S.Shell.Test({
                  bin: S.Host.bin("mytool"),
                  data: S.glob(["nonexistent/{alpha,beta}/**", "missing-literal.txt"]),
                  sandbox: "none"
                })
                const bunTplTest = S.Shell.Test({
                  bun: "await $`echo bun-template`",
                  using: { tool: S.Host.bin("mytool") },
                  tools: [S.Host.bin("mytool")],
                  sandbox: "none"
                })
                const bunBadUsing = S.Shell.Test({
                  bun: "console.log(1)",
                  using: { bad: S.Runtime.npx("vitest") },
                  sandbox: "none"
                })
                const npxBinTest = S.Shell.Test({
                  bin: S.Runtime.npx("vitest"),
                  runtimeArgs: ["--yes"],
                  args: ["--version"],
                  sandbox: "none"
                })
                const npxBadTool = S.Shell.Test({
                  shell: "echo hi",
                  tools: [S.Runtime.npx("vitest")],
                  sandbox: "none"
                })
                const goRunTest = S.Shell.Test({
                  bin: S.Go.run("example.com/tool@v1.0.0"),
                  tools: [S.Host.bin("go")],
                  sandbox: "none"
                })
                const genScript = S.Generate({
                  script: S.file("//scripts/gen.mjs"),
                  changes: ["out/gen.txt"],
                  sandbox: "none"
                })
                const diffAutoArgs = S.Shell.Diff({
                  bin: S.Host.bin("mytool"),
                  args: ["--check"],
                  changes: ["src/**", "sub/inside.txt"],
                  sandbox: "none"
                })
                const vitestBench = S.VitestBench({
                  config: S.file("//package.json"),
                  benches: [S.file("//src/data.txt")],
                  sources: [S.file("//src/data.txt")],
                  deps: [],
                  tools: [S.Host.bin("mytool")],
                  sandbox: "none"
                })
                const agentNeedsInput = S.Agent.Diff({
                  prompt: S.file("//prompt.md"),
                  payload: { issue: S.Input.String("issue id") },
                  data: [],
                  changes: ["out/**"],
                  gates: [],
                  maxRounds: 1
                })
                const agentMissingSecret = S.Agent.Pr({
                  prompt: S.file("//prompt.md"),
                  data: [],
                  changes: ["out/**"],
                  gates: [],
                  maxRounds: 1
                })
                const brokenRepoTarget = S.Repo.Target("missingRepo", "//:test")

                const manifest = S.file("//package.json")
                const index = PackageIndex.make({
                  root,
                  workspace: S.Workspace("w8a", {
                    repository: "git+https://example.invalid/w8a.git",
                    cache: S.Cache({ directory: ".flows" }),
                    runtime: S.Runtime.Node({ version: ">=20.0.0" }),
                    packageManager: S.PackageManager.Yarn({ manifest, lockfile: S.file("//yarn.lock") }),
                    nodeModules: S.Npm.NodeModules({ packageJson: manifest }),
                    agents: S.Agents({ default: S.Agent.Codex({ model: "luna" }) }),
                    toolchains: [S.Rust.Toolchain({ workspace: S.file("//Cargo.toml"), channel: "1.82" })],
                    host: S.Host({
                      bins: ["mytool", "bun", "go", "npx", "cargo", "rustc", "rustfmt", "cargo-nextest", "sh"]
                    }),
                    sandboxes: S.Sandboxes({ default: S.Sandbox.None() })
                  }),
                  factory: undefined,
                  packages: [
                    {
                      file: "PACKAGE.ts",
                      packagePath: "",
                      value: S.Package({
                        targets: {
                          fgInner,
                          fgOuter,
                          singleBinBuild,
                          multiOutBuild,
                          cargoOneBin,
                          cargoNoBin,
                          cargoCrateSet,
                          cargoFetch,
                          cargoNextest,
                          useSingleBin,
                          useMultiBin,
                          useCargoBin,
                          useCargoNoBin,
                          useCargoCrates,
                          useFgBin,
                          symToolTest,
                          bunTplTest,
                          bunBadUsing,
                          npxBinTest,
                          npxBadTool,
                          goRunTest,
                          genScript,
                          diffAutoArgs,
                          vitestBench,
                          agentNeedsInput,
                          agentMissingSecret,
                          brokenRepoTarget
                        }
                      })
                    },
                    {
                      file: "sub/PACKAGE.ts",
                      packagePath: "sub",
                      value: S.Package({
                        targets: {
                          subFg: S.Filegroup({ srcs: [S.file("//sub/inside.txt")] })
                        }
                      })
                    }
                  ]
                })

                const env: Record<string, string> = {
                  ...process.env as Record<string, string>,
                  PATH: `${binDir}${NodePath.delimiter}${process.env["PATH"] ?? ""}`,
                  SDKROOT: validSdk ? sdkDir : NodePath.join(base, "no-such-sdk"),
                  DEVELOPER_DIR: validSdk ? sdkDir : base,
                  SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: NodePath.join(binDir, "jj-export")
                }

                const planned = await PackagePlanner.plan({
                  index,
                  patterns: ["//..."],
                  cacheDirectory: ".flows",
                  verb: "auto",
                  write: false,
                  environment: env,
                  log: () => {}
                })

                const useSingleNode = planned.nodes.get("//:useSingleBin")!
                expect(useSingleNode).toBeDefined()
                expect(PackageRunner.groupDeclarations(useSingleNode, planned.nodes).length).toBeGreaterThanOrEqual(1)
                expect(PackageRunner.dependencyOutputPaths(useSingleNode, planned.nodes)).toContain("dist/tool.sh")

                expect(planned.nodes.get("//:useMultiBin")?.refusal).toContain("outFiles")
                expect(planned.nodes.get("//:useCargoNoBin")?.refusal).toContain("declares 0 binaries")
                expect(planned.nodes.get("//:useCargoCrates")?.refusal).toContain("crate set")
                expect(planned.nodes.get("//:useFgBin")?.refusal).toContain("no executable output")
                expect(planned.nodes.get("//:bunBadUsing")?.refusal).toContain("Runtime.npx")
                expect(planned.nodes.get("//:npxBadTool")?.refusal).toContain("Runtime.npx")
                expect(planned.nodes.get("//:agentNeedsInput")?.refusal).toContain("needs input")
                expect(planned.nodes.get("//:brokenRepoTarget")?.refusal).toBeDefined()
                expect(planned.nodes.get("//:diffAutoArgs")?.argv).toContain("src")

                if (scriptExists) {
                  expect(planned.nodes.get("//:genScript")?.refusal).toBeUndefined()
                } else {
                  expect(planned.nodes.get("//:genScript")?.refusal).toContain("generator script not found")
                }

                const execPlan = await PackagePlanner.plan({
                  index,
                  patterns: ["//:useSingleBin", "//:bunTplTest", "//:vitestBench"],
                  cacheDirectory: ".flows",
                  verb: "auto",
                  write: false,
                  environment: {
                    ...process.env as Record<string, string>,
                    PATH: `${binDir}${NodePath.delimiter}${process.env["PATH"] ?? ""}`
                  },
                  log: () => {}
                })
                expect(execPlan.nodes.get("//:bunTplTest")?.bunTemplate?.bunPath).toBe(bunBin)
                const execRes = await Effect.runPromise(
                  PackageRunner.executeEffect(execPlan, {
                    index,
                    patterns: ["//:useSingleBin", "//:bunTplTest", "//:vitestBench"],
                    cacheDirectory: ".flows",
                    verb: "auto",
                    write: false,
                    jobs: 1,
                    environment: {
                      ...process.env as Record<string, string>,
                      PATH: `${binDir}${NodePath.delimiter}${process.env["PATH"] ?? ""}`
                    },
                    log: () => {}
                  }).pipe(Effect.provideService(PackageRunner.ExecutionServices, PackageRunner.executionServicesLive))
                )
                expect(execRes.results.find((r) => r.label === "//:useSingleBin")?.status).toBe("ran")
                expect(execRes.results.find((r) => r.label === "//:bunTplTest")?.status).toBe("ran")
              })
              return true
            }),
          { executions: heavyExecutions, seed }
        )
      )
      assertPassed(report)
    },
    150_000
  )

  it(
    "PackageRunner Agent.Diff/Pr gates & failures, enforceWriteSet revert, Materialize, Submodule, Clean, Docker/Anvil Services & LlmLint",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          slug: slugArb,
          revertIgnoredOk: Schema.Boolean,
          gateMode: Schema.Literals(["all_pass", "suite_red", "unsupported", "pr_refuse", "session_fail", "vacuous"]),
          materializeCase: Schema.Literals([
            "bad_binding",
            "bad_blob",
            "missing_outdir",
            "file_outdir",
            "missing_outfile"
          ]),
          submoduleCase: Schema.Literals(["file_not_dir", "dirty", "cached_verify"]),
          serviceCase: Schema.Literals(["docker", "anvil_plain", "anvil_nix", "service_error"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ slug, revertIgnoredOk, gateMode, materializeCase, submoduleCase, serviceCase }) =>
            Effect.promise(async () => {
              await withTempDir("smthrs-w8a-run-", async (base) => {
                const root = NodePath.join(base, "ws")
                const binDir = NodePath.join(base, "bin")
                const siblingRepo = NodePath.join(root, "repos/sibling")
                const subOrigin = NodePath.join(root, ".sub-origin")
                await Fs.mkdir(root, { recursive: true })
                await Fs.mkdir(binDir, { recursive: true })
                await Fs.mkdir(siblingRepo, { recursive: true })
                await Fs.mkdir(subOrigin, { recursive: true })

                await writeExecutable(NodePath.join(binDir, "cargo"), "#!/bin/sh\necho 'cargo 1.82.0'\n")
                await writeExecutable(NodePath.join(binDir, "rustfmt"), "#!/bin/sh\necho 'rustfmt 1.8.0'\n")
                await writeExecutable(NodePath.join(binDir, "sh"), "#!/bin/sh\nexec /bin/sh \"$@\"\n")

                git(subOrigin, "init", "-q")
                await writeFile(subOrigin, "lib.txt", `sub-${slug}\n`)
                git(subOrigin, "add", "-A")
                git(subOrigin, "commit", "-qm", "sub init")

                git(root, "init", "-q")
                await writeFile(root, ".gitignore", "ignored.tmp\n.flows/\n.sub-origin/\n")
                await writeFile(root, "package.json", JSON.stringify({ name: "w8a-run", version: "1.0.0" }))
                await writeFile(root, "yarn.lock", "")
                await writeFile(root, "Cargo.toml", "[workspace]\nmembers = []\n")
                await writeFile(root, "src/index.ts", `export const v = "${slug}"\n`)
                await writeFile(root, "src/tracked.txt", `orig-${slug}\n`)
                await writeFile(root, "ignored.tmp", `ign-orig-${slug}\n`)
                await writeFile(root, "prompt.md", `Edit out/a.txt for ${slug}\n`)
                await writeFile(root, "out/a.txt", `initial-${slug}\n`)
                await writeFile(root, "dist-file", "not-a-dir\n")

                await writeFile(siblingRepo, "package.json", JSON.stringify({ name: "sib", version: "1.0.0" }))
                await writeFile(siblingRepo, "yarn.lock", "")
                await writeFile(
                  siblingRepo,
                  "WORKSPACE.ts",
                  `import { Smithers as S } from "@smthrs/targets"\nconst m = S.file("//package.json")\nexport const Workspace = S.Workspace("sib", {\n  repository: "git+https://example.invalid/sib.git",\n  cache: S.Cache({ directory: ".flows" }),\n  runtime: S.Runtime.Node({ version: ">=20.0.0" }),\n  packageManager: S.PackageManager.Yarn({ manifest: m, lockfile: S.file("//yarn.lock") }),\n  nodeModules: S.Npm.NodeModules({ packageJson: m }),\n  sandboxes: S.Sandboxes({ default: S.Sandbox.None() })\n})\n`
                )
                await writeFile(
                  siblingRepo,
                  "PACKAGE.ts",
                  `import { Smithers as S } from "@smthrs/targets"\nexport const Package = S.Package({ targets: { ok: S.Shell.Test({ shell: "echo sib-ok", sandbox: "none" }) } })\n`
                )

                git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", subOrigin, "vendor/one")
                git(root, "add", "-A")
                git(root, "commit", "-qm", "init")
                git(root, "config", "protocol.file.allow", "always")

                const fakePath = NodePath.join(base, "fake.json")
                const fakeScript: AgentFake.FakeScript = {
                  responses: gateMode === "session_fail"
                    ? [{ fail: `boom-${slug}` }]
                    : [{ findings: [], edits: [{ path: "out/a.txt", contents: `edited-${slug}\n` }], note: "done" }]
                }
                await writeFile(base, fakePath, JSON.stringify(fakeScript))

                const fgGate = S.Filegroup({ srcs: [S.file("//src/index.ts")] })
                const closureGate = S.ImportClosure({ entries: [S.file("//src/index.ts")] })
                const shTestPass = S.Shell.Test({ shell: `grep -q edited-${slug} out/a.txt`, sandbox: "none" })
                const shTestFail = S.Shell.Test({ shell: "false", sandbox: "none" })
                const shBuildGate = S.Shell.Build({ shell: "true", cache: false, sandbox: "none" })
                const cargoFmtGate = S.Cargo.Fmt({
                  workspace: true,
                  data: [fgGate],
                  changes: ["**/*.rs"],
                  sandbox: "none"
                })
                const aliasGate = S.Alias(shTestPass)
                const suiteGate = S.Suite({
                  tests: gateMode === "suite_red"
                    ? [fgGate, shTestFail]
                    : [fgGate, closureGate, aliasGate, shBuildGate, cargoFmtGate]
                })
                const cleanGate = S.Clean({ paths: ["tmp-clean"] })
                const selectedGates = gateMode === "unsupported" ? [cleanGate] : [suiteGate]

                const agentDiff = S.Agent.Diff({
                  prompt: S.file("//prompt.md"),
                  data: gateMode === "vacuous" ? [S.gitDiff({ base: "HEAD" })] : [fgGate],
                  changes: ["out/**"],
                  gates: selectedGates,
                  maxRounds: 1
                })
                const agentPr = S.Agent.Pr({
                  prompt: S.file("//prompt.md"),
                  data: [fgGate],
                  changes: ["out/**"],
                  gates: [fgGate],
                  secrets: [S.HttpSecret(S.Secret("GH_TOKEN"), ["https://api.github.com"])],
                  maxRounds: 1
                })

                const failingWriteSet = S.Shell.Diff({
                  shell:
                    `printf 'mutated-tracked\\n' > src/tracked.txt && printf 'mutated-ign\\n' > ignored.tmp && exit 1`,
                  changes: ["src/tracked.txt"],
                  sandbox: "none"
                })

                const matProducer = S.Shell.Build({
                  shell: "echo skip-create",
                  outDirs: materializeCase === "file_outdir"
                    ? ["dist-file"]
                    : materializeCase === "missing_outfile"
                    ? []
                    : ["dist-out"],
                  outFiles: materializeCase === "missing_outfile" ? ["dist-missing.txt"] : [],
                  ...(materializeCase === "bad_binding" || materializeCase === "bad_blob"
                    ? {}
                    : { cache: false as const }),
                  sandbox: "none"
                })
                const matTarget = S.Materialize(matProducer)

                await Fs.symlink(base, NodePath.join(root, "escape-link"))
                const cleanEscape = S.Clean({ paths: ["escape-link/outside"] })

                const subTarget = S.Git.Submodule({ path: "//vendor/one" })

                const dockerSvc = S.Docker.Service({
                  image: "example/svc:1",
                  command: ["sh", "-c", "sleep 30"]
                })
                const anvilSvc = S.Anvil.Fork({
                  forkUrl: S.Secret("RPC_URL"),
                  forkBlockNumber: 42,
                  port: 8545
                })
                const svcConsumer = S.Shell.Test({
                  shell: "echo svc-consumer-ok",
                  services: [serviceCase === "docker" || serviceCase === "service_error" ? dockerSvc : anvilSvc],
                  sandbox: "none"
                })

                const repoTarget = S.Repo.Target("sib", "//:ok", { sandbox: "none" })

                const LlmSkipRule = Target.make("Custom.LlmSkip", {
                  attrs: Schema.Struct({}),
                  kinds: ["lint"],
                  success: Schema.Void,
                  implementation: () => Node.fail({ _tag: "smithers-build/ModelCliMissing", executable: "codex" })
                })
                const llmSkipTarget = LlmSkipRule({})

                const manifest = S.file("//package.json")
                const index = PackageIndex.make({
                  root,
                  workspace: S.Workspace("w8a-run", {
                    repository: "git+https://example.invalid/w8a-run.git",
                    cache: S.Cache({ directory: ".flows" }),
                    runtime: S.Runtime.Node({ version: ">=20.0.0" }),
                    packageManager: S.PackageManager.Yarn({ manifest, lockfile: S.file("//yarn.lock") }),
                    nodeModules: S.Npm.NodeModules({ packageJson: manifest }),
                    agents: S.Agents({ default: S.Agent.Codex({ model: "luna" }) }),
                    repos: { sib: S.LocalRepository("repos/sibling") },
                    toolchains: [S.Rust.Toolchain({ workspace: S.file("//Cargo.toml"), channel: "1.82" })],
                    host: S.Host({ bins: ["cargo", "rustc", "rustfmt", "sh", "grep", "git"] }),
                    sandboxes: S.Sandboxes({ default: S.Sandbox.None() })
                  }),
                  factory: undefined,
                  packages: [{
                    file: "PACKAGE.ts",
                    packagePath: "",
                    value: S.Package({
                      targets: {
                        fgGate,
                        closureGate,
                        shTestPass,
                        shTestFail,
                        shBuildGate,
                        cargoFmtGate,
                        aliasGate,
                        suiteGate,
                        cleanGate,
                        agentDiff,
                        agentPr,
                        failingWriteSet,
                        matProducer,
                        matTarget,
                        cleanEscape,
                        subTarget,
                        dockerSvc,
                        anvilSvc,
                        svcConsumer,
                        repoTarget,
                        llmSkipTarget
                      }
                    })
                  }]
                })

                const env: Record<string, string> = {
                  ...process.env as Record<string, string>,
                  PATH: `${binDir}${NodePath.delimiter}${process.env["PATH"] ?? ""}`,
                  SMTHRS_AGENT_FAKE: fakePath,
                  SMITHERS_SUBMODULE_SOURCES: base,
                  GH_TOKEN: "ghp_dummy_token",
                  RPC_URL: "http://127.0.0.1:1"
                }

                const customServices: PackageRunner.ExecutionServices = {
                  ...PackageRunner.executionServicesLive,
                  revertIgnored: (stash, path, quarantine) =>
                    revertIgnoredOk
                      ? PackageRunner.executionServicesLive.revertIgnored(stash, path, quarantine)
                      : Effect.succeed(false),
                  dockerService: async (req) => {
                    if (serviceCase === "service_error") {
                      throw new ServiceSupervisor.ServiceError({
                        key: req.label,
                        reason: "exited",
                        message: "docker stub exited early",
                        outputTail: "fatal: boom"
                      })
                    }
                    return {
                      key: req.label,
                      argv: ["/bin/sh", "-c", "sleep 30"],
                      cwd: req.cwd
                    }
                  },
                  anvilService: async (req) => ({
                    key: req.label,
                    argv: ["/bin/sh", "-c", "sleep 30"],
                    cwd: req.cwd
                  })
                }

                const run = async (
                  patterns: ReadonlyArray<string>,
                  write = false,
                  patchPlan?: (p: PackageExec.PackagePlan) => Promise<void>
                ) => {
                  const opts = {
                    index,
                    patterns,
                    cacheDirectory: ".flows",
                    verb: "auto" as const,
                    write,
                    keepGoing: true,
                    jobs: 1,
                    environment: env,
                    log: () => {}
                  }
                  const planned = await PackageExec.plan(opts)
                  if (patchPlan !== undefined) await patchPlan(planned)
                  return Effect.runPromise(
                    PackageRunner.executeEffect(planned, opts).pipe(
                      Effect.provideService(PackageRunner.ExecutionServices, customServices)
                    )
                  )
                }

                const agentPattern = gateMode === "pr_refuse" ? "//:agentPr" : "//:agentDiff"
                const agentRes = await run([agentPattern], true)
                const agOutcome = agentRes.results.find((r) => r.label === agentPattern)
                expect(agOutcome).toBeDefined()
                if (gateMode === "all_pass" || gateMode === "vacuous") {
                  if (!["ran", "hit"].includes(agOutcome!.status)) {
                    throw new Error("agOutcome=" + JSON.stringify(agOutcome))
                  }
                } else {
                  expect(agOutcome!.status).toBe("failed")
                }

                const wsRes = await run(["//:failingWriteSet"], true)
                const wsOut = wsRes.results.find((r) => r.label === "//:failingWriteSet")
                expect(wsOut?.status).toBe("failed")
                if (!revertIgnoredOk) {
                  expect(wsOut?.error).toContain("gitignored paths not restored")
                }
                expect(await Fs.readFile(NodePath.join(root, "src/tracked.txt"), "utf8")).toBe(`orig-${slug}\n`)

                const cleanRes = await run(["//:cleanEscape"])
                expect(cleanRes.results.find((r) => r.label === "//:cleanEscape")?.status).toBe("failed")

                const matRes = await run(["//:matTarget"], false, async (planned) => {
                  const prod = planned.nodes.get("//:matProducer")!
                  const store = await Cache.openCache({ workspaceRoot: root, cacheDirectory: ".flows" })
                  try {
                    const fakeOutput = materializeCase === "bad_binding"
                      ? {
                        kind: "build-artifacts",
                        manifests: [{ outDir: "undeclared-dir", entries: [] }],
                        files: []
                      }
                      : materializeCase === "bad_blob"
                      ? {
                        kind: "build-artifacts",
                        manifests: [{
                          outDir: "dist-out",
                          entries: [{ path: "x.txt", kind: "file", digest: "0".repeat(64), mode: 0o644, size: 3 }]
                        }],
                        files: []
                      }
                      : { kind: "uncaptured" }
                    await store.put(prod.keyPreview, {
                      key: prod.keyPreview,
                      target: prod.rule,
                      label: prod.label,
                      exitOk: true,
                      output: fakeOutput,
                      storedAt: new Date().toISOString()
                    })
                  } finally {
                    await store.close()
                  }
                })
                expect(["failed", "skipped"]).toContain(matRes.results.find((r) => r.label === "//:matTarget")?.status)

                if (submoduleCase === "file_not_dir") {
                  await Fs.rm(NodePath.join(root, "vendor/one"), { recursive: true, force: true })
                  await writeFile(root, "vendor/one", "i am a file\n")
                } else if (submoduleCase === "dirty") {
                  await writeFile(root, "vendor/one/dirty.txt", "dirty\n")
                }
                const subRes = await run(["//:subTarget"])
                const subOut = subRes.results.find((r) => r.label === "//:subTarget")
                expect(subOut).toBeDefined()
                if (submoduleCase === "cached_verify") {
                  if (!["ran", "hit"].includes(subOut!.status)) {
                    throw new Error("subTarget failed: " + JSON.stringify(subOut))
                  }
                  await Fs.rm(NodePath.join(root, "vendor/one/lib.txt"), { force: true })
                  const subRes2 = await run(["//:subTarget"])
                  expect(subRes2.results.find((r) => r.label === "//:subTarget")).toBeDefined()
                } else {
                  expect(subOut!.status).toBe("failed")
                }

                const svcRes = await run(["//:svcConsumer"], false, async (planned) => {
                  const patchNode = (label: string, extra: Record<string, unknown> = {}) => {
                    const node = planned.nodes.get(label)
                    if (node === undefined) return
                    const updated = { ...node, refusal: undefined, ...extra } as PackageExec.PackageNode
                    ;(planned.nodes as Map<string, PackageExec.PackageNode>).set(label, updated)
                    const wl = planned.workList as Array<PackageExec.PackageNode>
                    const idx = wl.findIndex((n) => n.label === label)
                    if (idx !== -1) wl[idx] = updated
                  }
                  patchNode("//:dockerSvc")
                  patchNode(
                    "//:anvilSvc",
                    serviceCase === "anvil_nix"
                      ? { nixEnvironment: { path: [binDir], variables: { NIX_TEST: "1" } } }
                      : {}
                  )
                  patchNode("//:svcConsumer", { argv: ["/bin/sh", "-c", "echo svc-consumer-ok"] })
                })
                const svcOut = svcRes.results.find((r) => r.label === "//:svcConsumer")
                if (svcOut?.status !== (serviceCase === "service_error" ? "failed" : "ran")) {
                  throw new Error("svcOut=" + JSON.stringify(svcOut))
                }

                const llmRes = await run(["//:llmSkipTarget"])
                expect(llmRes.results.find((r) => r.label === "//:llmSkipTarget")?.status).toBe("skipped")

                if (serviceCase === "docker") {
                  const repoRes1 = await run(["//:repoTarget"])
                  expect(repoRes1.results.find((r) => r.label === "//:repoTarget")).toBeDefined()
                }
              })
              return true
            }),
          { executions: heavyExecutions, seed }
        )
      )
      assertPassed(report)
    },
    180_000
  )

  it(
    "PackageRunner observed-reads negative caches, withRights, signalStorm/ringAsked, unprovable sandbox & movedInput",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          slug: slugArb,
          scenario: Schema.Literals([
            "rights_no_new_privs",
            "rights_unjailed_ok",
            "attempt_failed_awaited",
            "attempt_failed_solo",
            "reached_outside",
            "signal_storm",
            "ring_asked",
            "unprovable_sandbox",
            "moved_input"
          ])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ slug, scenario }) =>
            Effect.promise(async () => {
              await withTempDir("smthrs-w8a-obs-", async (base) => {
                const root = NodePath.join(base, "ws")
                const binDir = NodePath.join(base, "bin")
                await Fs.mkdir(root, { recursive: true })
                await Fs.mkdir(binDir, { recursive: true })
                await writeFile(root, "package.json", JSON.stringify({ name: "w8a-obs", version: "1.0.0" }))
                await writeFile(root, "yarn.lock", "")
                await writeFile(root, "input.txt", `v1-${slug}\n`)

                const traceBody = scenario === "rights_no_new_privs" || scenario === "rights_unjailed_ok"
                  ? `echo '100 execve("/usr/bin/sudo", ["sudo"], 0x0) = -1 EPERM (Operation not permitted)' > "$OUT"\necho '# smthrs-observe: rights /usr/bin/sudo' >> "$OUT"\nexit 1`
                  : scenario === "signal_storm"
                  ? `echo '# smthrs-observe: refusal ${ObservedReads.signalStorm}' > "$OUT"\nexit 1`
                  : scenario === "ring_asked"
                  ? `echo '100 io_uring_setup(8, 0x0) = -1 ENOSYS (Function not implemented)' > "$OUT"\nexit 1`
                  : `echo '100 openat(AT_FDCWD, "${NodePath.join(root, "input.txt")}", O_RDONLY) = 3' > "$OUT"\nexit 0`

                const fakeTracer = await writeExecutable(
                  NodePath.join(binDir, "fake-strace"),
                  `#!/bin/sh
OUT=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) OUT="$2"; shift 2 ;;
    --) shift; break ;;
    *) shift ;;
  esac
done
${traceBody}
`
                )

                const step1 = S.Shell.Test({
                  shell: `cat input.txt > /dev/null && echo ok-${slug}`,
                  data: [S.file("//input.txt")],
                  sandbox: scenario === "unprovable_sandbox" ? undefined : "none",
                  ...(scenario !== "unprovable_sandbox" && scenario !== "moved_input" ? { observe: { env: [] } } : {})
                })
                const step2 = S.Shell.Test({
                  shell: `echo after-${slug}`,
                  data: [step1],
                  sandbox: "none"
                })

                const manifest = S.file("//package.json")
                const index = PackageIndex.make({
                  root,
                  workspace: S.Workspace("w8a-obs", {
                    repository: "git+https://example.invalid/w8a-obs.git",
                    cache: S.Cache({ directory: ".flows" }),
                    runtime: S.Runtime.Node({ version: ">=20.0.0" }),
                    packageManager: S.PackageManager.Yarn({ manifest, lockfile: S.file("//yarn.lock") }),
                    nodeModules: S.Npm.NodeModules({ packageJson: manifest }),
                    host: S.Host({ bins: ["sh", "cat"] }),
                    sandboxes: S.Sandboxes({ default: S.Sandbox.None() })
                  }),
                  factory: undefined,
                  packages: [{
                    file: "PACKAGE.ts",
                    packagePath: "",
                    value: S.Package({ targets: { step1, step2 } })
                  }]
                })

                const env: Record<string, string> = {
                  ...process.env as Record<string, string>,
                  PATH: `${binDir}${NodePath.delimiter}${process.env["PATH"] ?? ""}`
                }

                const patterns = scenario === "attempt_failed_awaited" ? ["//:step2"] : ["//:step1"]
                const opts = {
                  index,
                  patterns,
                  cacheDirectory: ".flows",
                  verb: "auto" as const,
                  write: false,
                  keepGoing: true,
                  jobs: 1,
                  environment: env,
                  log: () => {}
                }
                const planned = await PackageExec.plan(opts)

                const node1 = planned.nodes.get("//:step1")!
                const obsKey = node1.observed?.key ?? node1.keyPreview

                const buildId = await Planner.implementationFingerprint()
                const writer: CacheEvidence.Writer = { build: buildId, recorder: "strace" }

                if (scenario === "attempt_failed_awaited" || scenario === "attempt_failed_solo") {
                  await CacheEvidence.rememberFailedAttempt(root, ".flows", obsKey, writer, {
                    label: "//:step1",
                    denied: [],
                    output: ["earlier recorded run failed"]
                  })
                } else if (scenario === "reached_outside") {
                  await CacheEvidence.rememberReachedOutside(root, ".flows", obsKey, {
                    label: "//:step1",
                    reason: "contacted 1.1.1.1:443"
                  })
                } else if (scenario === "rights_no_new_privs") {
                  await CacheEvidence.rememberRights(root, ".flows", obsKey, writer, {
                    label: "//:step1",
                    programs: ["/usr/bin/sudo"]
                  })
                } else if (scenario === "moved_input") {
                  await writeFile(root, "input.txt", `v2-changed-${slug}\n`)
                }

                const services: PackageRunner.ExecutionServices = {
                  ...PackageRunner.executionServicesLive,
                  noNewPrivileges: () => scenario === "rights_no_new_privs",
                  sandboxHost: () =>
                    scenario === "unprovable_sandbox"
                      ? {
                        platform: "linux",
                        bwrap: undefined,
                        docker: undefined,
                        sandboxExec: undefined,
                        unshare: undefined
                      } as unknown as ExecSandbox.Host
                      : PackageRunner.executionServicesLive.sandboxHost(),
                  observer: () => ({ program: fakeTracer, supervisor: false }) as unknown as ObservedReads.Observer
                }

                const res = await Effect.runPromise(
                  PackageRunner.executeEffect(planned, opts).pipe(
                    Effect.provideService(PackageRunner.ExecutionServices, services)
                  )
                )
                const out1 = res.results.find((r) => r.label === "//:step1")
                expect(out1).toBeDefined()
                if (scenario === "rights_no_new_privs") {
                  expect(out1!.status).toBe("failed")
                  expect(out1!.error).toContain("no new privileges")
                } else {
                  expect(["ran", "hit", "failed"]).toContain(out1!.status)
                }
              })
              return true
            }),
          { executions: fastExecutions, seed }
        )
      )
      assertPassed(report)
    },
    150_000
  )
})
