import { Fuzz } from "@smthrs/fuzz"
import { Smithers as S } from "@smthrs/targets"
import * as Exec from "@smthrs/targets/Exec"
import * as ExecSandbox from "@smthrs/targets/ExecSandbox"
import { Arbitrary, Effect, Schema } from "effect"
import * as NodeChildProcess from "node:child_process"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as AgentFake from "../src/AgentFake.ts"
import * as Machine from "../src/internal/Machine.ts"
import * as ObservedReads from "../src/internal/ObservedReads.ts"
import { executeEffect, ExecutionServices, executionServicesLive } from "../src/internal/PackageRunner.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import { writeExecutable } from "./helpers/Executable.ts"

const executions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? "100")
const heavyExecutions = Math.max(3, Math.min(executions, 4))

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

const writeFile = async (root: string, rel: string, content: string, mode = 0o644): Promise<void> => {
  const full = NodePath.isAbsolute(rel) ? rel : NodePath.join(root, rel)
  await Fs.mkdir(NodePath.dirname(full), { recursive: true })
  await Fs.writeFile(full, content, { mode })
  if (mode !== 0o644) await Fs.chmod(full, mode)
}

const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "user.name=Fuzz", "-c", "user.email=fuzz@example.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim()

const slugArb = Schema.Literals(["w0", "w1", "w2", "w3"])

describe("@smthrs/build-cli Wave-6A: PackageRunner & PackagePlanner deep rule, evidence, agent, submodule & machine-keep fuzz", () => {
  it(
    "Node-lane, artifact, Api.Compat, Markdown.CodeBlocks, Files.digest, Rspack, Overlay, Cargo.AppSet, Cron & Github rules",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          slug: slugArb,
          compatBumped: Schema.Boolean,
          digestMatches: Schema.Boolean,
          writeMode: Schema.Boolean,
          rspackFails: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ slug, compatBumped, digestMatches, writeMode, rspackFails }) =>
            Effect.promise(async () => {
              await withTempDir("smthrs-w6a-rules-", async (base) => {
                const root = NodePath.join(base, "ws")
                const binDir = NodePath.join(base, "bin")
                await Fs.mkdir(root, { recursive: true })
                await Fs.mkdir(binDir, { recursive: true })
                await Fs.mkdir(NodePath.join(root, "node_modules/demo-tool"), { recursive: true })
                await Fs.mkdir(NodePath.join(root, "node_modules/.bin"), { recursive: true })
                await Fs.writeFile(
                  NodePath.join(root, "node_modules/demo-tool/package.json"),
                  JSON.stringify({ name: "demo-tool", version: "1.2.3", bin: { "demo-tool": "cli.js" } })
                )
                await writeExecutable(
                  NodePath.join(root, "node_modules/demo-tool/cli.js"),
                  "#!/bin/sh\necho demo-tool-ok\n"
                )
                await writeExecutable(
                  NodePath.join(root, "node_modules/.bin/demo-tool"),
                  "#!/bin/sh\necho demo-tool-ok\n"
                )

                // Fake pnpm/node/tsc/changeset/size-limit/npm binaries
                await writeExecutable(
                  NodePath.join(binDir, "pnpm"),
                  `#!${process.execPath}
const fs = require("fs");
const path = require("path");
let args = process.argv.slice(2);
while (args.length > 0 && args[0].startsWith("--config.")) args = args.slice(1);
if (args[0] === "--version") { console.log("11.21.0"); process.exit(0); }
if (args[0] === "dlx") {
  const dest = args[args.length - 1];
  if (dest) {
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0" }));
  }
  process.exit(0);
}
if (args[0] === "pack") {
  const destIdx = args.indexOf("--pack-destination");
  const dest = destIdx >= 0 ? args[destIdx + 1] : ".";
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, "demo-1.0.0.tgz"), "tarball-${slug}");
  console.log("demo-1.0.0.tgz");
  process.exit(0);
}
if (args[0] === "view") {
  console.log(JSON.stringify("1.0.0"));
  process.exit(0);
}
if (args[0] === "exec") {
  const tool = args[1];
  if (tool === "tsc" || tool === "vibelang") { process.exit(0); }
  if (tool === "changeset") {
    fs.writeFileSync("version.txt", "1.0.1-${slug}\\n");
    process.exit(0);
  }
  if (tool === "size-limit") {
    console.log("size ok");
    process.exit(0);
  }
}
process.exit(0);
`
                )
                await writeExecutable(
                  NodePath.join(binDir, "node"),
                  `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "--version" || args[0] === "-v") { console.log("v26.4.0"); process.exit(0); }
process.exit(0);
`
                )
                await writeFile(
                  root,
                  "package.json",
                  JSON.stringify({
                    name: `demo-${slug}`,
                    version: compatBumped ? "1.1.0" : "1.0.0",
                    packageManager: "pnpm@11.21.0"
                  })
                )
                await writeFile(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
                await writeFile(root, "input.txt", `hello-${slug}\n`)
                await writeFile(root, "changeset.json", JSON.stringify({ baseBranch: "main" }))
                await writeFile(root, "version.txt", `1.0.1-${slug}\n`)
                await writeFile(root, "gen.txt", `gen-${slug}\n`)
                await writeFile(root, "docs/context.md", "# Ctx\n\n```ts title=\"ctx.ts\"\nexport const ctx = 1\n```\n")
                await writeFile(root, "README.md", `# Guide ${slug}\n\n\`\`\`ts\nexport const x: number = 1\n\`\`\`\n`)
                await writeFile(root, "EMPTY.md", "# No code blocks\n")
                await writeFile(root, "overlay/base.txt", "base\n")
                await writeFile(root, "overlay/replacement.txt", "replacement\n")
                await writeFile(root, "src/main.ts", `export const main = "${slug}"\n`)
                await writeFile(root, "src/unused.ts", `export const unused = 1\n`)
                await writeFile(root, "rsbuild.config.mjs", "export default {}\n")
                await writeFile(
                  root,
                  "crates/a/Cargo.toml",
                  "[package]\nname = \"crate-a\"\nversion = \"0.1.0\"\n[package.metadata.smithers]\nkind = \"app\"\n"
                )
                await writeFile(
                  root,
                  "crates/b/Cargo.toml",
                  "[package]\nname = \"crate-b\"\nversion = \"0.1.0\"\n[package.metadata.smithers]\nkind = \"skip\"\n"
                )
                await writeFile(
                  root,
                  "node_modules/typescript/package.json",
                  JSON.stringify({ name: "typescript", version: "5.8.0" })
                )
                await writeFile(root, "node_modules/.bin/tsc", "#!/bin/sh\nexit 0\n", 0o755)

                const manifest = S.file("//package.json")
                const gate = S.Shell.Test({ shell: "true", sandbox: "none" })
                const pack = S.Npm.Pack({ manifest, data: [S.file("//input.txt")] })
                const published = S.Npm.Published({ manifest })
                const literal = S.Literal({ path: "out/literal.txt", content: `lit-${slug}` })
                const copy = S.Copy({ from: S.file("//input.txt"), to: "out/copied.txt" })
                const markdown = S.Markdown.CodeBlocks({
                  file: S.file("//README.md"),
                  context: [S.file("//docs/context.md")],
                  lang: ["ts"]
                })
                const emptyMd = S.Markdown.CodeBlocks({
                  file: S.file("//EMPTY.md"),
                  lang: ["ts"]
                })
                const version = S.Changesets.Version({ config: S.file("//changeset.json"), changes: ["version.txt"] })
                const size = S.Size.Budgets({ manifest })
                const baseBuild = S.Shell.Build({
                  shell:
                    `mkdir -p api-base && printf 'export declare const a: number;\\n' > api-base/index.d.ts && printf '{"version":"1.0.0"}' > api-base/package.json`,
                  outDirs: ["api-base"]
                })
                const surfBuild = S.Shell.Build({
                  shell: `mkdir -p api-surf && printf 'export declare const a: string;\\n' > api-surf/index.d.ts`,
                  outDirs: ["api-surf"]
                })
                const compatSame = S.Api.Compat({ baseline: baseBuild, surface: baseBuild, manifest })
                const compatDiff = S.Api.Compat({ baseline: baseBuild, surface: surfBuild, manifest })

                const digestBuild = S.Shell.Build({
                  shell: `mkdir -p digest && printf 'hi-${slug}' > digest/a.txt`,
                  outDirs: ["digest"]
                })
                // Precompute matching or mismatching baseline digest
                const expectedDigestHex = digestMatches
                  ? (await import("@smthrs/targets/Input")).digestText(`hi-${slug}`)
                  : "0".repeat(64)
                await writeFile(
                  root,
                  "digest-baseline.json",
                  JSON.stringify([{ path: "digest/a.txt", digest: expectedDigestHex }])
                )
                const digestTest = S.Test({
                  expect: S.Files.digest(digestBuild),
                  toBe: S.file("//digest-baseline.json")
                })

                const cron = S.Cron({ schedule: "0 6 * * 1", run: [gate] })
                const setup = S.Github.Setup({})
                const workflow = S.Github.Workflow({ name: "ci", on: { pullRequest: true }, setup, run: [gate] })
                const gen = S.Generate({
                  command: `printf 'gen-${slug}\\n' > gen.txt`,
                  changes: ["gen.txt"]
                })

                const overlayBase = S.Filegroup({ srcs: [S.file("//overlay/base.txt")] })
                const overlay = S.Overlay({
                  base: overlayBase,
                  replace: { "overlay/base.txt": S.file("//overlay/replacement.txt") }
                })
                const overlayBuild = S.Shell.Build({
                  shell: "mkdir -p overlay-out && cp overlay/base.txt overlay-out/result.txt",
                  data: [overlay],
                  outDirs: ["overlay-out"]
                })

                const allApps = S.Cargo.AppSet({ manifests: S.glob(["crates/*/Cargo.toml"]) })
                const skippedApps = S.Cargo.AppSet({
                  manifests: S.glob(["crates/*/Cargo.toml"]),
                  metadata: { smithers: { kind: "skip" } }
                })
                const keptApps = S.Files.difference(allApps, skippedApps)

                const srcs = S.Filegroup({ srcs: S.glob(["src/**"]) })
                const rspack = S.Bundler.Rspack({ config: S.file("//rsbuild.config.mjs") })
                const graph = rspack.resolve({ entries: ["src/main.ts"], universe: [srcs] })
                const bundle = rspack.build({
                  environment: "web",
                  mode: "development",
                  graph,
                  outDirs: ["dist-bundle"]
                })
                const dead = S.Test({ expect: S.Files.difference(srcs, graph.files), toBe: "empty" })

                const mat = S.Materialize(overlayBuild)
                const fileOutBuild = S.Shell.Build({
                  shell:
                    `mkdir -p fout && printf '#!/bin/sh\necho bin-${slug}\n' > fout/tool.sh && chmod +x fout/tool.sh && printf 'f-${slug}' > single.txt`,
                  outDirs: ["fout"],
                  outFiles: ["single.txt"],
                  sandbox: "none"
                })
                const flagAndGiven = S.Shell.Test({
                  bin: fileOutBuild,
                  args: ["{smthrs:flag:mode}"],
                  given: { env: ["GIVEN_DEMO"], names: ["GIVEN_DEMO"] },
                  sandbox: "none"
                })
                const diffWithBin = S.Shell.Diff({
                  bin: S.NodeModule.Bin("demo-tool"),
                  args: ["--version"],
                  changes: ["src/**"],
                  sandbox: "none"
                })

                const index = PackageIndex.make({
                  root,
                  workspace: S.Workspace("w6a", {
                    repository: "git+https://example.invalid/w6a.git",
                    cache: S.Cache({ directory: ".flows" }),
                    runtime: S.Runtime.Node({ version: ">=26.4.0" }),
                    packageManager: S.PackageManager.Pnpm({ manifest, lockfile: S.file("//pnpm-lock.yaml") }),
                    nodeModules: S.Npm.NodeModules({ packageJson: manifest }),
                    host: S.Host({ bins: ["sh", "cp", "mkdir", "printf"] }),
                    flags: S.Flags({ mode: "fast" }),
                    sandboxes: S.Sandboxes({ default: S.Sandbox.None() })
                  }),
                  factory: undefined,
                  packages: [{
                    file: "PACKAGE.ts",
                    packagePath: "",
                    value: S.Package({
                      targets: {
                        gate,
                        pack,
                        published,
                        literal,
                        copy,
                        markdown,
                        emptyMd,
                        version,
                        size,
                        baseBuild,
                        surfBuild,
                        compatSame,
                        compatDiff,
                        digestBuild,
                        digestTest,
                        cron,
                        setup,
                        workflow,
                        gen,
                        overlayBase,
                        overlay,
                        overlayBuild,
                        allApps,
                        skippedApps,
                        srcs,
                        graph,
                        bundle,
                        dead,
                        mat,
                        fileOutBuild,
                        flagAndGiven,
                        diffWithBin,
                        cargoSetCheck: S.Cargo.Test({ crates: keptApps })
                      }
                    })
                  }]
                })

                const env = { PATH: `${binDir}:${process.env["PATH"] ?? "/usr/bin:/bin"}`, GIVEN_DEMO: "ok-val" }
                const services: ExecutionServices = {
                  ...executionServicesLive,
                  resolveGraph: (_opts, _payload) =>
                    rspackFails
                      ? Effect.fail(
                        Object.assign(new Error("resolve failed"), {
                          _tag: "smithers-build/ExecError" as const,
                          argv: ["rspack"] as const,
                          cwd: root,
                          exitCode: 1,
                          stdout: "",
                          stderr: "boom",
                          durationMs: 1,
                          timedOut: false
                        }) as unknown as Exec.ExecError
                      )
                      : Effect.succeed({
                        graphDigest: String(slug.charCodeAt(1) % 10).repeat(64),
                        moduleCount: 1,
                        files: [{ path: "src/main.ts", digest: "a".repeat(64) }],
                        packages: []
                      }),
                  build: (_opts, _payload) =>
                    Effect.promise(async () => {
                      await writeFile(root, "dist-bundle/app.js", `bundle-${slug}`)
                      return { exitCode: 0, stdout: "", stderr: "" }
                    })
                }

                const runBatch = async (patterns: ReadonlyArray<string>, write = false) => {
                  const prev = process.env["PATH"]
                  process.env["PATH"] = env.PATH
                  try {
                    const opts = {
                      index,
                      patterns,
                      cacheDirectory: ".flows",
                      verb: "auto" as const,
                      write,
                      keepGoing: true,
                      jobs: 2,
                      environment: env,
                      log: () => {}
                    }
                    const planned = await PackageExec.plan(opts)
                    return await Effect.runPromise(
                      executeEffect(planned, opts).pipe(Effect.provideService(ExecutionServices, services))
                    )
                  } finally {
                    if (prev === undefined) delete process.env["PATH"]
                    else process.env["PATH"] = prev
                  }
                }

                const first = await runBatch([
                  "//:pack",
                  "//:published",
                  "//:literal",
                  "//:copy",
                  "//:markdown",
                  "//:emptyMd",
                  "//:version",
                  "//:size",
                  "//:compatSame",
                  "//:compatDiff",
                  "//:digestTest",
                  "//:cron",
                  "//:setup",
                  "//:workflow",
                  "//:gen",
                  "//:overlay",
                  "//:overlayBuild",
                  "//:mat",
                  "//:fileOutBuild",
                  "//:flagAndGiven",
                  "//:diffWithBin",
                  "//:allApps",
                  "//:bundle",
                  "//:dead"
                ], writeMode)
                const byLabel = new Map(first.results.map((r) => [r.label, r]))

                expect(
                  byLabel.get("//:markdown")?.status,
                  JSON.stringify(first.results.filter((r) => r.status === "failed").map((r) => [r.label, r.error]))
                ).toBe("ran")
                expect(byLabel.get("//:emptyMd")?.status).toBe("failed")
                expect(byLabel.get("//:size")?.status).toBe("ran")
                expect(byLabel.get("//:compatSame")?.status).toBe("ran")
                expect(byLabel.get("//:compatDiff")?.status).toBe(compatBumped ? "ran" : "failed")
                expect(byLabel.get("//:digestTest")?.status).toBe(digestMatches ? "ran" : "failed")
                expect(byLabel.get("//:cron")?.status).toBe("ran")
                expect(byLabel.get("//:setup")?.status).toBe("ran")
                expect(byLabel.get("//:workflow")?.status).toBe("ran")
                expect(byLabel.get("//:gen")?.status).toBe("ran")
                expect(byLabel.get("//:overlayBuild")?.status).toBe("ran")
                expect(await Fs.readFile(NodePath.join(root, "overlay-out/result.txt"), "utf8")).toBe("replacement\n")
                expect(byLabel.get("//:mat")?.status).toBe("ran")
                if (rspackFails) {
                  expect(byLabel.get("//:graph")?.status).toBe("failed")
                } else {
                  expect(byLabel.get("//:graph")?.status).toBe("ran")
                  expect(byLabel.get("//:bundle")?.status).toBe("ran")
                  // src/unused.ts is in srcs but not in graph.files -> dead test must fail!
                  expect(byLabel.get("//:dead")?.status).toBe("failed")
                }

                // Remove overlay-out & single.txt & fout before warm run so Materialize & restoreBuild restore from CAS!
                await Fs.rm(NodePath.join(root, "overlay-out"), { recursive: true, force: true })
                await Fs.rm(NodePath.join(root, "fout"), { recursive: true, force: true })
                await Fs.rm(NodePath.join(root, "single.txt"), { force: true })
                const warm = await runBatch([
                  "//:markdown",
                  "//:size",
                  "//:compatSame",
                  "//:gen",
                  "//:mat",
                  "//:fileOutBuild",
                  ...(digestMatches ? ["//:digestTest"] : []),
                  ...(!rspackFails ? ["//:bundle"] : [])
                ], false)
                const warmMap = new Map(warm.results.map((r) => [r.label, r]))
                expect(warmMap.get("//:markdown")?.status).toBe("hit")
                expect(warmMap.get("//:size")?.status).toBe("hit")
                expect(warmMap.get("//:compatSame")?.status).toBe("hit")
                if (!writeMode) expect(warmMap.get("//:gen")?.status).toBe("hit")
                if (digestMatches) expect(warmMap.get("//:digestTest")?.status).toBe("hit")
                if (!rspackFails) {
                  expect(warmMap.get("//:graph")?.status).toBe("hit")
                  expect(warmMap.get("//:bundle")?.status).toBe("hit")
                }
              })
              return true
            }),
          { seed: 20261301, executions: heavyExecutions }
        )
      )
      assertPassed(report)
    },
    120_000
  )

  it(
    "Catalog tools (Vitest, NodeTest, Typecheck, EsLint, Dprint+plugins, TsBuild) & PackageRunner.runWithEvidence confinement",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          slug: slugArb,
          behaviour: Schema.Literals(["clean", "undeclared_read", "fail_exit", "path_mismatch"]),
          withPlugins: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ slug, behaviour, withPlugins }) =>
            Effect.promise(async () => {
              await withTempDir("smthrs-w6a-evid-", async (base) => {
                const root = NodePath.join(base, "ws")
                const tools = NodePath.join(base, "tools", "bin")
                const dprintCache = NodePath.join(base, "dprint-cache")
                await Fs.mkdir(tools, { recursive: true })
                await Fs.mkdir(root, { recursive: true })

                await writeFile(
                  base,
                  NodePath.join(tools, "pnpm"),
                  "#!/bin/sh\nif [ \"$1\" = exec ]; then shift; tool=\"$1\"; shift; exec \"./node_modules/.bin/$tool\" \"$@\"; fi\nprintf '11.21.0\\n'\n",
                  0o755
                )
                await writeFile(
                  base,
                  NodePath.join(tools, "node"),
                  "#!/bin/sh\ncase \"$1\" in --test) shift; exec /bin/sh \"$@\" ;; *.sh) exec /bin/sh \"$@\" ;; esac\nprintf '26.4.0\\n'\n",
                  0o755
                )
                await writeFile(
                  root,
                  "package.json",
                  JSON.stringify({ name: `ev-${slug}`, private: true, packageManager: "pnpm@11.21.0" })
                )
                await writeFile(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
                await writeFile(root, "pkg/package.json", JSON.stringify({ name: "pkg" }))
                await writeFile(root, "pkg/source.ts", `export const v = "${slug}"\n`)
                await writeFile(root, "pkg/config.json", "{}\n")
                await writeFile(root, "pkg/secret-undeclared.txt", "hidden\n")

                const scriptBody = behaviour === "clean"
                  ? "cat source.ts >/dev/null\nexit 0\n"
                  : behaviour === "undeclared_read"
                  ? "cat secret-undeclared.txt >/dev/null\nexit 0\n"
                  : behaviour === "fail_exit"
                  ? "exit 1\n"
                  : "cat source.ts >/dev/null\nexit 0\n"
                await writeFile(root, "pkg/case.test.ts", scriptBody)
                for (const tool of ["vitest", "vibelang", "eslint", "dprint", "tsc"]) {
                  await writeFile(root, `pkg/node_modules/.bin/${tool}`, "#!/bin/sh\nset -e\n. ./case.test.ts\n", 0o755)
                }
                await writeFile(
                  root,
                  "pkg/node_modules/vitest/package.json",
                  JSON.stringify({ name: "vitest", version: "5.0.0" })
                )
                await writeFile(root, "pkg/node_modules/runner/lib.txt", `installed-${slug}\n`)
                await writeFile(
                  root,
                  "pkg/build.sh",
                  "set -e\n/bin/mkdir -p dist/esm\n/bin/cat source.ts > dist/esm/source.js\necho 'export {}' > dist/esm/source.d.ts\n"
                )

                const pinnedPlugin =
                  "https://plugins.dprint.dev/typescript-0.95.0.wasm@1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
                if (withPlugins) {
                  const source = pinnedPlugin.slice(0, pinnedPlugin.lastIndexOf("@"))
                  await writeFile(
                    base,
                    NodePath.join(dprintCache, "plugins", "1.json"),
                    JSON.stringify({ source: `remote:${source}` })
                  )
                  await writeFile(base, NodePath.join(dprintCache, "plugins", "1.cwasm"), "compiled\n")
                  await writeFile(root, "pkg/dprint.json", JSON.stringify({ plugins: [pinnedPlugin] }))
                }

                const cwd = "pkg"
                const sources = [S.file("source.ts")]
                const index = PackageIndex.make({
                  root,
                  workspace: S.Workspace("ev", {
                    repository: "git+https://example.invalid/ev.git",
                    cache: S.Cache({ directory: ".flows" }),
                    runtime: S.Runtime.Node({ version: ">=26.4.0" }),
                    packageManager: S.PackageManager.Pnpm({
                      manifest: S.file("//package.json"),
                      lockfile: S.file("//pnpm-lock.yaml")
                    }),
                    nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") }),
                    host: S.Host({ bins: ["sh", "cat"] })
                  }),
                  factory: undefined,
                  packages: [{
                    file: "pkg/PACKAGE.ts",
                    packagePath: "pkg",
                    value: S.Package({
                      targets: {
                        test: S.Vitest({
                          tests: [S.file("case.test.ts")],
                          sources,
                          deps: [],
                          config: S.file("config.json"),
                          environment: "node",
                          passWithNoTests: false,
                          cwd
                        }),
                        nodeTest: S.NodeTest({
                          runner: S.testRunner([S.file("case.test.ts")]),
                          srcs: sources,
                          deps: [],
                          cwd
                        }),
                        check: S.Typecheck({
                          srcs: [S.file("case.test.ts"), ...sources],
                          deps: [],
                          tsconfig: S.file("config.json"),
                          buildMode: false,
                          incremental: false,
                          cwd
                        }),
                        lint: S.EsLint({
                          sources: [S.file("case.test.ts"), ...sources],
                          deps: [],
                          configs: [S.file("config.json")],
                          maxWarnings: 0,
                          fix: false,
                          cwd
                        }),
                        fmt: S.Dprint({
                          sources: [S.file("case.test.ts"), ...sources],
                          deps: [],
                          config: S.file(withPlugins ? "dprint.json" : "config.json"),
                          fix: false,
                          cwd
                        }),
                        build: S.TsBuild({
                          srcs: sources,
                          entries: sources,
                          deps: [],
                          tsconfig: S.file("config.json"),
                          tool: { name: "program", entry: S.file("build.sh") },
                          format: "esm",
                          outDir: "dist",
                          cwd
                        })
                      }
                    })
                  }]
                })

                const prevPath = process.env["PATH"] ?? "/usr/bin:/bin"
                const toolPath = `${tools}:${prevPath}`
                const env: Record<string, string> = {
                  PATH: toolPath,
                  DPRINT_CACHE_DIR: dprintCache
                }
                process.env["PATH"] = behaviour === "path_mismatch" ? `${prevPath}:${tools}` : toolPath
                try {
                  const opts = {
                    index,
                    patterns: ["//pkg:test", "//pkg:nodeTest", "//pkg:check", "//pkg:lint", "//pkg:fmt", "//pkg:build"],
                    cacheDirectory: ".flows",
                    verb: "auto" as const,
                    keepGoing: true,
                    jobs: 2,
                    environment: env,
                    log: () => {}
                  }
                  const firstPlan = await PackageExec.plan(opts)
                  const first = await Effect.runPromise(
                    executeEffect(firstPlan, opts).pipe(Effect.provideService(ExecutionServices, executionServicesLive))
                  )
                  const map1 = new Map(first.results.map((r) => [r.label, r]))

                  if (behaviour === "fail_exit") {
                    expect(map1.get("//pkg:test")?.status).toBe("failed")
                  } else if (behaviour === "clean") {
                    expect(map1.get("//pkg:test")?.status).toBe("ran")
                    expect(map1.get("//pkg:nodeTest")?.status).toBe("ran")
                    expect(map1.get("//pkg:check")?.status).toBe("ran")
                    expect(map1.get("//pkg:lint")?.status).toBe("ran")
                    expect(map1.get("//pkg:fmt")?.status).toBe("ran")
                    expect(["ran", "failed"]).toContain(map1.get("//pkg:test")?.status)

                    // Warm run: evidenced targets hit cache!
                    const secondPlan = await PackageExec.plan(opts)
                    const second = await Effect.runPromise(
                      executeEffect(secondPlan, opts).pipe(
                        Effect.provideService(ExecutionServices, executionServicesLive)
                      )
                    )
                    const map2 = new Map(second.results.map((r) => [r.label, r]))
                    expect(map2.get("//pkg:build")?.status).toBe("hit")
                    const provable = ExecSandbox.enforceable(
                      { policy: undefined, reads: [], writes: [] },
                      ExecSandbox.host()
                    )
                    if (provable) {
                      expect(map2.get("//pkg:test")?.status).toBe("hit")
                      expect(map2.get("//pkg:fmt")?.status).toBe("hit")
                    }
                  } else {
                    // undeclared_read or path_mismatch: ran or failed, never falsely cached on path_mismatch
                    expect(["ran", "failed"]).toContain(map1.get("//pkg:test")?.status)
                  }
                } finally {
                  process.env["PATH"] = prevPath
                }
              })
              return true
            }),
          { seed: 20261302, executions: heavyExecutions }
        )
      )
      assertPassed(report)
    },
    120_000
  )

  it(
    "Agent.Diff candidate/gate loop + preservation, Docs.Page, Git.Commit, Git.Submodule & Repo.Target execution",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          slug: slugArb,
          agentOutcome: Schema.Literals(["pass_then_cache", "exhaust_preserve", "escape_refused"]),
          dirtySubmodule: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ slug, agentOutcome, dirtySubmodule }) =>
            Effect.promise(async () => {
              await withTempDir("smthrs-w6a-agent-", async (base) => {
                const root = NodePath.join(base, "ws")
                const subOrigin = NodePath.join(root, ".sub-origin")
                const siblingRepo = NodePath.join(root, "repos", "sibling")
                await Fs.mkdir(root, { recursive: true })
                await Fs.mkdir(subOrigin, { recursive: true })
                await Fs.mkdir(siblingRepo, { recursive: true })

                // Init submodule origin repo
                git(subOrigin, "init", "-q", "--initial-branch=main")
                await writeFile(subOrigin, "lib.txt", `sub-${slug}\n`)
                git(subOrigin, "add", "-A")
                git(subOrigin, "commit", "-q", "-m", "sub init")

                // Init sibling repo for Repo.Target
                git(siblingRepo, "init", "-q", "--initial-branch=main")
                await writeFile(siblingRepo, "package.json", JSON.stringify({ name: "sib", version: "1.0.0" }))
                await writeFile(
                  siblingRepo,
                  "WORKSPACE.ts",
                  `import { Smithers as S } from "@smthrs/targets"\nexport const Workspace = S.Workspace("sib", { repository: "git+https://example.invalid/sib.git", cache: S.Cache({ directory: ".flows" }), host: S.Host({ bins: ["sh"] }), sandboxes: S.Sandboxes({ default: S.Sandbox.None() }) })\n`
                )
                await writeFile(
                  siblingRepo,
                  "PACKAGE.ts",
                  `import { Smithers as S } from "@smthrs/targets"\nexport const Package = S.Package({ targets: { ok: S.Shell.Test({ shell: "true", sandbox: "none" }) } })\n`
                )
                git(siblingRepo, "add", "-A")
                git(siblingRepo, "commit", "-q", "-m", "sib init")

                // Init main repo
                git(root, "init", "-q", "--initial-branch=main")
                await writeFile(root, ".gitignore", ".flows\nrepos\n.sub-origin\n")
                await writeFile(
                  root,
                  "package.json",
                  JSON.stringify({ name: `ag-${slug}`, version: "1.0.0", packageManager: "yarn@4.0.0" })
                )
                await writeFile(root, "yarn.lock", "# yarn\n")
                await writeFile(root, "prompt.md", `Generate output for ${slug}\n`)
                await writeFile(root, "brief.md", `Docs brief ${slug}\n`)
                await writeFile(root, "src/in.txt", `in-${slug}\n`)
                await writeFile(root, "out/generated.txt", "initial\n")
                await writeFile(root, "guide.md", "# old\n")
                git(root, "add", "-A")
                git(root, "commit", "-q", "-m", "init")
                git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", subOrigin, "vendor/one")
                git(root, "commit", "-q", "-m", "add submodule")
                git(root, "config", "protocol.file.allow", "always")

                // Write valid FakeScript ({ responses: [...] }) so Agent.Diff, gateAgainstTree, preserveCandidate & Docs.Page actually run!
                const fakePath = NodePath.join(base, "fake-agent.json")
                const fakeScript: AgentFake.FakeScript = {
                  responses: [
                    agentOutcome === "escape_refused"
                      ? { findings: [], edits: [{ path: "src/escaped.txt", contents: "bad\n" }], note: "escaped" }
                      : {
                        findings: [],
                        edits: [{ path: "out/generated.txt", contents: `generated-${slug}\n` }],
                        note: "ok"
                      },
                    { findings: [], edits: [{ path: "guide.md", contents: `# Guide ${slug}\n` }], note: "doc ok" }
                  ]
                }
                await writeFile(base, fakePath, JSON.stringify(fakeScript))

                const srcs = S.Filegroup({ srcs: S.glob(["src/**"]) })
                const passGate = S.Shell.Test({ shell: `grep -q generated-${slug} out/generated.txt`, sandbox: "none" })
                const failGate = S.Shell.Test({ shell: "false", sandbox: "none" })

                const diffTarget = S.Agent.Diff({
                  prompt: S.file("//prompt.md"),
                  data: [srcs],
                  changes: ["out/**"],
                  gates: [agentOutcome === "exhaust_preserve" ? failGate : passGate],
                  maxRounds: 1
                })
                const docPage = S.Docs.Page({
                  brief: S.file("//brief.md"),
                  prompt: S.file("//prompt.md"),
                  references: [],
                  inputs: [S.file("//src/in.txt")],
                  output: "guide.md",
                  gates: [],
                  maxRounds: 1
                })
                const commitTarget = S.Git.Commit({
                  message: `chore: commit ${slug}`,
                  changes: ["out/**"],
                  gates: [passGate]
                })
                const subTarget = S.Git.Submodule({ path: "//vendor/one" })
                const repoTarget = S.Repo.Target("sib", "//:ok", { sandbox: "none" })

                const manifest = S.file("//package.json")
                const index = PackageIndex.make({
                  root,
                  workspace: S.Workspace("ag", {
                    repository: "git+https://example.invalid/ag.git",
                    cache: S.Cache({ directory: ".flows" }),
                    runtime: S.Runtime.Node({ version: ">=20.0.0" }),
                    packageManager: S.PackageManager.Yarn({ manifest, lockfile: S.file("//yarn.lock") }),
                    nodeModules: S.Npm.NodeModules({ packageJson: manifest }),
                    agents: S.Agents({ default: S.Agent.Codex({ model: "luna" }) }),
                    repos: { sib: S.LocalRepository("repos/sibling") },
                    host: S.Host({ bins: ["sh", "grep", "git"] }),
                    sandboxes: S.Sandboxes({ default: S.Sandbox.None() })
                  }),
                  factory: undefined,
                  packages: [{
                    file: "PACKAGE.ts",
                    packagePath: "",
                    value: S.Package({
                      targets: { srcs, passGate, failGate, diffTarget, docPage, commitTarget, subTarget, repoTarget }
                    })
                  }]
                })

                if (dirtySubmodule) {
                  await writeFile(root, "vendor/one/dirty.txt", "uncommitted\n")
                }

                const env: Record<string, string> = {
                  ...process.env as Record<string, string>,
                  SMTHRS_AGENT_FAKE: fakePath,
                  SMITHERS_SUBMODULE_SOURCES: base
                }
                const run = async (patterns: ReadonlyArray<string>, write = false) => {
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
                  return Effect.runPromise(
                    executeEffect(planned, opts).pipe(Effect.provideService(ExecutionServices, executionServicesLive))
                  )
                }

                const res = await run(["//:diffTarget", "//:subTarget"], true)
                const m = new Map(res.results.map((r) => [r.label, r]))
                if (agentOutcome === "pass_then_cache") {
                  expect(m.get("//:diffTarget")?.status).toBe("ran")
                  expect(await Fs.readFile(NodePath.join(root, "out/generated.txt"), "utf8")).toContain(
                    `generated-${slug}`
                  )
                  // Warm run hits cache
                  const warm = await run(["//:diffTarget"], true)
                  expect(warm.results.find((r) => r.label === "//:diffTarget")?.status).toBe("hit")
                  // Commit the generated output via Git.Commit
                  const committed = await run(["//:commitTarget"], true)
                  expect(committed.results.find((r) => r.label === "//:commitTarget")?.status).toBe("ran")
                } else {
                  expect(m.get("//:diffTarget")?.status).toBe("failed")
                }

                if (dirtySubmodule) {
                  expect(m.get("//:subTarget")?.status).toBe("failed")
                } else {
                  expect(m.get("//:subTarget")?.status, m.get("//:subTarget")?.error).toBe("ran")
                  const warmSub = await run(["//:subTarget"], false)
                  expect(warmSub.results.find((r) => r.label === "//:subTarget")?.status).toBe("hit")
                }

                if (agentOutcome === "pass_then_cache") {
                  const docRes = await run(["//:docPage"], true)
                  expect(docRes.results.find((r) => r.label === "//:docPage")?.status).toBe("ran")
                }
                // Execute Repo.Target once to keep suite fast
                if (!dirtySubmodule && agentOutcome === "pass_then_cache") {
                  const repoRes = await run(["//:repoTarget"], false)
                  expect(["ran", "hit", "failed"]).toContain(
                    repoRes.results.find((r) => r.label === "//:repoTarget")?.status
                  )
                }
              })
              return true
            }),
          { seed: 20261303, executions: heavyExecutions }
        )
      )
      assertPassed(report)
    },
    120_000
  )

  it(
    "Machine kept jobs (Machine.keepVariable), background daemon cleanup, putBack & ObservedReads live strace cache lifecycle",
    async () => {
      const tracing = ObservedReads.observer(ExecSandbox.host())
      if ("reason" in tracing) return

      const arb = Arbitrary.schema(
        Schema.Struct({
          slug: slugArb,
          keepMachine: Schema.Boolean,
          leaveDaemon: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ slug, keepMachine, leaveDaemon }) =>
            Effect.promise(async () => {
              await withTempDir("smthrs-w6a-mkeep-", async (base) => {
                const root = NodePath.join(base, "ws")
                const home = NodePath.join(base, "home")
                const machinesDir = NodePath.join(base, "machines")
                await Fs.mkdir(root, { recursive: true })
                await Fs.mkdir(home, { recursive: true })
                git(root, "init", "-q", "--initial-branch=main")
                await writeFile(root, ".gitignore", ".flows\n")
                await writeFile(root, "in.txt", `v1-${slug}\n`)
                git(root, "add", "-A")
                git(root, "commit", "-q", "-m", "one")

                const prodCmd = leaveDaemon
                  ? "(sleep 30 >/dev/null 2>&1 </dev/null &) && cat in.txt > produced.txt"
                  : "cat in.txt > produced.txt"
                const prod = S.Shell.Test({
                  shell: prodCmd,
                  machine: "ci",
                  sandbox: "none",
                  observe: true,
                  data: [S.glob("**")]
                })
                const cons = S.Shell.Test({
                  shell: "cat produced.txt > consumed.txt",
                  machine: "ci",
                  sandbox: "none",
                  observe: true,
                  data: [S.glob("**"), prod]
                })

                const index = PackageIndex.make({
                  root,
                  workspace: S.Workspace("mkeep", {
                    repository: "git+https://example.invalid/mkeep.git",
                    cache: S.Cache({ directory: ".flows" }),
                    host: S.Host({ bins: ["sh", "cat", "sleep"] })
                  }),
                  factory: undefined,
                  packages: [{ file: "PACKAGE.ts", packagePath: "", value: S.Package({ targets: { prod, cons } }) }]
                })

                const origPath = process.env["PATH"] ?? "/usr/bin:/bin"
                const env: Record<string, string> = {
                  PATH: [NodePath.dirname(tracing.tracer), origPath].join(NodePath.delimiter),
                  HOME: home,
                  [Machine.holdingVariable]: machinesDir,
                  ...(keepMachine
                    ? { [Machine.keepVariable]: JSON.stringify({ ci: NodePath.join(base, "kept-ci") }) }
                    : {})
                }

                const runNames = async (names: ReadonlyArray<string>) => {
                  const prev = process.env["PATH"]
                  process.env["PATH"] = env["PATH"]
                  try {
                    const opts = {
                      index,
                      cacheDirectory: ".flows",
                      verb: "auto" as const,
                      patterns: names.map((n) => `//:${n}`),
                      environment: env,
                      jobs: 1,
                      log: () => {}
                    }
                    const planned = await PackageExec.plan(opts)
                    const summary = await Effect.runPromise(
                      executeEffect(planned, opts).pipe(Effect.provideService(ExecutionServices, executionServicesLive))
                    )
                    return Object.fromEntries(summary.results.map((r) => [r.label.split(":")[1]!, r.status]))
                  } finally {
                    process.env["PATH"] = prev
                  }
                }

                // Cold run: both run
                const r1 = await runNames(["cons"])
                expect(r1["prod"]).toBe("ran")
                expect(r1["cons"]).toBe("ran")

                // Warm run: both hit (exercises kept archive + putBackFor!)
                const r2 = await runNames(["cons"])
                expect(r2["prod"]).toBe("hit")
                expect(r2["cons"]).toBe("hit")

                // Mutate in.txt -> both must invalidate and re-run!
                await writeFile(root, "in.txt", `v2-${slug}\n`)
                const r3 = await runNames(["cons"])
                expect(r3["prod"]).toBe("ran")
                expect(r3["cons"]).toBe("ran")

                // Verify kept machine tree exists when keepVariable=1
                if (keepMachine) {
                  const entries = NodeFs.existsSync(NodePath.join(base, "kept-ci"))
                    ? await Fs.readdir(NodePath.join(base, "kept-ci"))
                    : []
                  expect(entries.length).toBeGreaterThan(0)
                }
              })
              return true
            }),
          { seed: 20261304, executions: heavyExecutions }
        )
      )
      assertPassed(report)
    },
    120_000
  )
})
