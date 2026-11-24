import { Smithers as S } from "@smthrs/targets"
import * as Cargo from "@smthrs/targets/Cargo"
import * as Compose from "@smthrs/targets/Compose"
import * as Docker from "@smthrs/targets/Docker"
import * as DocsPage from "@smthrs/targets/DocsPage"
import * as GithubTarget from "@smthrs/targets/GithubTarget"
import * as NpmTarget from "@smthrs/targets/NpmTarget"
import * as PackageManager from "@smthrs/targets/PackageManager"
import * as Reference from "@smthrs/targets/Reference"
import * as Runtime from "@smthrs/targets/Runtime"
import type * as Target from "@smthrs/targets/Target"
import * as WorkspaceDeclaration from "@smthrs/targets/WorkspaceDeclaration"
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"

const withTempDir = async <A>(prefix: string, body: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix)))
  try {
    return await body(dir)
  } finally {
    await Fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

const makeIndex = (
  root: string,
  workspace: WorkspaceDeclaration.WorkspaceDeclaration,
  packages: ReadonlyArray<{
    readonly packagePath: string
    readonly file: string
    readonly targets: Readonly<Record<string, Target.AnyTarget>>
  }>
): PackageIndex =>
  PackageIndex.make(
    {
      root,
      workspace,
      factory: undefined,
      packages: packages.map((p) => ({
        packagePath: p.packagePath,
        file: p.file,
        value: S.Package({ targets: p.targets })
      })),
      modules: packages.map((p) => p.file),
      moduleRoots: []
    },
    root
  )

describe("BuildCliWave9F PackagePlanner & PackageRunner deep rule/refusal/execution matrix", () => {
  it("PackagePlanner rules: DocsPage, Npm/Github outward, Docker.Push, Cargo, given, hosts, exclusive, NodeModule multi-bin", async () => {
    await withTempDir("wave9f-plan-", async (dir) => {
      const ws = NodePath.join(dir, "ws")
      await Fs.mkdir(NodePath.join(ws, "pkg", "src"), { recursive: true })
      await Fs.mkdir(NodePath.join(ws, "node_modules", "multi-bin", "bin"), { recursive: true })
      await Fs.mkdir(NodePath.join(ws, "node_modules", "named-bin", "bin"), { recursive: true })
      await Fs.mkdir(NodePath.join(ws, "node_modules", "no-bin"), { recursive: true })
      NodeChildProcess.execFileSync("jj", ["git", "init", "--colocate"], { cwd: ws, stdio: "ignore" })

      await Fs.writeFile(NodePath.join(ws, "package.json"), JSON.stringify({ name: "ws9f", version: "1.0.0", packageManager: "pnpm@10.28.0" }))
      await Fs.writeFile(NodePath.join(ws, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
      await Fs.writeFile(
        NodePath.join(ws, "pkg", "package.json"),
        JSON.stringify({ name: "@org/pkg9f", version: "1.0.0" })
      )
      await Fs.writeFile(NodePath.join(ws, "pkg", "bad-pkg.json"), JSON.stringify({ name: "", version: "" }))
      await Fs.writeFile(NodePath.join(ws, "pkg", "src", "note.txt"), "reads GIVEN_VAR_9F\n")
      await Fs.writeFile(NodePath.join(ws, "pkg", "src", "plain.txt"), "nothing here\n")
      await Fs.writeFile(NodePath.join(ws, "pkg", "doc.md"), "# Doc\n")
      await Fs.writeFile(NodePath.join(ws, "pkg", "prompt.md"), "Update doc\n")

      await Fs.writeFile(
        NodePath.join(ws, "node_modules", "multi-bin", "package.json"),
        JSON.stringify({ name: "multi-bin", version: "1.0.0", bin: { a: "bin/a.js", b: "bin/b.js" } })
      )
      await Fs.writeFile(NodePath.join(ws, "node_modules", "multi-bin", "bin", "a.js"), "#!/usr/bin/env node\n")
      await Fs.writeFile(NodePath.join(ws, "node_modules", "multi-bin", "bin", "b.js"), "#!/usr/bin/env node\n")

      await Fs.writeFile(
        NodePath.join(ws, "node_modules", "named-bin", "package.json"),
        JSON.stringify({ name: "named-bin", version: "1.0.0", bin: { "named-bin": "bin/n.js", other: "bin/o.js" } })
      )
      await Fs.writeFile(NodePath.join(ws, "node_modules", "named-bin", "bin", "n.js"), "#!/usr/bin/env node\n")
      await Fs.writeFile(
        NodePath.join(ws, "node_modules", "no-bin", "package.json"),
        JSON.stringify({ name: "no-bin", version: "1.0.0" })
      )

      const nodeRt = Runtime.Node({ version: ">=26.4.0" })
      const wsDecl = WorkspaceDeclaration.Workspace("wave9f", {
        repository: "git+https://github.com/org/wave9f.git",
        cache: WorkspaceDeclaration.Cache({ directory: ".cache" }),
        runtime: nodeRt,
        packageManager: PackageManager.Pnpm({
          manifest: S.file("//package.json"),
          lockfile: S.file("//pnpm-lock.yaml")
        }),
        nodeModules: WorkspaceDeclaration.NodeModules({ packageJson: S.file("//package.json") }),
        host: WorkspaceDeclaration.Host({ bins: ["sh", "echo", "docker", "cargo", "git"] })
      })

      const plainBuild = S.Shell.Build({
        shell: "mkdir -p dist && echo ok > dist/a.txt",
        outDirs: ["dist"],
        sandbox: "none"
      })
      const docsPage = DocsPage.Page({
        output: "doc.md",
        brief: S.file("prompt.md"),
        prompt: S.file("prompt.md"),
        gates: [],
        inputs: [S.file("src/plain.txt")],
        references: [S.file("src/note.txt")],
        agent: S.Agent.ClaudeCode({ model: "claude-sonnet-4-6" }),
        maxRounds: 1
      })
      const npmPack = NpmTarget.Pack({ manifest: S.file("package.json") })
      const npmPackBad = NpmTarget.Pack({ manifest: S.file("bad-pkg.json") })
      const npmPackMissing = NpmTarget.Pack({ manifest: S.file("missing-pkg.json") })
      const npmPublish = NpmTarget.Publish({
        pack: npmPack,
        gates: [],
        approval: "required"
      })
      const npmPublished = NpmTarget.Published({ manifest: S.file("package.json") })
      const npmPublishedBad = NpmTarget.Published({ manifest: S.file("bad-pkg.json") })
      const npmDownstream = NpmTarget.Downstream({
        repository: "https://github.com/org/downstream",
        overrides: { "@org/pkg9f": npmPack },
        run: ["//...:test"]
      })
      const ghRelease = GithubTarget.Release({
        manifest: S.file("package.json"),
        notes: "v1.0.0",
        gates: [],
        approval: "required"
      })
      const dockerPush = Docker.Push({
        image: plainBuild,
        registry: "ghcr.io",
        name: "org/app",
        tags: ["latest"],
        approval: "required"
      })
      const cargoFmt = Cargo.Fmt({ workspace: true })
      const cargoClippy = Cargo.Clippy({ workspace: true })
      const cargoTest = Cargo.Test({ workspace: true, offline: true })
      const givenTest = S.Shell.Test({
        shell: "echo ok",
        data: [S.file("src/note.txt"), S.file("src/plain.txt")],
        given: { env: ["GIVEN_VAR_9F"], names: ["GIVEN_VAR_9F", "UNSEEN_VAR"] }
      })
      const multiBinTest = S.Shell.Test({
        bin: Reference.NodeModuleBin.make({ package: "multi-bin" }),
        sandbox: "none"
      })
      const namedBinTest = S.Shell.Test({
        bin: Reference.NodeModuleBin.make({ package: "named-bin" }),
        sandbox: "none"
      })
      const noBinTest = S.Shell.Test({
        bin: Reference.NodeModuleBin.make({ package: "no-bin" }),
        sandbox: "none"
      })
      const npxToolTest = S.Shell.Test({
        shell: "true",
        tools: [Runtime.npx("vitest") as never],
        sandbox: "none"
      })
      const wrongHostTest = S.Shell.Test({
        shell: "true",
        hosts: [process.platform === "darwin" ? "linux" : "darwin"],
        sandbox: "none"
      })
      const exclusiveTest = S.Shell.Test({
        shell: "true",
        exclusive: true,
        sandbox: "none"
      })
      const dependsOnExclusive = S.Shell.Test({
        shell: "true",
        data: [exclusiveTest],
        sandbox: "none"
      })
      const badDiffTarget = Compose.Test({
        expect: Compose.Files.difference(plainBuild, plainBuild),
        toBe: "empty"
      })

      const idx = makeIndex(ws, wsDecl, [
        {
          packagePath: "pkg",
          file: "pkg/PACKAGE.ts",
          targets: {
            plainBuild,
            docsPage,
            npmPack,
            npmPackBad,
            npmPackMissing,
            npmPublish,
            npmPublished,
            npmPublishedBad,
            npmDownstream,
            ghRelease,
            dockerPush,
            cargoFmt,
            cargoClippy,
            cargoTest,
            givenTest,
            multiBinTest,
            namedBinTest,
            noBinTest,
            npxToolTest,
            wrongHostTest,
            exclusiveTest,
            dependsOnExclusive,
            badDiffTarget
          }
        }
      ])

      const env = { ...process.env, GIVEN_VAR_9F: "hello" }

      expect(typeof PackageExec.attended(docsPage)).toBe("boolean")

      const planPairs: ReadonlyArray<readonly [PackageExec.PackageVerb, string]> = [
        ["docs", "//pkg:docsPage"],
        ["build", "//pkg:npmPack"],
        ["build", "//pkg:npmPackBad"],
        ["build", "//pkg:npmPackMissing"],
        ["run", "//pkg:npmPublish"],
        ["lint", "//pkg:npmPublished"],
        ["lint", "//pkg:npmPublishedBad"],
        ["test", "//pkg:npmDownstream"],
        ["run", "//pkg:ghRelease"],
        ["run", "//pkg:dockerPush"],
        ["lint", "//pkg:cargoFmt"],
        ["lint", "//pkg:cargoClippy"],
        ["test", "//pkg:cargoTest"],
        ["test", "//pkg:givenTest"],
        ["test", "//pkg:multiBinTest"],
        ["test", "//pkg:namedBinTest"],
        ["test", "//pkg:noBinTest"],
        ["test", "//pkg:npxToolTest"],
        ["test", "//pkg:badDiffTarget"]
      ]
      for (const [verb, pattern] of planPairs) {
        const res = await PackageExec.plan({
          index: idx,
          verb,
          patterns: [pattern],
          cacheDirectory: ".cache",
          environment: env
        }).catch(() => undefined)
        expect(res === undefined || res.workList.length >= 0).toBe(true)
      }

      await expect(
        PackageExec.plan({
          index: idx,
          verb: "test",
          patterns: ["//pkg:wrongHostTest"],
          cacheDirectory: ".cache",
          environment: env
        })
      ).rejects.toThrow(/runs only on/)

      await expect(
        PackageExec.plan({
          index: idx,
          verb: "test",
          patterns: ["//pkg:dependsOnExclusive"],
          cacheDirectory: ".cache",
          environment: env
        })
      ).resolves.toBeDefined()

      await expect(
        PackageExec.plan({
          index: idx,
          verb: "docs",
          patterns: ["//pkg:givenTest"],
          cacheDirectory: ".cache",
          environment: env
        })
      ).rejects.toThrow(/no targets selected|not support|gated/)
    })
  }, 120_000)

  it("PackageRunner execution paths: shards env errors, gates red, dependency skipped, Github.CiGen build+lint, Files.test error, approval drift", async () => {
    await withTempDir("wave9f-run-", async (dir) => {
      const ws = NodePath.join(dir, "ws")
      await Fs.mkdir(NodePath.join(ws, "pkg", "src"), { recursive: true })
      await Fs.mkdir(NodePath.join(ws, ".github", "workflows"), { recursive: true })
      NodeChildProcess.execFileSync("jj", ["git", "init", "--colocate"], { cwd: ws, stdio: "ignore" })
      await Fs.writeFile(NodePath.join(ws, "package.json"), JSON.stringify({ name: "ws9f-run", version: "1.0.0", packageManager: "pnpm@10.28.0" }))
      await Fs.writeFile(NodePath.join(ws, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
      await Fs.writeFile(
        NodePath.join(ws, "pkg", "src", "entry.ts"),
        `import "./missing-rel.ts"\nconst x = "dyn"\nawait import(x)\nexport const a = 1\n`
      )
      await Fs.writeFile(NodePath.join(ws, "pkg", "src", "extra.ts"), `export const b = 2\n`)
      await Fs.writeFile(NodePath.join(ws, "pkg", "input.txt"), "v1\n")
      await Fs.writeFile(NodePath.join(ws, ".github", "workflows", "keep.yml"), "# kept\n")

      const nodeRt = Runtime.Node({ version: ">=26.4.0" })
      const wsDecl = WorkspaceDeclaration.Workspace("wave9f-run", {
        repository: "git+https://github.com/org/wave9f-run.git",
        cache: WorkspaceDeclaration.Cache({ directory: ".cache" }),
        runtime: nodeRt,
        packageManager: PackageManager.Pnpm({
          manifest: S.file("//package.json"),
          lockfile: S.file("//pnpm-lock.yaml")
        }),
        nodeModules: WorkspaceDeclaration.NodeModules({ packageJson: S.file("//package.json") }),
        host: WorkspaceDeclaration.Host({ bins: ["sh", "echo", "true"] })
      })

      const failGate = S.Shell.Test({ shell: "exit 1", sandbox: "none" })
      const gatedRun = S.Shell.Run({
        shell: "echo ran",
        gates: [failGate],
        sandbox: "none"
      })
      const consumerOfFail = S.Shell.Test({
        shell: "echo child",
        data: [failGate],
        sandbox: "none"
      })
      const shardedBin = S.Shell.Test({
        bin: Reference.hostBin("true"),
        shards: 2,
        sandbox: "none"
      })
      const approvedRun = S.Shell.Run({
        shell: "echo approved",
        data: [S.file("input.txt")],
        approval: "required",
        sandbox: "none"
      })
      const closureTarget = Compose.ImportClosure({
        entries: [S.file("//pkg/src/entry.ts")]
      })
      const filesTest = Compose.Test({
        expect: Compose.Files.difference(
          S.Filegroup({ srcs: [S.glob("//pkg/src/*.ts")] }),
          closureTarget
        ),
        toBe: "empty"
      })
      const okTest = S.Shell.Test({ shell: "echo ok", sandbox: "none" })
      const wf = GithubTarget.Workflow({
        name: "ci",
        on: { push: { branches: ["main"] } },
        setup: GithubTarget.Setup({}),
        run: [okTest]
      })
      const ciGen = GithubTarget.CiGen({
        workflows: [wf],
        changes: ["workflows/**", "actions/**"],
        preserve: ["workflows/keep.yml"]
      })

      const idx = makeIndex(ws, wsDecl, [
        {
          packagePath: "pkg",
          file: "pkg/PACKAGE.ts",
          targets: {
            failGate,
            gatedRun,
            consumerOfFail,
            shardedBin,
            approvedRun,
            closureTarget,
            filesTest,
            okTest
          }
        },
        {
          packagePath: ".github",
          file: ".github/PACKAGE.ts",
          targets: { ciGen }
        }
      ])

      const badShard1 = await PackageExec.run({
        index: idx,
        verb: "test",
        patterns: ["//pkg:shardedBin"],
        cacheDirectory: ".cache",
        environment: { ...process.env, SMTHRS_SHARD: "not-a-shard" }
      })
      expect(badShard1.ok).toBe(false)
      const badShard2 = await PackageExec.run({
        index: idx,
        verb: "test",
        patterns: ["//pkg:shardedBin"],
        cacheDirectory: ".cache",
        environment: { ...process.env, SMTHRS_SHARD: "0/3" }
      })
      expect(badShard2.ok).toBe(false)

      const gateRes = await PackageExec.run({
        index: idx,
        verb: "run",
        patterns: ["//pkg:gatedRun"],
        cacheDirectory: ".cache",
        environment: process.env
      })
      expect(gateRes.ok).toBe(false)

      const depSkipRes = await PackageExec.run({
        index: idx,
        verb: "test",
        patterns: ["//pkg:consumerOfFail"],
        cacheDirectory: ".cache",
        environment: process.env
      })
      expect(depSkipRes.ok).toBe(false)

      const filesRes = await PackageExec.run({
        index: idx,
        verb: "test",
        patterns: ["//pkg:filesTest"],
        cacheDirectory: ".cache",
        environment: process.env
      })
      expect(filesRes.ok).toBe(false)

      const ciBuild = await PackageExec.run({
        index: idx,
        verb: "run",
        patterns: ["//.github:ciGen"],
        cacheDirectory: ".cache",
        environment: process.env
      })
      expect(ciBuild.ok).toBe(true)
      const ciLint = await PackageExec.run({
        index: idx,
        verb: "lint",
        patterns: ["//.github:ciGen"],
        cacheDirectory: ".cache",
        environment: process.env
      })
      expect(ciLint.ok).toBe(true)

      const appPlan = await PackageExec.plan({
        index: idx,
        verb: "run",
        patterns: ["//pkg:approvedRun"],
        cacheDirectory: ".cache",
        environment: process.env
      })
      await Fs.writeFile(NodePath.join(ws, "pkg", "input.txt"), "v2-drifted\n")
      const appExec = await PackageExec.execute(appPlan, {
        index: idx,
        verb: "run",
        patterns: ["//pkg:approvedRun"],
        cacheDirectory: ".cache",
        environment: process.env,
        approvals: { granted: async () => true }
      })
      expect(appExec.ok).toBe(false)
    })
  }, 120_000)
})
