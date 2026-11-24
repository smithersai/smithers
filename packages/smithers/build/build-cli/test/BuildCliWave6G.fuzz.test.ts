import { Fuzz } from "@smthrs/fuzz"
import { Smithers as S } from "@smthrs/targets"
import { Arbitrary, Effect, Schema } from "effect"
import { execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Machine from "../src/internal/Machine.ts"
import { executeEffect, ExecutionServices, executionServicesLive } from "../src/internal/PackageRunner.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as StampExec from "../src/StampExec.ts"

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

const slugArb = Schema.Literals(["aa", "b1", "c2", "d3"])

describe("@smthrs/build-cli Wave-6G: PackagePlanner & PackageRunner deep coverage fuzz", () => {
  it(
    "PackagePlanner Cargo.AppSet, bun/using/tools/PackageManager.Bin, Generate emit/bin/stdout, Docs.Check, Stamp/Flags, Link/nodeModules, Npm.Downstream & brace globs",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          slug: slugArb,
          badMode: Schema.Literals(["valid", "bad_crates", "bad_flag", "bad_docs_input", "bad_using_npx"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ slug, badMode }) =>
            Effect.promise(async () => {
              await withTempDir("smthrs-w6g-plan-", async (root) => {
                execFileSync("git", ["init", "-q"], { cwd: root })
                execFileSync("git", ["config", "user.email", "w6g@example.invalid"], { cwd: root })
                execFileSync("git", ["config", "user.name", "w6g"], { cwd: root })

                const binDir = NodePath.join(root, "fake-bin")
                await Fs.mkdir(binDir, { recursive: true })
                await writeExecutable(
                  NodePath.join(binDir, "bun"),
                  `#!${process.execPath}\nif (process.argv[2] === "--version") { console.log("1.4.2"); process.exit(0); }\nprocess.exit(0);\n`
                )
                await writeExecutable(
                  NodePath.join(binDir, "pnpm"),
                  `#!${process.execPath}\nif (process.argv[2] === "--version") { console.log("11.21.0"); process.exit(0); }\nprocess.exit(0);\n`
                )
                await writeExecutable(
                  NodePath.join(binDir, "cargo"),
                  `#!${process.execPath}\nif (process.argv[2] === "--version") { console.log("cargo 1.85.0"); process.exit(0); }\nprocess.exit(0);\n`
                )

                // Workspace files: Cargo crates, package.json, symlink chain, sub/node_modules, docs
                await Fs.mkdir(NodePath.join(root, "crates/app-a"), { recursive: true })
                await Fs.mkdir(NodePath.join(root, "crates/app-skip"), { recursive: true })
                await Fs.mkdir(NodePath.join(root, "sub/node_modules/pkg"), { recursive: true })
                await Fs.mkdir(NodePath.join(root, "docs"), { recursive: true })
                await Fs.mkdir(NodePath.join(root, "src"), { recursive: true })

                await Fs.writeFile(
                  NodePath.join(root, "package.json"),
                  JSON.stringify({ name: `w6g-${slug}`, version: "1.0.0", packageManager: "pnpm@11.21.0" })
                )
                await Fs.writeFile(NodePath.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
                await Fs.writeFile(
                  NodePath.join(root, "sub/package.json"),
                  JSON.stringify({ name: "sub", version: "1.0.0" })
                )
                await Fs.writeFile(NodePath.join(root, "sub/pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
                await Fs.writeFile(NodePath.join(root, "sub/node_modules/pkg/index.js"), "module.exports = 1\n")
                await Fs.writeFile(
                  NodePath.join(root, "crates/app-a/Cargo.toml"),
                  `[package]\nname = "app-a-${slug}"\nversion = "0.1.0"\n[package.metadata.smithers]\nkind = "app"\n`
                )
                await Fs.writeFile(
                  NodePath.join(root, "crates/app-skip/Cargo.toml"),
                  `[package]\nname = "app-skip-${slug}"\nversion = "0.1.0"\n[package.metadata.smithers]\nkind = "skip"\n`
                )
                await Fs.writeFile(NodePath.join(root, "src/a.ts"), `export const x = "${slug}"\n`)
                await Fs.writeFile(NodePath.join(root, "docs/guide.md"), `# Guide ${slug}\n`)
                await Fs.writeFile(NodePath.join(root, "docs/guide.stamp.json"), "{}\n")
                await Fs.writeFile(NodePath.join(root, "real-target.txt"), `real-${slug}\n`)
                await Fs.symlink("real-target.txt", NodePath.join(root, "hop1"))
                await Fs.symlink("hop1", NodePath.join(root, "hop2"))

                execFileSync("git", ["add", "."], { cwd: root })
                execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root })

                const manifest = S.file("//package.json")
                const allApps = S.Cargo.AppSet({ manifests: S.glob("crates/*/Cargo.toml") })
                const skipApps = S.Cargo.AppSet({
                  manifests: S.glob("crates/*/Cargo.toml"),
                  metadata: { smithers: { kind: "skip" } }
                })
                const keptApps = S.Files.difference(allApps, skipApps)
                const fg = S.Filegroup({ srcs: [S.glob("src/**/*.ts"), S.file("//docs/guide.md")] })
                const cargoBuild = S.Cargo.Build({ workspace: true })
                const cargoTest = S.Cargo.Test({
                  crates: badMode === "bad_crates" ? (fg as unknown as typeof keptApps) : keptApps
                })

                const prodBin = S.Shell.Build({
                  shell:
                    `mkdir -p binout && printf '#!/bin/sh\\necho prod-${slug}\\n' > binout/run.sh && chmod +x binout/run.sh && printf 'file-${slug}' > out.txt`,
                  outDirs: ["binout"],
                  outFiles: ["out.txt"],
                  sandbox: "none"
                })
                const genEmit = S.Generate({
                  emit: {
                    "gen/a.txt": `emitted-${slug}\n`,
                    "gen/link.txt": S.symlink("a.txt")
                  },
                  changes: ["gen/**"]
                })
                const genBin = S.Generate({
                  bin: prodBin,
                  args: ["ok"],
                  stdout: "gen/stdout.txt",
                  changes: ["gen/stdout.txt"],
                  sandbox: "none"
                })
                const bunToolsTest = S.Shell.Test({
                  bun: `console.log("bun-${slug}", TOOL_SH)`,
                  using: badMode === "bad_using_npx"
                    ? { bad: S.Runtime.npx("prettier") }
                    : { TOOL_SH: S.Host.bin("sh") },
                  tools: [S.Host.bin("sh"), S.PackageManager.bin],
                  sandbox: "none"
                })
                const flagStampTest = S.Shell.Test({
                  bin: S.Host.bin("sh"),
                  args: [
                    "-c",
                    "echo $1",
                    "_",
                    badMode === "bad_flag" ? "{smthrs:flag:missingFlag}" : "{smthrs:flag:mode}"
                  ],
                  env: {
                    STAMP_COMMIT: StampExec.token("commit", S.Stamp.commit),
                    STAMP_TIME: StampExec.token("buildTime", S.Stamp.buildTime)
                  },
                  data: [
                    S.link("//hop2"),
                    S.nodeModules("//sub"),
                    S.glob("{missing-dir-a,missing-dir-b}/*.ts"),
                    S.glob("{src,missing-dir-c}/*.ts")
                  ],
                  sandbox: "none"
                })
                const docsCheck = S.Docs.Check({
                  inputs: badMode === "bad_docs_input" ? [prodBin as unknown as typeof fg] : [fg, S.file("//src/a.ts")],
                  output: S.file("//docs/guide.md"),
                  stamp: S.file("//docs/guide.stamp.json")
                })
                const downstream = S.Npm.Downstream({
                  repository: "https://example.invalid/consumer.git",
                  overrides: { demo: prodBin },
                  run: ["pnpm", "test"]
                })

                const index = PackageIndex.make({
                  root,
                  workspace: S.Workspace("w6g-plan", {
                    repository: "git+https://example.invalid/w6g.git",
                    cache: S.Cache({ directory: ".flows" }),
                    runtime: S.Runtime.Node({ version: ">=26.4.0" }),
                    packageManager: S.PackageManager.Pnpm({ manifest, lockfile: S.file("//pnpm-lock.yaml") }),
                    nodeModules: S.Npm.NodeModules({ packageJson: manifest }),
                    host: S.Host({ bins: ["sh", "cargo", "bun", "pnpm"] }),
                    flags: S.Flags({ mode: "fast" }),
                    sandboxes: S.Sandboxes({ default: S.Sandbox.None() })
                  }),
                  factory: undefined,
                  packages: [
                    {
                      file: "PACKAGE.ts",
                      packagePath: "",
                      value: S.Package({
                        targets: {
                          allApps,
                          skipApps,
                          fg,
                          cargoBuild,
                          cargoTest,
                          prodBin,
                          genEmit,
                          genBin,
                          bunToolsTest,
                          flagStampTest,
                          docsCheck,
                          downstream
                        }
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
                expect(planned.nodes.size).toBeGreaterThanOrEqual(8)
                if (badMode !== "valid") {
                  expect([...planned.nodes.values()].some((n) => n.refusal !== undefined)).toBe(true)
                }

                // Execute genEmit (write mode), prodBin, and re-run prodBin for cache hit!
                if (badMode === "valid") {
                  const runOpts = (patterns: ReadonlyArray<string>, write = false): PackageExec.RunOptions => ({
                    index,
                    patterns,
                    verb: "auto",
                    cacheDirectory: ".flows",
                    write,
                    jobs: 2,
                    environment: env,
                    log: () => {}
                  })
                  const o1 = runOpts(["//:prodBin", "//:genEmit"], true)
                  const res = await Effect.runPromise(executeEffect(await PackageExec.plan(o1), o1))
                  expect(res.ok).toBe(true)
                  const o2 = runOpts(["//:prodBin"], false)
                  const hitRes = await Effect.runPromise(executeEffect(await PackageExec.plan(o2), o2))
                  expect(hitRes.ok).toBe(true)
                  expect(hitRes.results.find((r) => r.label === "//:prodBin")?.status).toBe("hit")
                }
              })
              return true
            }),
          { seed: 20261901, executions: 6 }
        )
      )
      assertPassed(report)
    },
    90_000
  )

  it(
    "PackageRunner runWithEvidence confined-fail fallback + attemptFailed cache, dependency-read invalidation, Git.Commit gate+agentMessage, Memory.Retain, Install & kept-machine putBack/runKept",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          slug: slugArb,
          commitGatePass: Schema.Boolean,
          leaveDaemon: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ slug, commitGatePass, leaveDaemon }) =>
            Effect.promise(async () => {
              await withTempDir("smthrs-w6g-run-", async (root) => {
                execFileSync("git", ["init", "-q"], { cwd: root })
                execFileSync("git", ["config", "user.email", "w6g@example.invalid"], { cwd: root })
                execFileSync("git", ["config", "user.name", "w6g"], { cwd: root })

                await Fs.writeFile(
                  NodePath.join(root, "package.json"),
                  JSON.stringify({ name: `w6g-r-${slug}`, version: "1.0.0", packageManager: "pnpm@11.21.0" })
                )
                await Fs.writeFile(NodePath.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
                await Fs.writeFile(NodePath.join(root, "secret-undeclared.txt"), `undeclared-${slug}\n`)
                await Fs.writeFile(NodePath.join(root, "declared.txt"), `decl-v1-${slug}\n`)
                await Fs.writeFile(NodePath.join(root, "commit-me.txt"), "base\n")
                await Fs.writeFile(NodePath.join(root, "consumer-input.txt"), "v1\n")
                await Fs.writeFile(
                  NodePath.join(root, ".gitignore"),
                  ".flows/\nprod-out/\nkept-state.txt\nfallback.test.mjs\n"
                )

                execFileSync("git", ["add", "."], { cwd: root })
                execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: root })

                // Dirty commit-me.txt so Git.Commit has real changes to gate & commit
                await Fs.writeFile(NodePath.join(root, "commit-me.txt"), `updated-${slug}\n`)

                const manifest = S.file("//package.json")
                // 1. Confined attempt fails (reads undeclared file), falls back to unconfined runDeclared (succeeds!) -> rememberFailedAttempt
                //    2nd run hits attemptFailed!
                await Fs.writeFile(
                  NodePath.join(root, "fallback.test.mjs"),
                  "import { readFileSync } from \"node:fs\"; import test from \"node:test\"; test(\"reads undeclared\", () => { readFileSync(\"secret-undeclared.txt\", \"utf8\"); });\n"
                )
                const confinedFallback = S.NodeTest({
                  runner: S.testRunner([S.file("fallback.test.mjs")]),
                  srcs: [S.file("fallback.test.mjs"), S.file("declared.txt")],
                  deps: [],
                  cwd: "."
                })
                // 2. Producer + consumer with CacheEvidence where producer output changes between runs
                const prod = S.Shell.Build({
                  shell: `mkdir -p prod-out && cat declared.txt > prod-out/val.txt`,
                  outDirs: ["prod-out"],
                  data: [S.file("//declared.txt")],
                  sandbox: "none"
                })
                const cons = S.Shell.Test({
                  shell: "cat prod-out/val.txt >/dev/null",
                  data: [prod],
                  tools: [S.Host.bin("cat")]
                })
                // 3. Git.Commit with gate + agent message composer
                const commitGate = S.Shell.Test({
                  shell: commitGatePass ? "cat commit-me.txt >/dev/null" : "exit 1",
                  data: [S.file("//commit-me.txt")],
                  sandbox: "none"
                })
                const gitCommitTarget = S.Git.Commit({
                  gates: [commitGate],
                  message: S.Agents.writer!,
                  changes: ["commit-me.txt"]
                })
                // 4. Memory.Retain (unavailable backend -> typed notice L5860-5875)
                const retain = S.Memory.Retain({
                  source: S.gitCommit("HEAD"),
                  tags: [`tag-${slug}`]
                })
                // 5. Install target (L5877-5885 via injected services.install)
                const installTarget = S.Install({
                  packageManager: S.PackageManager.Pnpm({
                    version: "11.21.0",
                    runtime: S.Runtime.Node({ version: ">=26.4.0" })
                  })
                })
                // 6. Kept-machine producer -> consumer chain (exercises putBack + runKept on Build 2!)
                const keptDir = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-w6g-keep-")))
                const keptMarker = NodePath.join(root, "kept-state.txt")
                const daemonCode = leaveDaemon
                  ? `node -e 'setTimeout(() => {}, 2500)' </dev/null >/dev/null 2>&1 & echo kept-daemon-${slug} > kept-state.txt`
                  : `echo kept-file-${slug} > kept-state.txt`
                const keptProd = S.Shell.Test({
                  shell: daemonCode,
                  data: [S.file("//declared.txt")],
                  sandbox: "none"
                })
                const keptCons = S.Shell.Test({
                  shell: "cat kept-state.txt consumer-input.txt >/dev/null",
                  data: [keptProd, S.file("//consumer-input.txt")],
                  sandbox: "none"
                })

                const index = PackageIndex.make({
                  root,
                  workspace: S.Workspace("w6g-run", {
                    repository: "git+https://example.invalid/w6g-run.git",
                    cache: S.Cache({ directory: ".flows" }),
                    runtime: S.Runtime.Node({ version: ">=26.4.0" }),
                    packageManager: S.PackageManager.Pnpm({ manifest, lockfile: S.file("//pnpm-lock.yaml") }),
                    nodeModules: S.Npm.NodeModules({ packageJson: manifest }),
                    host: S.Host({ bins: ["sh", "cat", "mkdir", "node"] }),
                    agents: S.Agents({ writer: S.Agent.ClaudeCode({ model: "claude-sonnet-4" }) }),
                    sandboxes: S.Sandboxes({ default: S.Sandbox.None() })
                  }),
                  factory: undefined,
                  packages: [
                    {
                      file: "PACKAGE.ts",
                      packagePath: "",
                      value: S.Package({
                        targets: {
                          confinedFallback,
                          prod,
                          cons,
                          commitGate,
                          gitCommitTarget,
                          retain,
                          installTarget,
                          keptProd,
                          keptCons
                        }
                      })
                    }
                  ]
                })

                const fakeAgentFile = NodePath.join(keptDir, "fake-agent.json")
                await Fs.writeFile(
                  fakeAgentFile,
                  JSON.stringify({ responses: [{ findings: [], edits: [], note: `feat: update ${slug}` }] })
                )
                const env: Record<string, string | undefined> = {
                  ...process.env,
                  SMTHRS_AGENT_FAKE: fakeAgentFile,
                  [Machine.keepVariable]: JSON.stringify({ [root]: keptDir })
                }
                const services: ExecutionServices = {
                  ...executionServicesLive,
                  install: (() =>
                    Effect.succeed({
                      workspace: root,
                      manager: "pnpm",
                      plan: [],
                      result: {
                        store: "0".repeat(64),
                        manifest: "1".repeat(64),
                        linked: true
                      }
                    })) as unknown as ExecutionServices["install"]
                }
                const runSet = async (patterns: ReadonlyArray<string>) => {
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
                  return await Effect.runPromise(
                    executeEffect(pl, opts).pipe(Effect.provideService(ExecutionServices, services))
                  )
                }

                try {
                  // Run 1: confinedFallback (fails confined -> succeeds unconfined -> remembers attempt), cons, installTarget, retain
                  const r1 = await runSet(["//:confinedFallback", "//:cons", "//:installTarget", "//:retain"])
                  const cf1 = r1.results.find((r) => r.label === "//:confinedFallback")
                  if (cf1?.status !== "ran") throw new Error("cf1 failed: " + JSON.stringify(cf1))
                  expect(r1.results.find((r) => r.label === "//:installTarget")?.status).toBe("ran")
                  expect(r1.results.find((r) => r.label === "//:retain")?.status).toBe("failed")

                  // Run 2: confinedFallback again -> hits CacheEvidence.attemptFailed fast-path!
                  const r2 = await runSet(["//:confinedFallback", "//:cons"])
                  expect(r2.results.find((r) => r.label === "//:confinedFallback")?.status).toBe("ran")

                  // Run Git.Commit target (exercises commitGateRunner + agentMessageComposer!)
                  const rCommit = await runSet(["//:gitCommitTarget"])
                  if (rCommit.ok !== commitGatePass) {
                    throw new Error("rCommit mismatch: " + JSON.stringify(rCommit.results))
                  }

                  // Run keptProd -> keptCons (Build 1 records keptProd's file/daemon; Build 2 mutates consumer-input.txt so keptProd hits putBack/runKept!)
                  const k1 = await runSet(["//:keptCons"])
                  expect(k1.ok).toBe(true)
                  await Fs.rm(keptMarker, { force: true })
                  await Fs.writeFile(NodePath.join(root, "consumer-input.txt"), `v2-${slug}\n`)
                  const k2 = await runSet(["//:keptCons"])
                  expect(k2.ok).toBe(true)
                } finally {
                  await Machine.remove(keptDir)
                }
              })
              return true
            }),
          { seed: 20261902, executions: 2 }
        )
      )
      assertPassed(report)
    },
    120_000
  )
})
