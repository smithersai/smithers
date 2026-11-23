import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Schema } from "effect"
import { spawnSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Cargo from "../src/Cargo.ts"
import * as Compose from "../src/Compose.ts"
import * as Exec from "../src/Exec.ts"
import * as Filegroup from "../src/Filegroup.ts"
import * as GithubWorkflow from "../src/GithubWorkflow.ts"
import * as Input from "../src/Input.ts"
import * as Nix from "../src/Nix.ts"
import * as Owners from "../src/Owners.ts"
import * as PackageJson from "../src/PackageJson.ts"
import * as PackageJsonTemplate from "../src/PackageJsonTemplate.ts"
import * as RustToolchain from "../src/RustToolchain.ts"
import * as SafeFs from "../src/SafeFs.ts"
import * as Secret from "../src/Secret.ts"
import * as Shell from "../src/Shell.ts"
import * as Target from "../src/Target.ts"
import * as WorkspaceDeclaration from "../src/WorkspaceDeclaration.ts"
import { plannedCalls } from "./plan.ts"
import { packageManager, runtime } from "./toolchain.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261128")
const fsExecutions = Math.min(executions, 20)

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

describe("@smthrs/targets deep fuzz suite 4: GithubWorkflow, Input/SafeFs/Filegroup, WorkspaceDeclaration/Owners/Target, PackageJson/Template/Cargo & Confined Exec", () => {
  it("GithubWorkflow strict parser, shell analysis, gates, required jobs & install detection fuzz invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        yamlCase: Schema.Literals([
          "valid-full",
          "valid-matrix-services",
          "dup-key",
          "anchor-alias",
          "merge-key",
          "empty-doc",
          "non-mapping-root",
          "bad-jobs-scalar",
          "bad-steps-scalar",
          "bad-yaml-syntax",
          "multi-doc"
        ]),
        shellCase: Schema.Literals([
          "pnpm install --frozen-lockfile && pnpm run test",
          "# comment\npnpm install --frozen-lockfile\nbun test # trailing",
          "if true; then npm ci; fi | cat",
          "echo 'pnpm install' && \"bun install\"",
          "FOO=1 BAR=2 cargo test --workspace",
          "yarn install --immutable; smthrs ci"
        ]),
        cond: Schema.Literals([
          "",
          "always()",
          "!cancelled()",
          "!cancelled() && steps.setup.conclusion == 'success'",
          "github.event_name == 'push'",
          "false",
          "failure()"
        ]),
        shellName: Schema.Literals(["", "bash", "sh", "pwsh", "python", "bash -e {0}"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ yamlCase, shellCase, cond, shellName }) =>
          Effect.sync(() => {
            const yaml =
              yamlCase === "valid-full"
                ? [
                  "name: CI",
                  "on:",
                  "  push:",
                  "    branches: [main]",
                  "  pull_request:",
                  "permissions:",
                  "  contents: read",
                  "concurrency:",
                  "  group: ci-${{ github.ref }}",
                  "  cancel-in-progress: true",
                  "jobs:",
                  "  check:",
                  "    runs-on: ubuntu-latest",
                  "    timeout-minutes: 30",
                  "    steps:",
                  "      - uses: actions/checkout@v4",
                  "      - id: setup",
                  "        run: pnpm install --frozen-lockfile",
                  "      - if: \"!cancelled() && steps.setup.conclusion == 'success'\"",
                  "        run: pnpm run ci"
                ].join("\n")
                : yamlCase === "valid-matrix-services"
                ? [
                  "name: Matrix",
                  "on: [push, workflow_dispatch]",
                  "jobs:",
                  "  build:",
                  "    runs-on: ubuntu-latest",
                  "    strategy:",
                  "      fail-fast: false",
                  "      matrix:",
                  "        os: [ubuntu-latest, macos-latest]",
                  "    steps:",
                  "      - uses: actions/checkout@v4",
                  "        with:",
                  "          fetch-depth: 0",
                  "      - shell: bash",
                  "        working-directory: packages/a",
                  "        env:",
                  "          CI: 'true'",
                  "        run: |",
                  "          # run tests",
                  "          bun install --frozen-lockfile",
                  "          bun test"
                ].join("\n")
                : yamlCase === "dup-key"
                ? "name: A\nname: B\non: push\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps: []\n"
                : yamlCase === "anchor-alias"
                ? "name: A\non: push\ndefaults: &d\n  run:\n    shell: bash\njobs:\n  j:\n    defaults: *d\n    runs-on: ubuntu-latest\n    steps: []\n"
                : yamlCase === "merge-key"
                ? "name: A\non: push\nbase: &b\n  runs-on: ubuntu-latest\njobs:\n  j:\n    <<: *b\n    steps: []\n"
                : yamlCase === "empty-doc"
                ? ""
                : yamlCase === "non-mapping-root"
                ? "- item1\n- item2\n"
                : yamlCase === "bad-jobs-scalar"
                ? "name: A\non: push\njobs: 42\n"
                : yamlCase === "bad-steps-scalar"
                ? "name: A\non: push\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps: nope\n"
                : yamlCase === "multi-doc"
                ? "name: A\n---\nname: B\n"
                : "name: [unclosed\n"

            const valid = yamlCase === "valid-full" || yamlCase === "valid-matrix-services"
            try {
              const wf = GithubWorkflow.parseWorkflow(yaml)
              if (!valid) throw new Error(`expected parseWorkflow to reject ${yamlCase}`)
              const missingJobs = GithubWorkflow.missingRequiredJobs(wf, ["check", "missing-job"])
              if (!missingJobs.includes("missing-job")) throw new Error("missingRequiredJobs")
              const missingG = GithubWorkflow.missingGates(wf, [
                { name: "ci", command: "pnpm run ci" },
                { name: "other", command: "cargo test" }
              ])
              if (!Array.isArray(missingG)) throw new Error("missingGates")
            } catch (e) {
              if (valid) throw e
              if (!(e instanceof GithubWorkflow.WorkflowParseError)) throw e
            }

            // Shell analysis & install helpers
            const stripped = GithubWorkflow.stripShellComments(shellCase)
            if (typeof stripped !== "string") throw new Error("stripShellComments")
            const spans = GithubWorkflow.commandSpans(shellCase)
            const starts = GithubWorkflow.commandStarts(shellCase)
            if (spans.length !== starts.length) throw new Error("spans/starts length")
            void GithubWorkflow.runsCommand(shellCase, "pnpm run test")
            void GithubWorkflow.runsCommand(shellCase, "cargo test")
            void GithubWorkflow.usesAction("actions/checkout@v4", "actions/checkout")
            void GithubWorkflow.usesAction("actions/setup-node@v4", "actions/checkout")
            void GithubWorkflow.alwaysRuns(cond === "" ? undefined : cond)
            void GithubWorkflow.executesRunScript(shellName === "" ? undefined : shellName)
            for (const inst of GithubWorkflow.supportedInstallCommands) {
              if (!GithubWorkflow.isSupportedInstall(inst)) throw new Error("isSupportedInstall")
              void GithubWorkflow.workspaceExec(inst)
              void GithubWorkflow.performsInstall(shellCase, inst)
            }
            if (GithubWorkflow.supportedInstallOf("unknown-cmd") !== undefined) throw new Error("unknown install")
            return true
          }),
        { executions, seed }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("Input glob/walkCache/discover/output/pnpmWorkspace/links/digests, SafeFs resolve/digestIndex/readText/syncDirectory & Filegroup fuzz invariants", async () => {
    const tmpRoot = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-targets-input-")))
    const outside = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-targets-inputout-")))
    try {
      await Fs.mkdir(NodePath.join(tmpRoot, "packages/a/src"), { recursive: true })
      await Fs.mkdir(NodePath.join(tmpRoot, "packages/b/src"), { recursive: true })
      await Fs.mkdir(NodePath.join(tmpRoot, "patches"), { recursive: true })
      await Fs.mkdir(NodePath.join(tmpRoot, "out/nested"), { recursive: true })
      await Fs.mkdir(NodePath.join(tmpRoot, "sync-src/sub"), { recursive: true })
      await Fs.writeFile(NodePath.join(tmpRoot, "packages/a/PACKAGE.ts"), "export {}\n", "utf8")
      await Fs.writeFile(NodePath.join(tmpRoot, "packages/a/package.json"), JSON.stringify({ name: "a" }), "utf8")
      await Fs.writeFile(NodePath.join(tmpRoot, "packages/a/src/index.ts"), "export const a = 1\n", "utf8")
      await Fs.writeFile(NodePath.join(tmpRoot, "packages/b/PACKAGE.ts"), "export {}\n", "utf8")
      await Fs.writeFile(NodePath.join(tmpRoot, "packages/b/package.json"), JSON.stringify({ name: "b" }), "utf8")
      await Fs.writeFile(NodePath.join(tmpRoot, "packages/b/src/index.ts"), "export const b = 2\n", "utf8")
      await Fs.writeFile(NodePath.join(tmpRoot, "patches/foo.patch"), "diff --git a/x b/x\n", "utf8")
      await Fs.writeFile(
        NodePath.join(tmpRoot, "pnpm-workspace.yaml"),
        "packages:\n  - 'packages/*'\npatchedDependencies:\n  foo@1.0.0: patches/foo.patch\n",
        "utf8"
      )
      await Fs.writeFile(NodePath.join(tmpRoot, "out/nested/artifact.js"), "console.log(1)\n", "utf8")
      await Fs.writeFile(NodePath.join(tmpRoot, "sync-src/a.txt"), "hello\n", "utf8")
      await Fs.writeFile(NodePath.join(tmpRoot, "sync-src/sub/b.txt"), "world\n", "utf8")
      await Fs.writeFile(NodePath.join(outside, "secret.txt"), "outside\n", "utf8")
      await Fs.symlink(NodePath.join(tmpRoot, "packages/a/src/index.ts"), NodePath.join(tmpRoot, "packages/a/src/link-in.ts"))
      await Fs.symlink(NodePath.join(outside, "secret.txt"), NodePath.join(tmpRoot, "packages/a/src/link-out.ts"))

      const arb = Arbitrary.schema(
        Schema.Struct({
          pattern: Schema.Literals([
            "packages/a/src/**/*.ts",
            "packages/*/src/*.ts",
            "out/**",
            "missing/**/*.ts"
          ]),
          useCache: Schema.Boolean,
          linkType: Schema.Literals(["inside", "outside", "missing"]),
          gitBase: Schema.Literals(["origin/main", "HEAD", "HEAD~1", "-badflag", "a\u0000b", ""]),
          syncVariant: Schema.Literals(["fresh", "update", "prune"])
        })
      )

      let idx = 0
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ pattern, useCache, linkType, gitBase, syncVariant }) =>
            Effect.promise(async () => {
              const cache = useCache ? Input.makeWalkCache() : undefined
              const root = await SafeFs.canonicalRoot(tmpRoot)

              // 1. Input.expandGlob (including GlobCrossesPackage boundary)
              if (pattern.startsWith("packages/")) {
                try {
                  await Input.expandGlob(root, "", Input.glob(pattern), { walks: cache })
                } catch (e) {
                  // Expected GlobCrossesPackage when crossing PACKAGE.ts boundaries
                  void e
                }
              } else {
                const expanded = await Input.expandGlob(root, "", Input.glob(pattern, { exclude: ["**/*.d.ts"] }), {
                  walks: cache
                })
                if (useCache) {
                  const again = await Input.expandGlob(root, "", Input.glob(pattern, { exclude: ["**/*.d.ts"] }), {
                    walks: cache
                  })
                  if (again.length !== expanded.length) throw new Error("walkCache mismatch")
                }
              }

              // 2. discoverFiles, listOutputFiles, expandPnpmWorkspace, nodeModulesPaths
              const discovered = await Input.discoverFiles(root, { globs: [Input.glob("out/**")] } as never)
              if (discovered.length < 2) throw new Error("discoverFiles")
              const outputs = await Input.listOutputFiles(root, "out")
              if (outputs.length === 0) throw new Error("listOutputFiles")
              const wsFiles = await Input.expandPnpmWorkspace(root, "", Input.pnpmWorkspace("pnpm-workspace.yaml"))
              if (!wsFiles.some((p) => p.includes("package.json"))) throw new Error("expandPnpmWorkspace")
              const nmPaths = Input.nodeModulesPaths("packages/a", Input.nodeModules("."))
              if (nmPaths.tree.length === 0) throw new Error("nodeModulesPaths")
              void Input.staticPrefix(pattern)
              void Input.declaredDirectory("packages/a/src/index.ts", { packageDirectory: "" })
              void Input.rootRelative("packages/a", "src/index.ts")
              void Input.resolvePath("packages/a", "src/index.ts")
              void Input.resolvePath("packages/a", "//shared/x.ts")

              // 3. validateGitBase
              const validBase = gitBase === "origin/main" || gitBase === "HEAD" || gitBase === "HEAD~1"
              try {
                Input.validateGitBase(gitBase)
                if (!validBase) throw new Error(`should reject gitBase ${gitBase}`)
              } catch (e) {
                if (validBase) throw e
              }

              // 4. digestFile, digestFiles, digestLink
              const d1 = await Input.digestFile(NodePath.join(root, "packages/a/src/index.ts"), { workspaceRoot: root })
              if (!d1 || d1.length !== 64) throw new Error("digestFile")
              const dMany = await Input.digestFiles(root, ["packages/a/src/index.ts", "out/nested/artifact.js"])
              if (dMany.length !== 2) throw new Error("digestFiles")

              if (linkType === "inside") {
                const ld = await Input.digestLink(root, "packages/a/src/link-in.ts")
                if (!ld) throw new Error("digestLink inside")
              } else if (linkType === "outside") {
                let threw = false
                try {
                  await Input.digestLink(root, "packages/a/src/index.ts")
                } catch (e) {
                  if (e instanceof Input.LinkRefused) threw = true
                }
                if (!threw) throw new Error("expected LinkRefused for outside symlink")
              } else {
                const ld = await Input.digestLink(root, "packages/a/src/no-such-link.ts")
                if (ld === undefined) throw new Error("expected link result")
              }

              // 5. SafeFs resolveFile, resolveDirectory, listDirectory, makeDigestIndex, readText, syncDirectory
              const rf = await SafeFs.resolveFile(NodePath.join(root, "packages/a/src/index.ts"), { root })
              if (rf === undefined) throw new Error("SafeFs.resolveFile")
              const rd = await SafeFs.resolveDirectory(NodePath.join(root, "packages/a/src"), { root })
              if (rd === undefined) throw new Error("SafeFs.resolveDirectory")
              const entries = await SafeFs.listDirectory(rd.path, rd, { root })
              if (entries.length === 0) throw new Error("SafeFs.listDirectory")
              const txt = await SafeFs.readText(NodePath.join(root, "packages/a/src/index.ts"), { root })
              if (!txt || !txt.includes("export const a")) throw new Error("SafeFs.readText")
              let escapedText = false
              try {
                await SafeFs.readText(NodePath.join(root, "packages/a/src/link-out.ts"), { root })
              } catch {
                escapedText = true
              }
              if (!escapedText) throw new Error("SafeFs.readText should refuse outside symlink")

              const dIndex = SafeFs.makeDigestIndex()
              const de1 = await SafeFs.digestFile(NodePath.join(root, "packages/a/src/index.ts"), { root, digests: dIndex })
              const de2 = await SafeFs.digestFile(NodePath.join(root, "packages/a/src/index.ts"), { root, digests: dIndex })
              if (de1 !== de2) throw new Error("digestIndex mismatch")

              const syncDst = NodePath.join(tmpRoot, `sync-dst-${idx++}`)
              if (syncVariant === "update" || syncVariant === "prune") {
                await Fs.mkdir(NodePath.join(syncDst, "sub"), { recursive: true })
                await Fs.writeFile(NodePath.join(syncDst, "a.txt"), "stale\n", "utf8")
                if (syncVariant === "prune") {
                  await Fs.writeFile(NodePath.join(syncDst, "extra.txt"), "delete-me\n", "utf8")
                }
              }
              await SafeFs.syncDirectory(NodePath.join(tmpRoot, "sync-src"))
              await SafeFs.syncDirectory(NodePath.join(tmpRoot, "sync-src"), undefined, "win32")
              await Fs.rm(syncDst, { recursive: true, force: true })

              // 6. Filegroup
              const fg = Filegroup.Filegroup({
                cwd: "out",
                srcs: [Input.file("nested/artifact.js"), Input.glob("**/*.js")]
              })
              if (!Filegroup.isFilegroup(fg)) throw new Error("isFilegroup")
              const fgSources = Filegroup.sources(Target.metadata(fg).attrs as Filegroup.Attrs, { packageDirectory: "", label: "//:fg" } as never)
              if (fgSources.length !== 2) throw new Error("Filegroup sources")
              const fgExpanded = await Filegroup.expand(root, fgSources.map((entry) => entry.source))
              if (fgExpanded.length === 0) throw new Error("Filegroup expand")

              return true
            }),
          { executions: fsExecutions, seed: seed + 1 }
        )
      )
      assertPassed(report)
    } finally {
      await Fs.rm(tmpRoot, { recursive: true, force: true })
      await Fs.rm(outside, { recursive: true, force: true })
    }
  }, 120_000)

  it("WorkspaceDeclaration, Owners, Target helpers, PackageJson, PackageJsonTemplate & Cargo fuzz invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        pkgName: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{1,10}$/)),
        agentPolicy: Schema.Literals(["auto-land", "human-approve", "deny"]),
        remoteKind: Schema.Literals(["command", "http", "bad-http"]),
        sandboxKind: Schema.Literals(["bwrap", "docker", "microsandbox", "bad-docker"]),
        cargoRule: Schema.Literals(["build", "test", "clippy", "fmt", "doc", "deny", "fetch", "appset"]),
        badManagerField: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ pkgName, agentPolicy, remoteKind, sandboxKind, cargoRule, badManagerField }) =>
          Effect.sync(() => {
            const cmd = Shell.Test({ shell: "true" })

            // 1. Owners.Teams & Owners.declare
            const teams = Owners.Teams({ core: ["alice", "bob"], sec: ["carol"] })
            if (!Owners.isTeamsDeclaration(teams)) throw new Error("isTeamsDeclaration")
            const ownersDecl = Owners.declare({
              owners: ["team:core", "dave"],
              agents: {
                default: agentPolicy,
                "human-approve": ["src/auth/**"]
              },
              perFile: { "src/sec/**": ["team:sec"] },
              upstream: { mode: "review", packages: ["//packages/..."] }
            })
            if (!Owners.isDeclaration(ownersDecl)) throw new Error("isDeclaration")
            const refs = Owners.teamReferences(ownersDecl)
            if (!refs.includes("core") || !refs.includes("sec")) throw new Error("teamReferences")
            const coCalls = plannedCalls(Owners.Codeowners({ org: "demo" }))
            const trCalls = plannedCalls(Owners.Tree({}))
            if (coCalls.length === 0 || trCalls.length === 0) throw new Error("Owners targets")

            // 2. WorkspaceDeclaration full options (agents, flags, teams, owners, sandboxes, remotes, gitHooks, rust, nix)
            let sandboxDecl: WorkspaceDeclaration.SandboxDeclaration | undefined
            if (sandboxKind === "bwrap") {
              sandboxDecl = WorkspaceDeclaration.Sandbox.Bubblewrap()
            } else if (sandboxKind === "docker") {
              sandboxDecl = WorkspaceDeclaration.Sandbox.Docker({ image: "node:22-bookworm" })
            } else if (sandboxKind === "microsandbox") {
              sandboxDecl = WorkspaceDeclaration.Sandbox.Microsandbox({  })
            } else {
              let threw = false
              try {
                WorkspaceDeclaration.Sandbox.Docker({ image: "" })
              } catch {
                threw = true
              }
              if (!threw) throw new Error("expected bad docker image throw")
            }

            let remoteDecl: WorkspaceDeclaration.RemoteDeclaration | undefined
            if (remoteKind === "command") {
              remoteDecl = WorkspaceDeclaration.Remote.Command({
                machines: [["ssh", "box-1"], []],
                workdir: "/tmp/ci-work",
                setup: ["pnpm install --frozen-lockfile"]
              })
            } else if (remoteKind === "http") {
              remoteDecl = WorkspaceDeclaration.Remote.Http({
                url: "https://ci.example.com",
                token: Secret.Secret("CI_TOKEN"),
                machines: 4,
                workdir: "/tmp/ci-work"
              })
            } else {
              let threw = false
              try {
                WorkspaceDeclaration.Remote.Http({
                  url: "http://example.com",
                  token: Secret.Secret("CI_TOKEN"),
                  machines: 1,
                  workdir: "/work"
                })
              } catch {
                threw = true
              }
              if (!threw) throw new Error("expected non-https non-loopback throw")
            }

            if (sandboxDecl !== undefined && remoteDecl !== undefined) {
              const wsDecl = WorkspaceDeclaration.Workspace("fuzz-ws", {
                repository: "git+https://github.com/demo/repo.git",
                cache: WorkspaceDeclaration.Cache({ directory: ".flows" }),
                packageManager,
                runtime,
                nodeModules: WorkspaceDeclaration.NodeModules({ packageJson: Input.file("//package.json") }),
                teams,
                owners: ownersDecl,
                sandboxes: WorkspaceDeclaration.Sandboxes({ default: sandboxDecl }),
                remotes: WorkspaceDeclaration.Remotes({ ci: remoteDecl }),
                gitHooks: { preCommit: cmd, prePush: cmd },
                toolchains: [RustToolchain.Toolchain({ channel: "1.88.0" })],
                environment: Nix.Environment({ flake: Input.file("//flake.nix"), lock: Input.file("//flake.lock") })
              })
              if (!WorkspaceDeclaration.isWorkspaceDeclaration(wsDecl)) throw new Error("isWorkspaceDeclaration")
              void WorkspaceDeclaration.agentNames(wsDecl)
              void WorkspaceDeclaration.flagNames(wsDecl)
              const tNames = WorkspaceDeclaration.teamNames(wsDecl)
              if (!tNames.has("core")) throw new Error("teamNames")
              if (WorkspaceDeclaration.rustToolchain(wsDecl) === undefined) throw new Error("rustToolchain")
              if (WorkspaceDeclaration.nixEnvironment(wsDecl) === undefined) throw new Error("nixEnvironment")
            }

            // 3. Target helpers
            const sel = Target.subtree("//packages/...", "test")
            if (!Target.isDependencySelector(sel)) throw new Error("isDependencySelector")
            if (Target.declaredOutputFailure("packages/a", "dist") !== undefined) throw new Error("valid output")
            if (Target.declaredOutputFailure("packages/a", "../escape") === undefined) throw new Error("invalid output")
            const outs = Target.declaredOutputs("Test", { cwd: "packages/a", paths: ["dist", "build"] })
            if (Target.declaredOutputsFailure(outs) !== undefined) throw new Error("declaredOutputsFailure")
            void Target.splitPresentation({ summary: "A summary", manual: true, tags: ["fast"], x: 1 })

            // 4. PackageJsonTemplate & PackageJson
            if (badManagerField) {
              let threw = false
              try {
                PackageJsonTemplate.assertNotManagerOwned("template", { dependencies: { a: "1" } })
              } catch {
                threw = true
              }
              if (!threw) throw new Error("expected manager-owned field throw")
            } else {
              const tpl = PackageJsonTemplate.make({
                license: "MIT",
                sideEffects: false, fields: { customField: "ok" }
              })
              if (!PackageJsonTemplate.isTemplate(tpl)) throw new Error("isTemplate")
              const pj = PackageJson.PackageJson({
                name: `@fuzz/${pkgName}`,
                version: "1.0.0",
                description: "Fuzz package",
                license: "MIT",
                template: tpl,
                keywords: ["fuzz"],
                fields: { exports: { ".": "./dist/index.js" }, bin: { [pkgName]: "./dist/cli.js" }, files: ["dist"] },
                scripts: { test: cmd }
              })
              if (!PackageJson.isDeclaration(pj)) throw new Error("PackageJson.isDeclaration")
            }

            // 5. Cargo rules & metadata filtering
            const appSet = Cargo.AppSet({
              manifests: Input.glob("crates/*/Cargo.toml"),
              metadata: { deploy: { target: "fly" } }
            })
            if (!Cargo.isAppSet(appSet)) throw new Error("isAppSet")
            if (Cargo.appSetFilter(Target.metadata(appSet).attrs) === undefined) throw new Error("appSetFilter")
            if (!Cargo.metadataMatches({ deploy: { target: "fly", extra: 1 } }, { deploy: { target: "fly" } })) {
              throw new Error("metadataMatches true")
            }
            if (Cargo.metadataMatches({ deploy: { target: "aws" } }, { deploy: { target: "fly" } })) {
              throw new Error("metadataMatches false")
            }
            const manifestToml = "[package]\nname = \"app\"\nversion = \"0.1.0\"\n[[bin]]\nname = \"app-cli\"\n"
            const facts = Cargo.manifestFacts(manifestToml)
            if (facts.name !== "app") throw new Error("manifestFacts")

            const selWs = { _tag: "Workspace" } as const
            const selPkg = { _tag: "Package", name: "app" } as const
            if (cargoRule === "build") {
              const t = Cargo.Build({ package: "app", allFeatures: true })
              void Cargo.packageArgs("Cargo.Build", Target.metadata(t).attrs as Record<string, unknown>, selPkg, "execute")
            } else if (cargoRule === "test") {
              const t = Cargo.Test({ package: "app" })
              void Cargo.packageArgs("Cargo.Test", Target.metadata(t).attrs as Record<string, unknown>, selPkg, "execute")
            } else if (cargoRule === "clippy") {
              const t = Cargo.Clippy({ package: "app" })
              void Cargo.packageArgs("Cargo.Clippy", Target.metadata(t).attrs as Record<string, unknown>, selPkg, "check")
            } else if (cargoRule === "fmt") {
              const t = Cargo.Fmt({ workspace: true })
              void Cargo.packageArgs("Cargo.Fmt", Target.metadata(t).attrs as Record<string, unknown>, selPkg, "check")
              void Cargo.packageArgs("Cargo.Fmt", Target.metadata(t).attrs as Record<string, unknown>, selPkg, "write")
            } else if (cargoRule === "doc") {
              const t = Cargo.Doc({ package: "app" })
              void Cargo.packageArgs("Cargo.Doc", Target.metadata(t).attrs as Record<string, unknown>, selPkg, "execute")
            } else if (cargoRule === "deny") {
              const t = Cargo.Deny({ config: Input.file("deny.toml") })
              void Cargo.packageArgs("Cargo.Deny", Target.metadata(t).attrs as Record<string, unknown>, selWs, "execute")
            } else if (cargoRule === "fetch") {
              const t = Cargo.Fetch({ workspace: Input.file("//Cargo.toml"), outFiles: ["//Cargo.lock"], outDirs: ["//.cargo-home"], sandbox: { network: true } })
              void Cargo.packageArgs("Cargo.Fetch", Target.metadata(t).attrs as Record<string, unknown>, { _tag: "Manifest", path: "Cargo.toml" }, "execute")
            } else {
              const diff = Compose.Files.difference(appSet, appSet)
              void Cargo.selectionOf({ crates: diff })
            }

            return true
          }),
        { executions, seed: seed + 2 }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("Real bwrap confined Exec.run executes inside sandbox with stage, write protection & read-only enforcement", async () => {
    const bwrapPath = (() => {
      if (process.platform !== "linux") return undefined
      const found = spawnSync("sh", ["-c", "command -v bwrap"], { encoding: "utf8" }).stdout.trim()
      if (found === "") return undefined
      const tried = spawnSync(found, ["--dev-bind", "/", "/", "--unshare-pid", "--proc", "/proc", "--", "true"])
      return tried.status === 0 ? found : undefined
    })()
    if (bwrapPath === undefined) return

    const tmpRoot = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-targets-bwrap-")))
    try {
      await Fs.mkdir(NodePath.join(tmpRoot, "src"), { recursive: true })
      await Fs.mkdir(NodePath.join(tmpRoot, "dist"), { recursive: true })
      await Fs.writeFile(NodePath.join(tmpRoot, "src/in.txt"), "confined-data\n", "utf8")

      const arb = Arbitrary.schema(
        Schema.Struct({
          network: Schema.Literals([false, "loopback"]),
          writeOk: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ network, writeOk }) =>
            Effect.gen(function*() {
              const script = writeOk
                ? "const fs = require('node:fs'); const t = fs.readFileSync('src/in.txt','utf8'); fs.writeFileSync('dist/out.txt', t); process.stdout.write(t);"
                : "const fs = require('node:fs'); fs.writeFileSync('src/in.txt', 'illegal');"
              const exit = yield* Exec.run(
                {
                  workspaceRoot: tmpRoot,
                  sandbox: {
                    policy: { network },
                    reads: ["src/in.txt"],
                    writes: ["dist"]
                  }
                } as never,
                {
                  cwd: ".",
                  argv: [process.execPath, "-e", script],
                  env: {},
                  secrets: [],
                  expectedExitCodes: [0],
                  timeoutMs: 30_000
                }
              ).pipe(Effect.exit)
              if (network === false && writeOk) {
                if (Exit.isFailure(exit)) throw new Error(`confined writeOk failed: ${JSON.stringify(exit.cause)}`)
              } else if (network === "loopback" || !writeOk) {
                if (!Exit.isFailure(exit)) throw new Error("expected confined failure")
              }
              return true
            }),
          { executions: Math.min(executions, 6), seed: seed + 3 }
        )
      )
      assertPassed(report)
    } finally {
      await Fs.rm(tmpRoot, { recursive: true, force: true })
    }
  }, 120_000)
})
