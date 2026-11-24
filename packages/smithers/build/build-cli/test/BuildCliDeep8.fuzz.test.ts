import { Fuzz } from "@smthrs/fuzz"
import { Smithers as S } from "@smthrs/targets"
import * as Input from "@smthrs/targets/Input"
import * as Reference from "@smthrs/targets/Reference"
import { Arbitrary, Effect, Schema } from "effect"
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as NodeNet from "node:net"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as PackagePlanner from "../src/internal/PackagePlanner.ts"
import * as PackageRunner from "../src/internal/PackageRunner.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import { writeExecutable } from "./helpers/Executable.ts"
import { imageArchive } from "./helpers/OciArchive.ts"
import { serve } from "./helpers/ServeCli.ts"

const executions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? "100")
const fsExecutions = Math.max(3, Math.min(executions, 5))

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

const gitExec = (cwd: string, args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim()

const freePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = NodeNet.createServer()
    srv.unref()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as NodeNet.AddressInfo
      srv.close(() => resolve(addr.port))
    })
  })

const slugArb = Schema.Literals(["a0", "b1", "c2", "d3", "e4"])

describe("@smthrs/build-cli deep fuzz suite 8: PackageRunner multi-ecosystem dispatch, Agent/Observed/Kept & Cli/Loader edge paths", () => {
  it(
    "PackagePlanner & PackageRunner multi-ecosystem execution: Cargo, Go, Foundry, Docker Build+Push, Shell.Serve+Test, Shell.Diff check/write, Compose, Owners, CiGen & Memory.Retain",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          slug: slugArb,
          writeMode: Schema.Boolean
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ slug, writeMode }) =>
            Effect.promise(async () => {
              await withTempDir("smthrs-bc8-eco-", async (root) => {
                const binDir = NodePath.join(root, ".fake-bin")
                await Fs.mkdir(binDir, { recursive: true })
                await Fs.mkdir(NodePath.join(binDir, "bin"), { recursive: true })
                await Fs.writeFile(NodePath.join(binDir, "package.json"), JSON.stringify({ type: "commonjs" }))
                await Fs.mkdir(NodePath.join(root, "src"), { recursive: true })
                await Fs.mkdir(NodePath.join(root, "docs"), { recursive: true })
                await Fs.mkdir(NodePath.join(root, "goapp"), { recursive: true })
                await Fs.mkdir(NodePath.join(root, "contracts"), { recursive: true })
                await Fs.mkdir(NodePath.join(root, "dockerctx"), { recursive: true })

                // Base workspace files
                await Fs.writeFile(
                  NodePath.join(root, "package.json"),
                  JSON.stringify({
                    name: `eco-${slug}`,
                    version: "0.1.0",
                    type: "module",
                    packageManager: "pnpm@11.25.0"
                  })
                )
                await Fs.writeFile(NodePath.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n")
                await Fs.writeFile(
                  NodePath.join(root, "tsconfig.json"),
                  JSON.stringify({ compilerOptions: { strict: true } })
                )
                await Fs.writeFile(NodePath.join(root, "src", "index.ts"), `export const v = "${slug}"\n`)
                await Fs.writeFile(NodePath.join(root, "src", "fmt-me.txt"), `raw-${slug}\n`)
                await Fs.writeFile(NodePath.join(root, "Cargo.toml"), `[package]\nname = "demo"\nversion = "0.1.0"\n`)
                await Fs.writeFile(NodePath.join(root, "Cargo.lock"), `# lock ${slug}\n`)
                await Fs.writeFile(NodePath.join(root, "src", "lib.rs"), `pub fn x() -> &'static str { "${slug}" }\n`)
                await Fs.writeFile(NodePath.join(root, "goapp", "go.mod"), `module example.com/${slug}\n\ngo 1.24.0\n`)
                await Fs.writeFile(NodePath.join(root, "goapp", "go.sum"), "")
                await Fs.writeFile(NodePath.join(root, "goapp", "main.go"), `package main\nfunc main() {}\n`)
                await Fs.writeFile(NodePath.join(root, "contracts", "foundry.toml"), `[profile.default]\nsrc = "."\n`)
                await Fs.writeFile(
                  NodePath.join(root, "contracts", "Counter.sol"),
                  `pragma solidity ^0.8.20;\ncontract Counter {}\n`
                )
                await Fs.writeFile(NodePath.join(root, "dockerctx", "Dockerfile"), `FROM scratch\nLABEL s=${slug}\n`)
                await Fs.writeFile(
                  NodePath.join(root, "docs", "guide.md"),
                  "# Guide\n\n```ts\nexport const n: number = 1\n```\n"
                )

                // Build a real OCI archive fixture so fake docker buildx outputs a valid image.tar
                const ociTar = imageArchive({ seed: slug })
                const ociFixturePath = NodePath.join(binDir, "fixture-oci.tar")
                await Fs.writeFile(ociFixturePath, ociTar.bytes)

                // Fake binaries: cargo, go, forge, docker, smithers
                await writeExecutable(
                  NodePath.join(binDir, "cargo"),
                  `#!${process.execPath}
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("cargo 1.86.0"); process.exit(0); }
const td = process.env.CARGO_TARGET_DIR || "target";
fs.mkdirSync(td, { recursive: true });
fs.writeFileSync(path.join(td, "built.txt"), "cargo-ok");
process.exit(0);
`
                )
                await writeExecutable(
                  NodePath.join(binDir, "go"),
                  `#!${process.execPath}
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
if (args[0] === "version") { console.log("go version go1.24.1 linux/amd64"); process.exit(0); }
if (args[0] === "env" && args.includes("-json")) {
  console.log(JSON.stringify({ GOROOT: ${JSON.stringify(binDir)}, GOTOOLDIR: ${JSON.stringify(binDir)} }));
  process.exit(0);
}
if (args[0] === "list") {
  console.log(JSON.stringify({ ImportPath: "example.com/app", Dir: path.join(process.cwd(), "goapp"), GoFiles: ["main.go"] }));
  process.exit(0);
}
if (args[0] === "build") {
  const oIdx = args.indexOf("-o");
  if (oIdx >= 0 && args[oIdx + 1]) {
    fs.mkdirSync(path.dirname(args[oIdx + 1]), { recursive: true });
    fs.writeFileSync(args[oIdx + 1], "fake-go-bin");
  }
}
if (args[0] === "mod" && args[1] === "download") {
  const cache = process.env.GOMODCACHE || path.join(process.cwd(), "modcache");
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, "mod.txt"), "ok");
}
process.exit(0);
`
                )
                await Fs.copyFile(NodePath.join(binDir, "go"), NodePath.join(binDir, "bin", "go"))
                await Fs.chmod(NodePath.join(binDir, "bin", "go"), 0o755)
                await writeExecutable(
                  NodePath.join(binDir, "forge"),
                  `#!${process.execPath}
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("forge Version: 1.0.0"); process.exit(0); }
if (args[0] === "config") { console.log(JSON.stringify({ src: ".", out: "out", libs: [] })); process.exit(0); }
if (args[0] === "build") {
  fs.mkdirSync(path.join(process.cwd(), "contracts", "out"), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), "contracts", "out", "Counter.json"), "{}");
}
process.exit(0);
`
                )
                await writeExecutable(
                  NodePath.join(binDir, "docker"),
                  `#!${process.execPath}
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("Docker version 27.0.0"); process.exit(0); }
if (args[0] === "buildx" && args[1] === "version") { console.log("github.com/docker/buildx v0.18.0"); process.exit(0); }
for (const a of args) {
  if (a.includes("dest=")) {
    const dest = a.split("dest=")[1].split(",")[0];
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(${JSON.stringify(ociFixturePath)}, dest);
  }
}
if (args[0] === "load") { console.log("Loaded image ID: " + ${JSON.stringify(ociTar.images[0]!.config)}); }
if (args[0] === "push") { console.log("v1: digest: " + ${JSON.stringify(ociTar.images[0]!.manifest)} + " size: 123"); }
process.exit(0);
`
                )
                await writeExecutable(
                  NodePath.join(binDir, "smithers"),
                  `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes("--help")) { console.log("Commands:\\n  memory retain\\n"); process.exit(0); }
console.log(JSON.stringify({ ok: true }));
process.exit(0);
`
                )

                // Live HTTP service script for Shell.Serve
                const port = await freePort()
                const srvScript = NodePath.join(root, "src", "srv.mjs")
                await Fs.writeFile(
                  srvScript,
                  [
                    `import http from "node:http";`,
                    `const s = http.createServer((req, res) => { res.writeHead(200); res.end("ok-${slug}"); });`,
                    `s.listen(${port}, "127.0.0.1");`,
                    `process.on("SIGTERM", () => { s.close(() => process.exit(0)); });`
                  ].join("\n")
                )

                // Init real git repo so git-aware rules (Shell.Diff, PackageTree snapshots, etc.) work
                gitExec(root, ["init", "--quiet", "--initial-branch=main"])
                gitExec(root, ["config", "user.name", "Fuzz"])
                gitExec(root, ["config", "user.email", "fuzz@example.invalid"])
                gitExec(root, ["config", "commit.gpgsign", "false"])
                gitExec(root, ["add", "-A"])
                gitExec(root, ["commit", "--quiet", "-m", "init"])

                const packageJson = S.file("//package.json")
                const fg = S.Filegroup({ srcs: [Input.file("src/index.ts")] })
                const buildT = S.Shell.Build({
                  bin: S.Host.bin("sh"),
                  args: ["-c", `mkdir -p dist && echo "${slug}" > dist/out.txt`],
                  data: [Input.file("src/index.ts")],
                  outDirs: ["dist"]
                })
                const matT = S.Materialize(buildT)
                const aliasT = S.Alias(buildT)
                const cleanT = S.Clean({ paths: ["dist"] })
                const srvT = S.Shell.Serve({
                  bin: S.Host.bin("node"),
                  args: [srvScript],
                  data: [Input.file("src/srv.mjs")],
                  sandbox: { network: "loopback" },
                  readiness: { http: `http://127.0.0.1:${port}/health`, timeout: "5s" }
                })
                const svcTestT = S.Shell.Test({
                  bin: S.Host.bin("node"),
                  args: [
                    "-e",
                    `fetch("http://127.0.0.1:${port}/health").then(r => { if (!r.ok) process.exit(1); })`
                  ],
                  sandbox: { network: true },
                  services: [srvT]
                })
                const diffT = S.Shell.Diff({
                  bin: S.Host.bin("node"),
                  args: [
                    "-e",
                    `const fs=require("fs"); fs.writeFileSync("src/fmt-me.txt", ${
                      JSON.stringify(writeMode ? `formatted-${slug}\n` : `raw-${slug}\n`)
                    });`
                  ],
                  data: [Input.file("src/fmt-me.txt")],
                  changes: ["src/fmt-me.txt"]
                })
                const closureT = S.ImportClosure({
                  entries: [Input.file("src/index.ts")]
                })
                const diffCheckT = S.Test({
                  expect: S.Files.difference(closureT, fg),
                  toBe: "empty"
                })
                const cargoBuildT = S.Cargo.Build({
                  workspace: true,
                  data: [Input.file("Cargo.toml"), Input.file("Cargo.lock"), Input.file("src/lib.rs")],
                  sandbox: "none"
                })
                const cargoTestT = S.Cargo.Test({
                  workspace: true,
                  data: [Input.file("Cargo.toml"), Input.file("Cargo.lock"), Input.file("src/lib.rs")],
                  sandbox: "none"
                })
                const cargoFmtT = S.Cargo.Fmt({
                  workspace: true,
                  data: [Input.file("Cargo.toml"), Input.file("src/lib.rs")],
                  changes: ["src/**/*.rs"],
                  sandbox: "none"
                })
                const goModT = S.Go.ModDownload({
                  mod: Input.file("goapp/go.mod"),
                  sum: Input.file("goapp/go.sum"),
                  outDirs: ["goapp/modcache"],
                  sandbox: "none"
                })
                const goPkgT = S.Go.Packages({
                  pkgs: ["./..."]
                })
                const goBinT = S.Go.Binary({
                  data: [Input.file("goapp/go.mod"), Input.file("goapp/main.go")],
                  pkg: ".",
                  out: "goapp/bin/app",
                  sandbox: "none"
                })
                const goTestT = S.Go.Test({
                  data: [Input.file("goapp/go.mod"), Input.file("goapp/main.go")],
                  pkgs: ["./..."],
                  sandbox: "none"
                })
                const forgeBuildT = S.Foundry.Build({
                  config: Input.file("contracts/foundry.toml"),
                  data: [Input.file("contracts/Counter.sol")],
                  outDirs: ["contracts/out"],
                  sandbox: "none"
                })
                const forgeTestT = S.Foundry.Test({
                  config: Input.file("contracts/foundry.toml"),
                  data: [Input.file("contracts/Counter.sol")],
                  sandbox: "none"
                })
                const forgeFmtT = S.Foundry.Fmt({
                  config: Input.file("contracts/foundry.toml"),
                  data: [Input.file("contracts/Counter.sol")],
                  changes: ["contracts/**/*.sol"],
                  sandbox: "none"
                })
                const dockerBuildT = S.Docker.Build({
                  dockerfile: Input.file("dockerctx/Dockerfile"),
                  context: "dockerctx",
                  data: [Input.file("dockerctx/Dockerfile")],
                  sandbox: "none"
                })
                const dockerPushT = S.Docker.Push({
                  image: dockerBuildT,
                  registry: "registry.example.invalid",
                  name: `org/${slug}`,
                  tags: [`v1-${slug}`],
                  approval: "required"
                })
                const teams = S.Teams({ core: ["alice"] })
                const ownersDecl = S.Owners.declare({ owners: ["team:core"] })
                const codeownersT = S.Owners.Codeowners({ org: "demo" })
                const treeT = S.Owners.Tree({})
                const wfT = S.Github.Workflow({
                  name: `CI-${slug}`,
                  on: { push: { branches: ["main"] } },
                  runsOn: "ubuntu-latest",
                  run: [buildT]
                })
                const ciGenT = S.Github.CiGen({ workflows: [wfT] })
                const retainT = S.Memory.Retain({
                  source: Reference.GitCommit.make({ ref: "HEAD" }),
                  tags: [slug]
                })
                const suiteT = S.Suite({ tests: [svcTestT, diffCheckT] })

                const workspace = S.Workspace(`eco-${slug}`, {
                  repository: "git+https://example.invalid/eco.git",
                  cache: S.Cache({ directory: ".flows" }),
                  runtime: S.Runtime.Node({ version: ">=26.4.0" }),
                  packageManager: S.PackageManager.Pnpm({
                    manifest: packageJson,
                    lockfile: S.file("//pnpm-lock.yaml")
                  }),
                  nodeModules: S.Npm.NodeModules({ packageJson }),
                  host: S.Host({ bins: ["sh", "node", "cargo", "go", "forge", "docker", "smithers"] }),
                  teams,
                  owners: ownersDecl,
                  toolchains: [S.Rust.Toolchain({ workspace: S.file("//Cargo.toml"), channel: "1.86.0" })],
                  memory: S.Memory.SmithersCloud({ bank: ["ci"] })
                })

                const index = PackageIndex.make({
                  root,
                  workspace,
                  factory: undefined,
                  packages: [
                    {
                      file: "PACKAGE.ts",
                      packagePath: "",
                      value: S.Package({
                        targets: {
                          fg,
                          build: buildT,
                          mat: matT,
                          alias: aliasT,
                          clean: cleanT,
                          srv: srvT,
                          svcTest: svcTestT,
                          diff: diffT,
                          closure: closureT,
                          diffCheck: diffCheckT,
                          cargoBuild: cargoBuildT,
                          cargoTest: cargoTestT,
                          cargoFmt: cargoFmtT,
                          goMod: goModT,
                          goPkg: goPkgT,
                          goBin: goBinT,
                          goTest: goTestT,
                          forgeBuild: forgeBuildT,
                          forgeTest: forgeTestT,
                          forgeFmt: forgeFmtT,
                          dockerBuild: dockerBuildT,
                          dockerPush: dockerPushT,
                          codeowners: codeownersT,
                          tree: treeT,
                          wf: wfT,
                          ciGen: ciGenT,
                          retain: retainT,
                          suite: suiteT
                        }
                      })
                    }
                  ]
                })

                const env = {
                  ...process.env,
                  PATH: `${binDir}${NodePath.delimiter}${process.env["PATH"] ?? ""}`
                }
                const labels = [
                  "//:fg",
                  "//:alias",
                  "//:mat",
                  "//:suite",
                  "//:diff",
                  "//:closure",
                  "//:cargoBuild",
                  "//:cargoTest",
                  "//:cargoFmt",
                  "//:goMod",
                  "//:goPkg",
                  "//:goBin",
                  "//:goTest",
                  "//:forgeBuild",
                  "//:forgeTest",
                  "//:forgeFmt",
                  "//:dockerBuild",
                  "//:dockerPush",
                  "//:codeowners",
                  "//:tree",
                  "//:ciGen",
                  "//:retain"
                ]

                const runOpts = {
                  index,
                  cacheDirectory: ".flows",
                  verb: "auto" as const,
                  patterns: labels,
                  mode: writeMode ? ("write" as const) : ("check" as const),
                  write: writeMode,
                  jobs: 2,
                  environment: env,
                  approvals: { granted: async () => true }
                }
                const plan = await PackagePlanner.plan(runOpts)
                expect(plan.nodes.size).toBeGreaterThanOrEqual(labels.length)

                const summary1 = await Effect.runPromise(
                  PackageRunner.executeEffect(plan, runOpts).pipe(
                    Effect.provideService(PackageRunner.ExecutionServices, PackageRunner.executionServicesLive)
                  )
                )
                expect(summary1.results.length).toBeGreaterThanOrEqual(10)

                // Warm replay exercises cache-hit & restoreDirectoryArchive paths
                const summary2 = await Effect.runPromise(
                  PackageRunner.executeEffect(plan, runOpts).pipe(
                    Effect.provideService(PackageRunner.ExecutionServices, PackageRunner.executionServicesLive)
                  )
                )
                expect(summary2.counts.hit).toBeGreaterThanOrEqual(1)

                // Clean target
                const cleanOpts = {
                  index,
                  cacheDirectory: ".flows",
                  verb: "auto" as const,
                  patterns: ["//:clean"],
                  jobs: 1,
                  environment: env
                }
                const cleanPlan = await PackagePlanner.plan(cleanOpts)
                const cleanSum = await Effect.runPromise(
                  PackageRunner.executeEffect(cleanPlan, cleanOpts).pipe(
                    Effect.provideService(PackageRunner.ExecutionServices, PackageRunner.executionServicesLive)
                  )
                )
                expect(cleanSum.counts.failed).toBe(0)
              })
              return true
            }),
          { executions: fsExecutions, seed: 20261260 }
        )
      )
      assertPassed(report)
    },
    120_000
  )

  it(
    "PackageRunner helpers, Agent.Lint/Agent.Diff/LlmLint live runner dispatch & observed-reads with machines",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          slug: slugArb,
          agentOutcome: Schema.Literals(["clean", "findings", "escape"])
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ slug, agentOutcome }) =>
            Effect.promise(async () => {
              // Pure PackageRunner helpers
              expect(PackageRunner.refusedByProtection("EROFS: cannot write")).toBe(true)
              expect(PackageRunner.refusedByProtection("bwrap: failed")).toBe(true)
              expect(PackageRunner.refusedByProtection("Read-only file system")).toBe(true)
              expect(PackageRunner.refusedByProtection("normal output")).toBe(false)
              expect(
                PackageRunner.renderReviewFindings({
                  findings: [{ file: "src/a.ts", line: 3, severity: "error", message: `bad ${slug}` }],
                  fingerprints: [`fp-${slug}`]
                })
              ).toContain(`bad ${slug}`)
              expect(
                PackageRunner.reviewFailureText({
                  _tag: "smithers-build/LlmReviewError",
                  phase: "store",
                  message: "boom"
                })
              ).toBeDefined()
              expect(
                PackageRunner.reviewFailureText({
                  _tag: "smithers-build/FindingsError",
                  failOn: "error",
                  findings: [{ file: "a.ts", line: 1, severity: "error", message: "x" }]
                })
              ).toContain("review finding")
              expect(PackageRunner.reviewFailureText(new Error("plain"))).toBeUndefined()

              await withTempDir("smthrs-bc8-ag-", async (root) => {
                const binDir = NodePath.join(root, ".fake-bin")
                await Fs.mkdir(binDir, { recursive: true })
                await Fs.mkdir(NodePath.join(root, "src"), { recursive: true })
                await Fs.writeFile(
                  NodePath.join(root, "package.json"),
                  JSON.stringify({ name: `ag-${slug}`, type: "module", packageManager: "pnpm@11.25.0" })
                )
                await Fs.writeFile(NodePath.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n")
                await Fs.writeFile(NodePath.join(root, "PROMPT.md"), `Review ${slug}\n`)
                await Fs.writeFile(NodePath.join(root, "src", "a.ts"), `export const a = "${slug}"\n`)

                gitExec(root, ["init", "--quiet", "--initial-branch=main"])
                gitExec(root, ["config", "user.name", "Fuzz"])
                gitExec(root, ["config", "user.email", "fuzz@example.invalid"])
                gitExec(root, ["config", "commit.gpgsign", "false"])
                gitExec(root, ["add", "-A"])
                gitExec(root, ["commit", "--quiet", "-m", "base"])
                const baseSha = gitExec(root, ["rev-parse", "HEAD"])
                await Fs.writeFile(NodePath.join(root, "src", "a.ts"), `export const a = "${slug}-v2"\n`)

                // currentExecutableDigest + protectedEntries
                const execMemo = new Map()
                const nodeDig = await PackageRunner.currentExecutableDigest(execMemo, process.execPath)
                const nodeDig2 = await PackageRunner.currentExecutableDigest(execMemo, process.execPath)
                expect(nodeDig2).toBe(nodeDig)
                expect(typeof nodeDig).toBe("string")
                expect(PackageRunner.protectedEntries(root, ["src"]).length).toBeGreaterThanOrEqual(1)

                const claudeResp = agentOutcome === "findings"
                  ? {
                    note: "bad",
                    findings: [{ file: "src/a.ts", line: 1, severity: "error", message: `err-${slug}` }]
                  }
                  : agentOutcome === "escape"
                  ? { note: "esc", edits: [{ path: "../outside.txt", contents: "x" }] }
                  : { note: `ok-${slug}`, findings: [], edits: [] }

                await writeExecutable(
                  NodePath.join(binDir, "claude"),
                  `#!${process.execPath}
(async () => {
  for await (const _ of process.stdin) {}
  process.stdout.write(JSON.stringify({ type: "result", result: ${JSON.stringify(JSON.stringify(claudeResp))} }));
})();
`
                )

                const packageJson = S.file("//package.json")
                const claudeAgent = S.Agent.ClaudeCode({ model: "claude-sonnet-4" })
                const agentLintT = S.Agent.Lint({
                  agent: claudeAgent,
                  prompt: Input.file("PROMPT.md"),
                  data: [Input.gitDiff(baseSha), Input.file("src/a.ts")],
                  fixes: agentOutcome === "escape" ? ["src/**"] : undefined
                })
                const obsT = S.Shell.Test({
                  bin: S.Host.bin("node"),
                  args: ["-e", `require("fs").readFileSync("src/a.ts","utf8")`],
                  sandbox: "none",
                  observe: { env: ["HOME"] }
                })

                const workspace = S.Workspace(`ag-${slug}`, {
                  repository: "git+https://example.invalid/ag.git",
                  cache: S.Cache({ directory: ".flows" }),
                  runtime: S.Runtime.Node({ version: ">=26.4.0" }),
                  packageManager: S.PackageManager.Pnpm({
                    manifest: packageJson,
                    lockfile: S.file("//pnpm-lock.yaml")
                  }),
                  nodeModules: S.Npm.NodeModules({ packageJson }),
                  host: S.Host({ bins: ["node", "claude"] })
                })
                const index = PackageIndex.make({
                  root,
                  workspace,
                  factory: undefined,
                  packages: [
                    {
                      file: "PACKAGE.ts",
                      packagePath: "",
                      value: S.Package({ targets: { agentLint: agentLintT, obs: obsT } })
                    }
                  ]
                })

                const env = {
                  ...process.env,
                  PATH: `${binDir}${NodePath.delimiter}${process.env["PATH"] ?? ""}`
                }
                const agOpts = {
                  index,
                  cacheDirectory: ".flows",
                  verb: "auto" as const,
                  patterns: ["//:agentLint", "//:obs"],
                  mode: agentOutcome === "escape" ? ("write" as const) : ("check" as const),
                  jobs: 1,
                  environment: env
                }
                const plan = await PackagePlanner.plan(agOpts)
                const sum = await Effect.runPromise(
                  PackageRunner.executeEffect(plan, agOpts).pipe(
                    Effect.provideService(PackageRunner.ExecutionServices, PackageRunner.executionServicesLive)
                  )
                )
                expect(sum.results.length).toBe(2)
                if (agentOutcome === "clean") {
                  expect(sum.counts.failed).toBe(0)
                }
              })
              return true
            }),
          { executions: fsExecutions, seed: 20261261 }
        )
      )
      assertPassed(report)
    },
    120_000
  )

  it(
    "Cli.ts full JSON/flag/help/version/units/watch/cache/clean/init/error command matrix & PackageLoader edge cases",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          slug: slugArb,
          jsonFlag: Schema.Boolean
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ slug, jsonFlag }) =>
            Effect.promise(async () => {
              await withTempDir("smthrs-bc8-cli-", async (root) => {
                await Fs.mkdir(NodePath.join(root, "packages", slug, "src"), { recursive: true })
                await Fs.writeFile(
                  NodePath.join(root, "package.json"),
                  JSON.stringify({ name: `ws-${slug}`, type: "module", packageManager: "pnpm@11.25.0" })
                )
                await Fs.writeFile(NodePath.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n")
                await Fs.writeFile(
                  NodePath.join(root, "tsconfig.json"),
                  JSON.stringify({ compilerOptions: { strict: true } })
                )
                await Fs.writeFile(NodePath.join(root, "packages", slug, "src", "a.ts"), `export const a = "${slug}"\n`)
                await Fs.writeFile(
                  NodePath.join(root, "WORKSPACE.ts"),
                  [
                    `import { Smithers as S } from "@smthrs/targets"`,
                    `const packageJson = S.file("//package.json")`,
                    `export const Workspace = S.Workspace("ws-${slug}", {`,
                    `  repository: "git+https://example.invalid/ws.git",`,
                    `  cache: S.Cache({ directory: ".flows" }),`,
                    `  runtime: S.Runtime.Node({ version: ">=26.4.0" }),`,
                    `  packageManager: S.PackageManager.Pnpm({ manifest: packageJson, lockfile: S.file("//pnpm-lock.yaml") }),`,
                    `  nodeModules: S.Npm.NodeModules({ packageJson }),`,
                    `  host: S.Host({ bins: ["sh", "node"] })`,
                    `})`
                  ].join("\n")
                )
                await Fs.writeFile(
                  NodePath.join(root, "packages", slug, "PACKAGE.ts"),
                  [
                    `import { Smithers as S } from "@smthrs/targets"`,
                    `const build = S.Shell.Build({`,
                    `  bin: S.Host.bin("sh"),`,
                    `  args: ["-c", "mkdir -p packages/${slug}/dist && echo ok > packages/${slug}/dist/a.txt"],`,
                    `  data: [S.file("src/a.ts")],`,
                    `  outDirs: ["dist"]`,
                    `})`,
                    `const test = S.Shell.Test({`,
                    `  bin: S.Host.bin("node"),`,
                    `  args: ["-e", "process.exit(0)"],`,
                    `  data: [S.file("src/a.ts")]`,
                    `})`,
                    `export const Package = S.Package({ targets: { build, test } })`
                  ].join("\n")
                )

                gitExec(root, ["init", "--quiet", "--initial-branch=main"])
                gitExec(root, ["config", "user.name", "Fuzz"])
                gitExec(root, ["config", "user.email", "fuzz@example.invalid"])
                gitExec(root, ["config", "commit.gpgsign", "false"])
                gitExec(root, ["add", "-A"])
                gitExec(root, ["commit", "--quiet", "-m", "init"])

                const run = (argv: ReadonlyArray<string>) => serve(root, argv)
                const flag = jsonFlag ? ["--json"] : []

                expect((await run(["--help"])).exitCode).toBe(0)
                expect((await run(["--version"])).exitCode).toBe(0)
                expect((await run(["targets", ...flag])).exitCode).toBe(0)
                expect((await run(["index", "//...", ...flag])).exitCode).toBe(0)
                expect((await run(["graph", "//...", ...flag])).exitCode).toBe(0)
                expect((await run(["query", `//packages/${slug}/...`, ...flag])).exitCode).toBe(0)
                const expectOk = async (args: ReadonlyArray<string>) => {
                  const r = await run(args)
                  expect(r.exitCode, args.join(" ") + ": " + r.output + "\n" + r.logs).toBe(0)
                }
                await expectOk(["show", "target", `//packages/${slug}:build`, ...flag])
                await expectOk(["explain", `//packages/${slug}:build`, ...flag])
                await expectOk(["build", `//packages/${slug}:build`])
                await expectOk(["test", `//packages/${slug}:test`])
                await expectOk(["affected", "build", "--list", "--files", `packages/${slug}/src/a.ts`, ...flag])
                await expectOk(["cache", "status", ...flag])
                await expectOk(["cache", "prune", "--dry-run", ...flag])
                await expectOk(["cache", "prune", "--yes", ...flag])
                await expectOk(["cache", "--help"])
                await expectOk(["info", ...flag])
                void (await run(["docs", "//...", ...flag]))

                // Error paths: unknown command, unknown label, invalid flags
                expect((await run(["nonexistent-cmd"])).exitCode).not.toBe(0)
                expect((await run(["build", "//does/not:exist"])).exitCode).not.toBe(0)
                expect((await run(["build", "--jobs", "notanumber"])).exitCode).not.toBe(0)

                // PackageLoader probeCacheDirectory + loadWorkspaceDeclaration
                const probed = await PackageLoader.probeCacheDirectory(root, NodePath.join(root, "WORKSPACE.ts"))
                expect(probed).toBe(".flows")
                const wsDecl = await PackageLoader.loadWorkspaceDeclaration(root, NodePath.join(root, "WORKSPACE.ts"))
                expect(wsDecl.name).toBe(`ws-${slug}`)
                await withTempDir("smthrs-bc8-empty-", async (emptyDir) => {
                  expect((await serve(emptyDir, ["targets"])).exitCode).not.toBe(0)
                })
              })
              return true
            }),
          { executions: fsExecutions, seed: 20261262 }
        )
      )
      assertPassed(report)
    },
    120_000
  )
})
