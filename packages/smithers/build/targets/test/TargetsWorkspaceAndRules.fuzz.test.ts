import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as AgentTarget from "../src/AgentTarget.ts"
import * as Anvil from "../src/Anvil.ts"
import * as BiomeCheck from "../src/BiomeCheck.ts"
import * as BundlerTarget from "../src/BundlerTarget.ts"
import * as BunSuite from "../src/BunSuite.ts"
import * as Cargo from "../src/Cargo.ts"
import * as ChangesetsTarget from "../src/ChangesetsTarget.ts"
import * as Config from "../src/Config.ts"
import * as CronTarget from "../src/CronTarget.ts"
import * as DependencyDocs from "../src/DependencyDocs.ts"
import * as DepsLint from "../src/DepsLint.ts"
import * as Dev from "../src/Dev.ts"
import * as Docker from "../src/Docker.ts"
import * as Dprint from "../src/Dprint.ts"
import * as DtsBuild from "../src/DtsBuild.ts"
import * as Environment from "../src/Environment.ts"
import * as EsLint from "../src/EsLint.ts"
import * as FaultSuite from "../src/FaultSuite.ts"
import * as Fetch from "../src/Fetch.ts"
import * as Filegroup from "../src/Filegroup.ts"
import * as Foundry from "../src/Foundry.ts"
import * as GitTarget from "../src/GitTarget.ts"
import * as Go from "../src/Go.ts"
import * as Input from "../src/Input.ts"
import * as ImportProbe from "../src/internal/ImportProbe.ts"
import * as NearestRealpath from "../src/internal/NearestRealpath.ts"
import * as JsrPublish from "../src/JsrPublish.ts"
import * as LocalRepository from "../src/LocalRepository.ts"
import * as Lockfile from "../src/Lockfile.ts"
import * as ManifestJson from "../src/ManifestJson.ts"
import * as MemoryTarget from "../src/MemoryTarget.ts"
import * as Mise from "../src/Mise.ts"
import * as Mount from "../src/Mount.ts"
import * as Nix from "../src/Nix.ts"
import * as NodeArtifact from "../src/NodeArtifact.ts"
import * as NodeBench from "../src/NodeBench.ts"
import * as NodeBinary from "../src/NodeBinary.ts"
import * as NodeTest from "../src/NodeTest.ts"
import * as NpmPublish from "../src/NpmPublish.ts"
import * as NpmTarget from "../src/NpmTarget.ts"
import * as Outward from "../src/Outward.ts"
import * as Owners from "../src/Owners.ts"
import * as Package from "../src/Package.ts"
import * as PackageLint from "../src/PackageLint.ts"
import * as PackageManager from "../src/PackageManager.ts"
import * as Reference from "../src/Reference.ts"
import * as RemoteCache from "../src/RemoteCache.ts"
import * as RepoTarget from "../src/RepoTarget.ts"
import * as Runtime from "../src/Runtime.ts"
import * as RustToolchain from "../src/RustToolchain.ts"
import * as SafeFs from "../src/SafeFs.ts"
import * as Secret from "../src/Secret.ts"
import * as Shell from "../src/Shell.ts"
import * as Skills from "../src/Skills.ts"
import * as SortPackageJson from "../src/SortPackageJson.ts"
import * as Stamp from "../src/Stamp.ts"
import * as Target from "../src/Target.ts"
import * as ToolRun from "../src/ToolRun.ts"
import * as Typecheck from "../src/Typecheck.ts"
import * as TypedocDocumentation from "../src/TypedocDocumentation.ts"
import * as VitestBench from "../src/VitestBench.ts"
import * as VitestCoverage from "../src/VitestCoverage.ts"
import * as VitestWatch from "../src/VitestWatch.ts"
import * as WorkspaceDeclaration from "../src/WorkspaceDeclaration.ts"
import { plannedCalls, plannedValue } from "./plan.ts"
import { packageManager, runtime } from "./toolchain.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")
const fsExecutions = Math.min(executions, 25)

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

describe("@smthrs/targets WorkspaceDeclaration, AgentTarget, Cargo/Go/Docker/Nix/Foundry, Shell, SafeFs & rule catalog fuzz invariants", () => {
  it("WorkspaceDeclaration, AgentTarget, Config, RemoteCache, Runtime & PackageManager invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        wsName: Schema.Literals(["smithers", "demo-ws", "bad name", ""]),
        cacheDir: Schema.Literals([".flows", ".cache/smthrs", "../escape", "/abs/cache"]),
        mode: Schema.Literals(["check", "write"]),
        rounds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
        endpoint: Schema.Literals([
          "https://cache.example.com",
          "https://cache.example.com/v1/",
          "http://127.0.0.1:8787",
          "ftp://bad.example"
        ]),
        bunMode: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ wsName, cacheDir, mode, rounds, endpoint, bunMode }) =>
          Effect.sync(() => {
            const badCache = cacheDir.startsWith("..") || cacheDir.startsWith("/")
            try {
              const norm = Config.normalizeDeclaredCacheDirectory(cacheDir)
              if (badCache) throw new Error("expected badCache throw: " + cacheDir)
              if (Config.isOutsideCacheDirectory(norm)) throw new Error("expected inside: " + norm)
            } catch (e) {
              if (!badCache) throw e
            }

            const badEndpoint = endpoint.startsWith("ftp://") || endpoint.startsWith("http://")
            try {
              const normEp = RemoteCache.normalizeEndpoint(endpoint)
              if (badEndpoint) throw new Error("expected badEndpoint throw: " + endpoint)
              const rc = RemoteCache.make({ endpoint: normEp })
              if (!RemoteCache.isRemoteCache(rc)) throw new Error("not remoteCache")
            } catch (e) {
              if (!badEndpoint) throw e
            }
            const sc = RemoteCache.smithersCloud({ repo: "acme/app" })
            if (!RemoteCache.isRemoteCache(sc)) return false

            const rustTc = RustToolchain.Toolchain({ workspace: Input.file("//Cargo.toml"), channel: "1.91" })
            const cache = WorkspaceDeclaration.Cache({ directory: ".flows" })
            const host = WorkspaceDeclaration.Host({ bins: ["git", "jj"] })
            const flags = WorkspaceDeclaration.Flags({ release: "Release build" })
            const nm = WorkspaceDeclaration.NodeModules({ packageJson: Input.file("//package.json") })
            const sandboxes = WorkspaceDeclaration.Sandboxes({
              default: WorkspaceDeclaration.Sandbox.Bubblewrap(),
              none: WorkspaceDeclaration.Sandbox.None()
            })
            const remotes = WorkspaceDeclaration.Remotes({
              dev: WorkspaceDeclaration.Remote.Command({
                machines: [["ssh", "dev.internal"]],
                workdir: "/work",
                setup: []
              })
            })
            const agents = AgentTarget.Agents({
              default: AgentTarget.ClaudeCode({ model: "claude-opus-5-5" }),
              codex: AgentTarget.Codex({ model: "gpt-6-sol" }),
              pool: AgentTarget.Pool(["default", "codex"])
            })
            const teams = Owners.Teams({ core: ["alice", "bob"] })
            const localRepo = LocalRepository.make("../sibling")
            const mise = Mise.Mise({ config: Input.file("//mise.toml") })
            const depDoc = DependencyDocs.Package("effect")
            const mounts = Mount.Mounts({
              docs: Mount.Mount({
                repository: "https://example.invalid/repo.git",
                ref: "a".repeat(40),
                track: "main",
                drift: "refuse"
              })
            })
            if (
              !WorkspaceDeclaration.isCacheDeclaration(cache) ||
              !WorkspaceDeclaration.isHostDeclaration(host) ||
              !WorkspaceDeclaration.isFlagsDeclaration(flags) ||
              !WorkspaceDeclaration.isNodeModulesDeclaration(nm) ||
              !WorkspaceDeclaration.isSandboxesDeclaration(sandboxes) ||
              !WorkspaceDeclaration.isRemotesDeclaration(remotes) ||
              !AgentTarget.isAgentsDeclaration(agents) ||
              !Owners.isTeamsDeclaration(teams) ||
              !LocalRepository.isDeclaration(localRepo) ||
              !Mise.isDeclaration(mise) ||
              !DependencyDocs.isDeclaration(depDoc) ||
              !Mount.isMounts(mounts)
            ) {
              return false
            }

            const badWsName = wsName === "" || wsName.includes(" ")
            try {
              const ws = WorkspaceDeclaration.Workspace(wsName, {
                repository: "git+https://example.invalid/smithers.git",
                cache,
                host,
                flags,
                agents,
                teams,
                sandboxes,
                remotes,
                toolchains: [rustTc]
              })
              if (badWsName) return false
              if (!WorkspaceDeclaration.isWorkspaceDeclaration(ws)) return false
              if (!WorkspaceDeclaration.agentNames(ws).has("default")) return false
              if (!WorkspaceDeclaration.flagNames(ws).has("release")) return false
              if (!WorkspaceDeclaration.teamNames(ws).has("core")) return false
              if (WorkspaceDeclaration.rustToolchain(ws) === undefined) return false
            } catch {
              if (!badWsName) return false
            }

            const gate = Filegroup.Filegroup({ srcs: [Input.glob("src/**/*.ts")] })
            const aLint = AgentTarget.Lint({
              agent: AgentTarget.Agents["default"]!,
              prompt: Input.file("prompts/lint.md"),
              data: [Input.glob("src/**/*.ts")]
            })
            const aDiff = AgentTarget.Diff({
              agent: AgentTarget.Agents["codex"]!,
              prompt: Input.file("prompts/diff.md"),
              data: [Input.glob("src/**/*.ts")],
              changes: ["src/**"],
              gates: [gate],
              maxRounds: rounds
            })
            const aPr = AgentTarget.Pr({
              agent: AgentTarget.Agents["pool"]!,
              prompt: Input.file("prompts/pr.md"),
              data: [Input.glob("src/**/*.ts")],
              changes: ["src/**"],
              gates: [gate],
              maxRounds: rounds
            })
            if (!Target.isTarget(aLint) || !Target.isTarget(aDiff) || !Target.isTarget(aPr)) return false
            if (
              plannedCalls(aLint).length === 0 || plannedCalls(aDiff).length === 0 || plannedCalls(aPr).length === 0
            ) {
              return false
            }
            if (AgentTarget.targetIdentity(aLint).length === 0) return false

            const bunRt = Runtime.Bun({ version: ">=1.4.0" })
            const rt = bunMode ? bunRt : runtime
            const pm = bunMode
              ? PackageManager.Pnpm({ version: "11.25.0", runtime })
              : packageManager
            const yarnDecl = PackageManager.Yarn({
              manifest: Input.file("//package.json"),
              lockfile: Input.file("//yarn.lock")
            })
            if (!PackageManager.isYarnDeclaration(yarnDecl)) return false
            if (!Runtime.isRuntime(rt) || !PackageManager.isPackageManager(pm)) return false
            if (PackageManager.lockfileName(pm).length === 0) return false
            if (PackageManager.exec(pm, ["vitest", "run"]).length === 0) return false
            if (PackageManager.install(pm).length === 0) return false
            if (Runtime.run(rt, ["script.ts", "--flag"]).length === 0) return false
            if (Runtime.evaluate(rt, "1+1").length === 0) return false
            void mode
            return true
          }),
        { executions, seed: seed + 20 }
      )
    )
    assertPassed(report)
  })

  it("Cargo, RustToolchain, Go, Docker, Nix, Foundry, BundlerTarget, Shell & target rule catalog fuzz invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals(["check", "write", "execute"]),
        bundlerMode: Schema.Literals(["development", "production"]),
        durationStr: Schema.Literals(["30s", "5m", "1h", "500ms"]),
        crateName: Schema.Literals(["smthrs-core", "smthrs-cli", "smthrs-bench"]),
        goPkg: Schema.Literals(["./...", "./cmd/server", "./internal/api"]),
        exclusive: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ mode, bundlerMode, durationStr, crateName, goPkg, exclusive }) =>
          Effect.sync(() => {
            const pinned = RustToolchain.Pinned({})
            if (RustToolchain.cargo(pinned, ["build"]).length === 0) throw new Error("rust cargo")
            const rustTc = RustToolchain.Toolchain({ workspace: Input.file("//Cargo.toml"), channel: "1.91" })
            if (RustToolchain.toolchainIdentity(rustTc) === undefined) throw new Error("rust tcId")
            if (RustToolchain.toolchainInputs(rustTc).length === 0) throw new Error("rust tcIn")

            const fetchT = Cargo.Fetch({
              workspace: Input.file("//Cargo.toml"),
              outFiles: ["//Cargo.lock"],
              outDirs: ["//.cargo-home"],
              sandbox: { network: true }
            })
            const buildT = Cargo.Build({ package: crateName })
            const testT = Cargo.Test({ package: crateName })
            const nextestT = Cargo.Nextest({ package: crateName })
            const clippyT = Cargo.Clippy({ package: crateName })
            const fmtT = Cargo.Fmt({ workspace: true })
            const docT = Cargo.Doc({ package: crateName })
            const denyT = Cargo.Deny({ config: Input.file("//deny.toml") })
            const appSet = Cargo.AppSet({ manifests: Input.glob("crates/*/Cargo.toml") })
            if (!Cargo.isAppSet(appSet)) throw new Error("isAppSet")
            for (const t of [fetchT, buildT, testT, nextestT, clippyT, fmtT, docT, denyT]) {
              const meta = Target.metadata(t as never)
              const args = Cargo.packageArgs(
                meta.target,
                meta.attrs as Record<string, unknown>,
                { _tag: "Package", name: crateName },
                mode
              )
              if (args.length === 0) throw new Error("cargo args empty for " + meta.target)
            }
            const filter = Cargo.appSetFilter(appSet)
            Cargo.metadataMatches(filter, { name: crateName, manifest_path: "/ws/Cargo.toml", targets: [] })
            Cargo.binaries({ name: crateName, targets: [{ kind: ["bin"], name: crateName }] })

            const goTc = Go.Toolchain({
              mod: Input.file("go.mod"),
              sum: Input.file("go.sum"),
              versions: Mise.Mise({ config: Input.file("//mise.toml") })
            })
            const goPkgs = Go.Packages({ pkgs: [goPkg] })
            const goTest = Go.Test({ pkgs: [goPkg] })
            const goMod = Go.ModDownload({
              mod: Input.file("go.mod"),
              sum: Input.file("go.sum"),
              outDirs: [".go-cache"]
            })
            const goLint = Go.Lint({ pkgs: [goPkg], config: Input.file(".golangci.yml"), version: "v2.0.0" })
            const goGen = Go.Generate({ pkgs: [goPkg], changes: ["gen/**"] })
            const ld = Go.ldflags({ strip: true, stamp: { "main.Version": Stamp.version } })
            if (ld.length === 0) throw new Error("Go.ldflags empty")
            void goTc
            for (const t of [goPkgs, goTest, goMod, goLint, goGen]) {
              if (!Target.isTarget(t)) throw new Error("go target")
            }

            const dBuild = Docker.Build({ dockerfile: Input.file("Dockerfile"), context: "." })
            const dBake = Docker.Bake({ config: Input.file("docker-bake.hcl"), target: "app" })
            const dServe = Docker.Serve({ image: "postgres:18", ports: { pg: 5432 } })
            const dPush = Docker.Push({
              image: dBuild,
              registry: "ghcr.io",
              name: "smithersai/app",
              tags: ["latest"],
              approval: "required"
            })
            if (Docker.imageOutputPath("app", ["//apps/api", "image"]).length === 0) throw new Error("imageOutputPath")
            for (const t of [dBuild, dBake, dServe, dPush]) {
              if (!Target.isTarget(t)) throw new Error("docker target")
            }

            const nixEnv = Nix.Environment({ flake: Input.file("flake.nix"), lock: Input.file("flake.lock") })
            if (!Nix.isEnvironment(nixEnv)) throw new Error("nixEnv")
            if (Nix.developArguments(nixEnv).length === 0) throw new Error("nix developArgs")
            if (Nix.environmentInputs(nixEnv).length === 0) throw new Error("nix envInputs")
            if (Nix.flakeDirectory(nixEnv) === undefined) throw new Error("nix flakeDir")

            const fTc = Foundry.Toolchain({ config: Input.file("foundry.toml") })
            const fBuild = Foundry.Build({ outDirs: ["out"] })
            const fTest = Foundry.Test({})
            const fFmt = Foundry.Fmt({ changes: ["src/**/*.sol"] })
            if (!Foundry.isToolchainDeclaration(fTc)) throw new Error("foundry tc")
            for (const t of [fBuild, fTest, fFmt]) {
              if (!Target.isTarget(t)) throw new Error("foundry target")
            }

            const rspack = BundlerTarget.Rspack({ config: Input.file("rspack.config.ts") })
            const bRes = rspack.resolve({ entries: ["src/index.ts"], universe: [Input.glob("src/**/*.ts")] })
            const bBuild = rspack.build({
              environment: "web",
              mode: bundlerMode,
              graph: bRes,
              outDirs: ["dist"]
            })
            if (!Target.isTarget(bRes) || !Target.isTarget(bBuild)) throw new Error("bundler target")
            const gd1 = BundlerTarget.graphDigest({
              files: [
                { path: "src/a.ts", digest: "a".repeat(64) },
                { path: "src/b.ts", digest: "b".repeat(64) }
              ],
              packages: ["a", "b"]
            })
            const gd2 = BundlerTarget.graphDigest({
              files: [
                { path: "src/a.ts", digest: "a".repeat(64) },
                { path: "src/b.ts", digest: "b".repeat(64) }
              ],
              packages: ["a", "b"]
            })
            const gd3 = BundlerTarget.graphDigest({
              files: [
                { path: "src/a.ts", digest: "c".repeat(64) },
                { path: "src/b.ts", digest: "b".repeat(64) }
              ],
              packages: ["a", "b"]
            })
            if (gd1 !== gd2 || gd1 === gd3) throw new Error("graphDigest determinism")
            if (Shell.durationMs(durationStr) <= 0) throw new Error("durationMs")
            const shBuild = Shell.Build({
              shell: "echo build",
              data: [Input.file("src/a.ts")],
              outFiles: ["dist/a.js"],
              timeout: durationStr,
              ...(exclusive ? { exclusive: true as const } : {})
            })
            const shTest = Shell.Test({ shell: "echo test", timeout: durationStr })
            const shRun = Shell.Run({ shell: "echo run" })
            const shServe = Shell.Serve({ shell: "echo serve" })
            const shDiff = Shell.Diff({ shell: "echo diff", changes: ["src/**"] })
            for (const t of [shBuild, shTest, shRun, shServe, shDiff]) {
              if (plannedCalls(t).length === 0) throw new Error("sh plannedCalls: " + Target.metadata(t).target)
            }

            const nodeTestTarget = NodeTest.NodeTest({
              runtime,
              runner: NodeTest.testRunner([Input.file("test/a.test.ts")]),
              srcs: [Input.glob("src/**/*.ts")],
              deps: []
            })
            const nodeBenchTarget = NodeBench.NodeBench({
              runtime,
              entry: Input.file("bench/run.ts"),
              srcs: [Input.glob("src/**/*.ts")],
              deps: []
            })
            const nodeBinTarget = NodeBinary.NodeBinary({
              runtime,
              entry: Input.file("src/cli.ts"),
              args: [],
              srcs: [Input.glob("src/**/*.ts")],
              deps: []
            })
            const biomeT = BiomeCheck.BiomeCheck({
              packageManager,
              sources: [Input.glob("src/**/*.ts")],
              config: Input.file("biome.json"),
              lint: true,
              format: true,
              deps: []
            })
            const bunSuiteT = BunSuite.BunSuite({
              tests: Input.glob("test/**/*.test.ts"),
              sources: Input.glob("src/**/*.ts"),
              deps: [],
              cwd: "."
            })
            const csVer = ChangesetsTarget.Version({
              config: Input.file(".changeset/config.json"),
              changes: ["CHANGELOG.md"]
            })
            const npmPackT = NpmTarget.Pack({ manifest: Input.file("package.json") })
            const csPub = ChangesetsTarget.Publish({
              config: Input.file(".changeset/config.json"),
              pack: npmPackT,
              gates: [shTest]
            })
            const cronT = CronTarget.Cron({ schedule: "0 * * * *", run: [shTest] })
            const depsLintT = DepsLint.DepsLint({
              runtime,
              packageManager,
              packageJson: Input.file("package.json"),
              sources: [Input.glob("src/**/*.ts")],
              tool: "knip",
              ignoreDependencies: [],
              ignoreBinaries: [],
              deps: []
            })
            const devT = Dev.Dev({
              command: "vite",
              args: [],
              inputs: [Input.file("index.html")],
              cwd: ".",
              readyWhen: null,
              deps: []
            })
            const dprintT = Dprint.Dprint({
              packageManager,
              config: Input.file("dprint.json"),
              sources: [Input.glob("src/**/*.ts")],
              fix: false,
              deps: []
            })
            const dtsT = DtsBuild.DtsBuild({
              packageManager,
              srcs: [Input.glob("src/**/*.ts")],
              entries: [Input.file("src/index.ts")],
              tsconfig: Input.file("tsconfig.json"),
              tool: { name: "tsc", declarationMap: false },
              outDir: "dist/types",
              deps: []
            })
            const envT = Environment.Toolchain({
              downloads: {
                tool: { version: "1.0.0", url: "https://example.com/tool.tgz", sha256: "a".repeat(64) }
              },
              destinations: ["example.com"]
            })
            const esLintT = EsLint.EsLint({
              packageManager,
              sources: [Input.glob("src/**/*.ts")],
              configs: [Input.file("eslint.config.js")],
              maxWarnings: 0,
              fix: false,
              deps: []
            })
            const faultT = FaultSuite.FaultSuite({
              packageManager,
              tests: Input.glob("test/**/*.test.ts"),
              sources: Input.glob("src/**/*.ts"),
              config: Input.file("vitest.config.ts"),
              cwd: ".",
              deps: []
            })
            const fetchUrlT = Fetch.Fetch({
              url: "https://example.com/archive.tar.gz",
              sha256: "a".repeat(64),
              out: "vendor/archive.tar.gz"
            })
            const gitCommitT = GitTarget.Commit({ message: "chore: update", gates: [shTest] })
            const jsrT = JsrPublish.JsrPublish({
              packageManager,
              config: Input.file("jsr.json"),
              sources: [Input.glob("src/**/*.ts")],
              package: "@fuzz/demo",
              cliVersion: "0.13.4",
              allowDirty: false,
              deps: []
            })
            const lockT = Lockfile.Lockfile({ packageManager })
            const memT = MemoryTarget.Retain({ source: Reference.gitCommit("HEAD"), tags: ["bench"] })
            const npmPubT = NpmPublish.NpmPublish({
              packageManager,
              packageJson: Input.file("package.json"),
              artifacts: [Input.glob("dist/**")],
              registry: "https://registry.npmjs.org",
              access: "public",
              tag: "latest",
              provenance: false,
              deps: []
            })
            const repoT = RepoTarget.Target(LocalRepository.make("../upstream"), "//:build")
            const skillsT = Skills.Install({
              library: Skills.Library({ root: "skills" }),
              agents: ["claude"]
            })
            const sortPkgT = SortPackageJson.SortPackageJson({
              packageManager,
              manifests: [Input.file("package.json")],
              check: true,
              deps: []
            })
            const toolRunT = ToolRun.ToolRun({
              command: "tsx",
              args: ["src/index.ts"],
              inputs: [Input.file("src/index.ts")],
              deps: []
            })
            const tcT = Typecheck.Typecheck({
              packageManager,
              srcs: [Input.glob("src/**/*.ts")],
              tsconfig: Input.file("tsconfig.json"),
              buildMode: false,
              incremental: false,
              deps: []
            })
            const typedocT = TypedocDocumentation.TypedocDocs({
              packageManager,
              sources: [Input.glob("src/**/*.ts")],
              entryPoints: [Input.file("src/index.ts")],
              tsconfig: Input.file("tsconfig.json"),
              config: null,
              outDir: "docs/api",
              plugin: [],
              deps: []
            })
            const vBenchT = VitestBench.VitestBench({
              packageManager,
              benches: [Input.glob("test/**/*.bench.ts")],
              sources: [Input.glob("src/**/*.ts")],
              config: Input.file("vitest.config.ts"),
              deps: []
            })
            const vCovT = VitestCoverage.VitestCoverage({
              packageManager,
              tests: [Input.glob("test/**/*.test.ts")],
              sources: [Input.glob("src/**/*.ts")],
              config: Input.file("vitest.config.ts"),
              provider: "v8",
              reportsDirectory: "coverage",
              thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
              deps: []
            })
            const vWatchT = VitestWatch.VitestWatch({
              packageManager,
              tests: [Input.glob("test/**/*.test.ts")],
              sources: [Input.glob("src/**/*.ts")],
              config: Input.file("vitest.config.ts"),
              environment: "node",
              deps: []
            })
            const anvilT = Anvil.Fork({ forkUrl: Secret.Secret("RPC_URL"), forkBlockNumber: "latest", port: 8545 })
            const copyT = NodeArtifact.Copy({ from: Input.file("src/a.ts"), to: "dist/a.ts" })
            const litT = NodeArtifact.Literal({ path: "dist/version.txt", content: "1.0.0\n" })
            const pkgDecl = Package.Package({ targets: { build: shBuild, test: shTest } })
            const pkgLintT = PackageLint.PackageLint({
              packageManager,
              packageJson: Input.file("package.json"),
              artifacts: [Input.glob("dist/**")],
              strict: true,
              pack: false,
              attw: false,
              deps: []
            })

            if (!Package.isPackage(pkgDecl)) throw new Error("isPackage")
            if (!Fetch.isFetch(fetchUrlT) || !Fetch.fetchAttrsOf(fetchUrlT)) throw new Error("fetch")
            if (!CronTarget.attrsOf(cronT) || !RepoTarget.attrsOf(repoT) || !MemoryTarget.retainAttrsOf(memT)) {
              throw new Error("attrsOf")
            }
            if (!GitTarget.commitAttrsOf(gitCommitT)) throw new Error("gitCommit")
            if (!Environment.toolchainData(Target.metadata(envT).attrs as Environment.ToolchainAttrs)) {
              throw new Error("toolchainData")
            }
            for (const t of [shBuild, shTest, shRun, shServe, shDiff]) {
              if (plannedCalls(t).length === 0) throw new Error("shell plannedCalls")
            }

            for (
              const t of [
                nodeTestTarget,
                nodeBenchTarget,
                nodeBinTarget,
                biomeT,
                bunSuiteT,
                csVer,
                csPub,
                depsLintT,
                devT,
                dprintT,
                dtsT,
                esLintT,
                faultT,
                jsrT,
                lockT,
                npmPubT,
                npmPackT,
                skillsT,
                sortPkgT,
                toolRunT,
                tcT,
                typedocT,
                vBenchT,
                vCovT,
                vWatchT,
                anvilT,
                copyT,
                litT,
                pkgLintT
              ]
            ) {
              if (!Target.isTarget(t)) return false
              plannedValue(t, (call) =>
                call.action === "smithers-build/filegroup"
                  ? [{ path: "src/a.ts", digest: "a".repeat(64) }]
                  : call)
            }

            const cloned = ManifestJson.cloneObject({ a: 1, b: [true, "x"], c: { nested: null } })
            if (JSON.stringify(cloned) !== JSON.stringify({ a: 1, b: [true, "x"], c: { nested: null } })) {
              throw new Error("cloneObject")
            }
            const refErr = Outward.refuse(
              { rule: "Npm.Publish", required: ["NPM_TOKEN"], declared: undefined, approval: "required" },
              { approvalGranted: false }
            )
            if (refErr === undefined || !Outward.isRefused(refErr)) throw new Error("Outward.refuse")
            return true
          }),
        { executions: Math.min(executions, 80), seed: seed + 21 }
      )
    )
    assertPassed(report)
  })

  it("SafeFs containment, digestIndex, syncDirectory, Input walk/glob/digestFiles & NearestRealpath/ImportProbe fuzz invariants", async () => {
    const tmpRoot = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-targets-safefs-")))
    try {
      await Fs.mkdir(NodePath.join(tmpRoot, "src/sub"), { recursive: true })
      await Fs.writeFile(NodePath.join(tmpRoot, "src/a.ts"), "export const a = 1\n", "utf8")
      await Fs.writeFile(NodePath.join(tmpRoot, "src/sub/b.ts"), "export const b = 2\n", "utf8")
      await Fs.writeFile(NodePath.join(tmpRoot, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n", "utf8")
      await Fs.mkdir(NodePath.join(tmpRoot, "packages/p1"), { recursive: true })
      await Fs.writeFile(NodePath.join(tmpRoot, "packages/p1/package.json"), "{\"name\":\"p1\"}\n", "utf8")

      const arb = Arbitrary.schema(
        Schema.Struct({
          content: Schema.String.check(Schema.isMaxLength(150)),
          fileIdx: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
          probeOut: Schema.Literals(["resolved file:///a.ts", "missing", "unexpected"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ content, fileIdx, probeOut }) =>
            Effect.gen(function*() {
              const safeText = content.replace(/[\uD800-\uDFFF]/g, "")
              const srcDir = NodePath.join(tmpRoot, `sync-src-${fileIdx}`)
              const itemPath = NodePath.join(srcDir, "item.txt")
              yield* Effect.promise(() => Fs.mkdir(srcDir, { recursive: true }))
              yield* Effect.promise(() => Fs.writeFile(itemPath, safeText, "utf8"))

              const resolved = yield* Effect.promise(() => SafeFs.resolveFile(itemPath, { root: tmpRoot }))
              if (resolved === undefined) return false
              const readBack = yield* Effect.promise(() => SafeFs.readText(itemPath, { root: tmpRoot }))
              if (readBack !== safeText) return false

              const d1 = yield* Effect.promise(() => SafeFs.digestFile(itemPath, { root: tmpRoot }))
              const d2 = yield* Effect.promise(() => SafeFs.digestFile(itemPath, { root: tmpRoot }))
              if (d1 === undefined || d1 !== d2) return false

              const dirEntry = yield* Effect.promise(() => SafeFs.resolveDirectory(srcDir, { root: tmpRoot }))
              if (dirEntry === undefined) return false
              const entries = yield* Effect.promise(() => SafeFs.listDirectory(srcDir, dirEntry, { root: tmpRoot }))
              if (entries.length === 0) return false
              yield* Effect.promise(() => SafeFs.syncDirectory(srcDir))

              if (SafeFs.inside(tmpRoot, NodePath.resolve(tmpRoot, "../outside"))) return false
              const escExit = yield* Effect.exit(
                Effect.promise(() => SafeFs.resolveFile(NodePath.resolve(tmpRoot, "../outside.txt"), { root: tmpRoot }))
              )
              if (escExit._tag !== "Failure") return false

              const walkCache = Input.makeWalkCache()
              const expanded = yield* Effect.promise(() =>
                Input.expandGlob(tmpRoot, "", Input.glob("src/**/*.ts"), { walks: walkCache })
              )
              if (expanded.length < 2) return false
              const digests = yield* Effect.promise(() => Input.digestFiles(tmpRoot, expanded))
              if (digests.length !== expanded.length) return false
              const wsPkgs = yield* Effect.promise(() =>
                Input.expandPnpmWorkspace(tmpRoot, "", Input.pnpmWorkspace("pnpm-workspace.yaml"))
              )
              if (!wsPkgs.some((p) => p.includes("packages/p1"))) return false

              const nr = NearestRealpath.resolve(
                {
                  realpath: NodeFs.realpathSync,
                  dirname: NodePath.dirname,
                  basename: NodePath.basename,
                  resolve: NodePath.resolve,
                  errorCode: SafeFs.errorCode
                },
                NodePath.join(tmpRoot, "src/nonexistent/deep/file.ts")
              )
              if (!nr.startsWith(tmpRoot)) return false
              const parsedProbe = ImportProbe.parse(null, probeOut, "")
              if (probeOut === "missing" && parsedProbe.kind !== "missing") return false
              if (probeOut.startsWith("resolved ") && parsedProbe.kind !== "resolved") return false
              if (probeOut === "unexpected" && parsedProbe.kind !== "failed") return false
              return true
            }),
          { executions: fsExecutions, seed: seed + 22 }
        )
      )
      assertPassed(report)
    } finally {
      await Fs.rm(tmpRoot, { recursive: true, force: true })
    }
  })
})
