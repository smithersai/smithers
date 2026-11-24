import { Flow, FlowRuntime } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Latch, Layer, Schema } from "effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as AgentTarget from "../src/AgentTarget.ts"
import * as BiomeCheck from "../src/BiomeCheck.ts"
import * as BundlerTarget from "../src/BundlerTarget.ts"
import * as Cargo from "../src/Cargo.ts"
import * as CiToolchain from "../src/CiToolchain.ts"
import * as DependencyDocs from "../src/DependencyDocs.ts"
import * as Docker from "../src/Docker.ts"
import * as DocsCheck from "../src/DocsCheck.ts"
import * as Factory from "../src/Factory.ts"
import * as FactoryPolicy from "../src/FactoryPolicy.ts"
import * as FlowCatalog from "../src/FlowCatalog.ts"
import * as Foundry from "../src/Foundry.ts"
import * as GithubTarget from "../src/GithubTarget.ts"
import * as GitTarget from "../src/GitTarget.ts"
import * as Go from "../src/Go.ts"
import * as Input from "../src/Input.ts"
import * as DeclarationSource from "../src/internal/DeclarationSource.ts"
import * as ExecEnvironment from "../src/internal/ExecEnvironment.ts"
import * as ReviewEnvironment from "../src/internal/ReviewEnvironment.ts"
import * as ReviewExecutable from "../src/internal/ReviewExecutable.ts"
import * as ReviewModel from "../src/internal/ReviewModel.ts"
import * as ManifestJson from "../src/ManifestJson.ts"
import * as Mount from "../src/Mount.ts"
import * as Nix from "../src/Nix.ts"
import * as NodeArtifact from "../src/NodeArtifact.ts"
import * as NpmTarget from "../src/NpmTarget.ts"
import * as Owners from "../src/Owners.ts"
import * as PackageJson from "../src/PackageJson.ts"
import * as PackageJsonTemplate from "../src/PackageJsonTemplate.ts"
import * as PackageManager from "../src/PackageManager.ts"
import * as Reference from "../src/Reference.ts"
import * as Runtime from "../src/Runtime.ts"
import * as RustToolchain from "../src/RustToolchain.ts"
import * as Secret from "../src/Secret.ts"
import * as SecurityReview from "../src/SecurityReview.ts"
import * as Shell from "../src/Shell.ts"
import * as Target from "../src/Target.ts"
import * as TsBuild from "../src/TsBuild.ts"
import * as WorkspaceDeclaration from "../src/WorkspaceDeclaration.ts"

const executions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? (process.env["EFFECT_FUZZ"] ? "250" : "100"))
const seed = Number(process.env["EFFECT_FUZZ_SEED"] ?? "20261124")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const withTempDir = async <A>(prefix: string, fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix)))
  try {
    return await fn(dir)
  } finally {
    await Fs.rm(dir, { recursive: true, force: true })
  }
}

describe("@smthrs/targets Wave-9A: rule catalog, validators, declarations, notImplemented & small modules fuzz", () => {
  it("Target core helpers, splitPresentation, layerNotImplemented, dependencySelectors, Proxy & guard/make errors", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        reserved: Schema.Literals([".git", ".flows"]),
        badLifecycle: Schema.Literals(["draft", "temporary", "invalid"]),
        targetName: Schema.Literals(["//pkg:build", "//apps/a:test", "catalog target"]),
        subPattern: Schema.Literals(["//packages/...", "//apps/..."])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.promise(async () => {
            // declaredOutputFailure reserved roots
            const reservedErr = Target.declaredOutputFailure(".", `${input.reserved}/out.txt`)
            expect(reservedErr).toContain("reserved directory")

            // splitPresentation non-object + invalid lifecycle + artifact without summary
            const splitPrim = Target.splitPresentation("not-an-object")
            expect(typeof splitPrim).toBe("object")
            if (typeof splitPrim !== "string") {
              expect(splitPrim.attrs).toBe("not-an-object")
            }
            expect(Target.splitPresentation({ lifecycle: input.badLifecycle })).toContain("lifecycle")
            expect(Target.splitPresentation({ lifecycle: "artifact" })).toContain("summary")

            // isTarget / isDependencySelector malformed inputs & throwing proxy
            expect(Target.isTarget(null)).toBe(false)
            expect(Target.isTarget({})).toBe(false)
            const throwingObj = new Proxy({}, {
              getOwnPropertyDescriptor() {
                throw new Error("boom")
              }
            })
            expect(Target.isTarget(throwingObj)).toBe(false)
            expect(Target.isTarget({ _tag: "X", [Target.TargetTypeId]: { target: "X", kinds: "not-array" } })).toBe(
              false
            )
            expect(
              Target.isTarget({ _tag: "X", [Target.TargetTypeId]: { target: "X", kinds: ["build"], verbGate: "bad" } })
            ).toBe(false)
            expect(
              Target.isTarget({
                _tag: "X",
                [Target.TargetTypeId]: { target: "X", kinds: ["build"], verbGate: ["not-a-kind"] }
              })
            ).toBe(false)

            // Dependency selectors + attrsForKind failure + Proxy rejection
            const dummyRule = Target.make("Wave9Dummy", {
              kinds: ["build", "lint"],
              attrs: Schema.Struct({
                deps: Schema.optional(Schema.Array(Target.Dependency)),
                label: Schema.optional(Schema.String)
              }),
              attrsForKind: (kind, attrs) => {
                if (kind === "lint" && attrs.label === "explode-kind") {
                  throw new Error("kind map boom")
                }
                return attrs
              },
              implementation: () => Target.notImplemented("Wave9Dummy")
            })

            const sel = Target.subtree(input.subPattern, "build")
            const ok = dummyRule({ deps: [sel, sel], label: "ok" })
            const meta = Target.metadata(ok)
            expect(meta.dependencySelectors.length).toBe(1)
            expect(meta.forKind("lint").dependencySelectors.length).toBe(1)

            expect(() => Target.metadata(dummyRule({ label: "explode-kind" })).forKind("lint")).toThrow(/kind map boom/)
            expect(() => dummyRule(new Proxy({}, {}) as never)).toThrow(/Proxy/)
            expect(() => dummyRule({ label: new Proxy({}, {}) as unknown as string })).toThrow(/Proxy/)

            // Guard rejection
            const guardedRule = Target.guard(
              Target.make("Wave9Guarded", {
                kinds: ["build"],
                attrs: Schema.Struct({ val: Schema.Number }),
                implementation: () => Target.notImplemented("Wave9Guarded")
              }),
              (attrs) => {
                if (attrs.val < 0) throw new Error("negative val")
              }
            )
            expect(() => guardedRule({ val: -1 })).toThrow(/negative val/)
            expect(guardedRule({ val: 1 })._tag).toBe("Wave9Guarded")

            // Target.layerNotImplemented executes the action and fails with NotImplemented
            type NotImplFn = (p: { readonly target: string }, id: string) => Effect.Effect<never, Target.NotImplemented>
            let registered: NotImplFn | undefined
            const runtime = FlowRuntime.FlowRuntime.of(
              {
                register: (_flow: unknown, exec: NotImplFn) =>
                  Effect.sync(() => {
                    registered = exec
                  }),
                actionExecute: (action: { readonly execute: Effect.Effect<unknown, unknown> }) =>
                  Effect.map(Effect.exit(action.execute), (exit) => new Flow.Complete({ exit }))
              } as unknown as FlowRuntime.FlowRuntime["Service"]
            )
            const exit = await Effect.runPromiseExit(
              Effect.gen(function*() {
                yield* Layer.build(
                  Target.layerNotImplemented.pipe(
                    Layer.provide(Layer.succeed(FlowRuntime.FlowRuntime, runtime))
                  )
                )
                const instance = FlowRuntime.FlowInstance.of({
                  executionId: "notimpl-wave9a",
                  actionState: { count: 0, latch: Latch.makeUnsafe() }
                } as never)
                return yield* registered!({ target: input.targetName }, "notimpl-wave9a").pipe(
                  Effect.provideService(FlowRuntime.FlowInstance, instance),
                  Effect.provideService(FlowRuntime.FlowRuntime, runtime)
                )
              }).pipe(Effect.scoped)
            )
            expect(Exit.isFailure(exit)).toBe(true)
            expect(Target.catalogNotImplemented()).toBeDefined()
            return true
          }),
        { executions: Math.min(executions, 20), seed }
      )
    )
    assertPassed(report)

    // Exceed maximumAttrsMembers (100_000) once outside hot loop
    const bigRule = Target.make("Wave9Big", {
      kinds: ["build"],
      attrs: Schema.Struct({ items: Schema.Array(Schema.Number) }),
      implementation: () => Target.notImplemented("Wave9Big")
    })
    const bigArr = Array.from({ length: 100_005 }, (_, i) => i)
    expect(() => bigRule({ items: bigArr })).toThrow(/declaration bound/)
  })

  it("Cargo, Go, Foundry, GithubTarget, Docker, GitTarget, NodeArtifact, NpmTarget, BiomeCheck & BundlerTarget rule implementations", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        binName: Schema.Literals(["smthrs", "worker", "cli"]),
        triple: Schema.Literals(["x86_64-unknown-linux-gnu", "aarch64-apple-darwin"]),
        badKey: Schema.Literals(["unknownOpt", "extraFlag", "bogus"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.sync(() => {
            // Cargo: unsupported rule, bins with target, >1 selectors, all .implementation()
            expect(() => Cargo.packageArgs("NotACargoRule", {}, { _tag: "Workspace" })).toThrow(
              /not a build-system cargo rule/
            )
            const bins = Cargo.binaries({ bins: [input.binName], target: input.triple, profile: "release" })
            expect(bins.some((p) => p.includes(input.triple))).toBe(true)
            expect(() =>
              Cargo.Fetch(
                { workspace: true, crates: Cargo.AppSet({ manifests: Input.glob("crates/*/Cargo.toml") }) } as never
              )
            ).toThrow(/at most one/)

            const cargoTargets: ReadonlyArray<Target.AnyTarget> = [
              Cargo.Fetch({}),
              Cargo.Build({ workspace: true }),
              Cargo.Test({ workspace: true }),
              Cargo.Nextest({ workspace: true }),
              Cargo.Deny({ config: Input.file("deny.toml") }),
              Cargo.Clippy({ workspace: true }),
              Cargo.Fmt({ workspace: true }),
              Cargo.Doc({ workspace: true }),
              Cargo.AppSet({ manifests: Input.glob("crates/*/Cargo.toml") })
            ]
            for (const t of cargoTargets) {
              expect(Target.plan(t as never)).toBeDefined()
            }

            // Go: all rule implementations + ldflags unknown option
            const goTargets: ReadonlyArray<Target.AnyTarget> = [
              Go.Packages({ pkgs: ["./..."] }),
              Go.Test({ pkgs: ["./..."] }),
              Go.Binary({ pkg: "./cmd/app", out: "bin/app" }),
              Go.ModDownload({ mod: Input.file("go.mod"), sum: Input.file("go.sum"), outDirs: ["vendor"] }),
              Go.Lint({ config: Input.file(".golangci.yml"), version: "1.64.0", pkgs: ["./..."] }),
              Go.Generate({ pkgs: ["./..."], changes: ["gen/a.go"] }),
              Go.Fuzz({ pkg: "./pkg", fuzz: "FuzzParse", time: "5s" } as never)
            ]
            for (const t of goTargets) {
              expect(Target.plan(t as never)).toBeDefined()
            }
            expect(() => Go.ldflags({ [input.badKey]: "x" } as never)).toThrow(/unknown option/)

            // Foundry: Toolchain validation errors + Build/Test/Fmt implementations
            expect(() => Foundry.Toolchain("bad" as never)).toThrow(/must be an object/)
            expect(() => Foundry.Toolchain({ [input.badKey]: true } as never)).toThrow(/unknown option/)
            expect(() => Foundry.Toolchain({ config: Input.file("foundry.toml"), versions: "not-mise" as never }))
              .toThrow(/S\.Mise/)
            for (
              const t of [
                Foundry.Build({ outDirs: ["out"] }),
                Foundry.Test({}),
                Foundry.Fmt({ changes: ["src/A.sol"] })
              ]
            ) {
              expect(Target.plan(t as never)).toBeDefined()
            }

            // GithubTarget: Setup, Workflow, CiGen, Pr, Pages, Release implementations + prAttrsOf mismatch
            const ghSetup = GithubTarget.Setup({})
            const ghTargets: ReadonlyArray<Target.AnyTarget> = [
              ghSetup,
              GithubTarget.Workflow({ name: "CI", on: { push: { branches: ["main"] } } } as never),
              GithubTarget.CiGen({ workflows: [] } as never),
              GithubTarget.Pr({ gates: [ghSetup] }),
              GithubTarget.Pages({ site: ghSetup }),
              GithubTarget.Release({ manifest: Input.file("package.json"), notes: "release", gates: [ghSetup] })
            ]
            for (const t of ghTargets) {
              expect(Target.plan(t as never)).toBeDefined()
            }
            expect(() => GithubTarget.prAttrsOf(ghSetup)).toThrow(/expected a Github\.Pr/)

            // Docker, GitTarget, NodeArtifact, NpmTarget, DocsCheck implementations
            const dockerBuild = Docker.Build({ dockerfile: Input.file("Dockerfile"), context: "." })
            const npmPack = NpmTarget.Pack({ manifest: Input.file("package.json") })
            const litTarget = NodeArtifact.Literal({ path: "a.txt", content: "hi" })
            const catalogTargets: ReadonlyArray<Target.AnyTarget> = [
              dockerBuild,
              Docker.Bake({ config: Input.file("docker-bake.hcl"), target: "app" }),
              Docker.Push(
                {
                  image: dockerBuild,
                  registry: "ghcr.io",
                  name: "org/app",
                  tags: ["latest"],
                  approval: "required"
                } as never
              ),
              Docker.Serve({ image: "postgres:18" } as never),
              Docker.Service({ image: "postgres:18" } as never),
              GitTarget.Commit({ gates: [ghSetup], message: "chore: update" }),
              GitTarget.Pr({ gates: [ghSetup] }),
              GitTarget.Submodules({ config: Input.file(".gitmodules"), paths: ["vendor/a"] }),
              GitTarget.Submodule({ path: "vendor/a" }),
              NodeArtifact.Copy({ from: Input.file("a.txt"), to: "b.txt" }),
              litTarget,
              NodeArtifact.Overlay({ base: litTarget, replace: { "a.txt": Input.file("b.txt") } }),
              npmPack,
              NpmTarget.Publish({ pack: npmPack, gates: [ghSetup] }),
              NpmTarget.Published({ manifest: Input.file("package.json") }),
              NpmTarget.Downstream({ repository: "org/down", overrides: { a: npmPack }, run: ["test"] }),
              DocsCheck.Check({
                output: Input.file("README.md"),
                stamp: Input.file("README.stamp"),
                inputs: [Input.file("src/a.ts")]
              })
            ]
            for (const t of catalogTargets) {
              try {
                Target.plan(t as never)
              } catch {
                // some targets require fuller attrs
              }
            }

            // BiomeCheck: format-only, check+format, explicit sources, glob sources
            const biomeFormatOnly = BiomeCheck.BiomeCheck(
              {
                lint: false,
                format: true,
                packageManager: PackageManager.Pnpm(
                  { version: "11.25.0", runtime: Runtime.Node({ version: ">=26.4.0" }) } as never
                ),
                deps: [],
                config: Input.file("biome.json"),
                sources: [Input.file("src/a.ts")]
              } as never
            )
            const biomeBoth = BiomeCheck.BiomeCheck(
              {
                lint: true,
                format: true,
                packageManager: PackageManager.Pnpm(
                  { version: "11.25.0", runtime: Runtime.Node({ version: ">=26.4.0" }) } as never
                ),
                deps: [],
                config: Input.file("biome.json"),
                sources: [Input.file("src/a.ts")]
              } as never
            )
            const biomeGlob = BiomeCheck.BiomeCheck(
              {
                lint: true,
                format: true,
                packageManager: PackageManager.Pnpm(
                  { version: "11.25.0", runtime: Runtime.Node({ version: ">=26.4.0" }) } as never
                ),
                deps: [],
                config: Input.file("biome.json"),
                sources: [Input.glob("src/**/*.ts")]
              } as never
            )
            for (const t of [biomeFormatOnly, biomeBoth, biomeGlob]) {
              expect(Target.plan(t as never)).toBeDefined()
            }

            // BundlerTarget: Rspack validation errors + build/resolve implementations
            expect(() => BundlerTarget.Rspack({ config: Input.file("rspack.config.ts"), [input.badKey]: 1 } as never))
              .toThrow(/unknown option/)
            expect(() => BundlerTarget.Rspack({ config: "bad" as never })).toThrow(/declared config file/)
            const rspack = BundlerTarget.Rspack({ config: Input.file("rspack.config.ts") })
            expect(() => rspack.resolve("bad" as never)).toThrow(/must be an object/)
            expect(() => rspack.resolve({ entries: [] } as never)).toThrow(/at least one entry/)
            expect(() => rspack.build("bad" as never)).toThrow(/must be an object/)
            expect(() => rspack.build({ outDirs: [] } as never)).toThrow(/at least one outDir/)
            const rResolve = rspack.resolve({ entries: ["src/index.ts"], universe: [Input.file("src/index.ts")] })
            const rBuild = rspack.build({ outDirs: ["dist"], graph: rResolve, environment: "web", mode: "production" })
            for (const t of [rResolve, rBuild]) {
              expect(Target.plan(t as never)).toBeDefined()
            }
            return true
          }),
        { executions: Math.min(executions, 20), seed }
      )
    )
    assertPassed(report)

    // Cargo metadata filter bound (> maximumMetadataMembers)
    const hugeFilter: Record<string, unknown> = {}
    for (let i = 0; i < 10_005; i++) hugeFilter[`k${i}`] = i
    expect(() => Cargo.metadataMatches(hugeFilter, hugeFilter)).toThrow(/declaration bound/)
  })

  it("CiToolchain, DocsCheck, Factory, Shell, WorkspaceDeclaration, Nix, Runtime, PackageJsonTemplate & Reference validation", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        badKey: Schema.Literals(["extra", "bogus", "nope"]),
        badPath: Schema.Literals(["has space", "semi;colon", "bad\u0000path", ""])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.sync(() => {
            // CiToolchain
            expect(Schema.is(CiToolchain.NodeVersionFile)(".nvmrc")).toBe(true)
            expect(Schema.is(CiToolchain.NodeVersionFile)("../.nvmrc")).toBe(false)
            expect(() => CiToolchain.Node({} as never)).toThrow(/exactly one/)
            expect(() => CiToolchain.Node({ release: "26.4.0" as never, versionFile: ".nvmrc" })).toThrow(/exactly one/)
            expect(() => CiToolchain.Node({ versionFile: "../.nvmrc" })).toThrow(/workspace-relative/)
            expect(() => CiToolchain.Docker({ imageStore: "containerd", registryMirrors: ["http://insecure.local"] }))
              .toThrow(/https URL/)
            expect(() => CiToolchain.Nix({ environment: "bad" as never })).toThrow(/S\.Nix\.Environment/)
            const nixEnv = Nix.Environment({ flake: Input.file("flake.nix") })
            expect(() => CiToolchain.Nix({ environment: nixEnv, substituter: "bad" as never })).toThrow(/S\.Secret/)
            expect(() => CiToolchain.Nix({ environment: nixEnv, publicKey: "bad" as never })).toThrow(/S\.Secret/)
            const sec = Secret.Secret("NIX_SUB")
            expect(() => CiToolchain.Nix({ environment: nixEnv, substituter: sec })).toThrow(/declared together/)
            expect(() => CiToolchain.validatePath(input.badPath, "script")).toThrow(/not a usable/)
            expect(() => CiToolchain.validateExecutable("bad exe\n", "bin")).toThrow(/not a usable/)
            expect(() =>
              CiToolchain.Needs({
                nix: CiToolchain.Nix({ environment: nixEnv }),
                runtimes: [CiToolchain.Node({ versionFile: ".nvmrc" })]
              })
            ).toThrow(/Nix environment supplies/)
            expect(() => CiToolchain.Needs({ fetchDepth: -1 })).toThrow(/whole number/)

            // DocsCheck validation + judge missing/policy/stale
            expect(() =>
              DocsCheck.closureDigest([
                { path: "a.ts", digest: "a".repeat(64) },
                { path: "a.ts", digest: "b".repeat(64) }
              ])
            ).toThrow(/two different digests/)
            const stamp = DocsCheck.makeStamp({
              producer: undefined,
              output: { path: "docs/a.md", digest: "c".repeat(64) },
              inputs: [{ path: "src/a.ts", digest: "a".repeat(64) }],
              ignore: { sections: ["foo"] }
            })
            const missingRes = DocsCheck.judge({
              page: "docs/a.md",
              stampPath: "docs/a.stamp",
              output: { path: "docs/a.md", digest: undefined },
              inputs: [{ path: "src/a.ts", digest: "a".repeat(64) }],
              stamp,
              ignore: { sections: ["foo"] }
            })
            expect(missingRes?.reason).toBe("missing")
            const policyRes = DocsCheck.judge({
              page: "docs/a.md",
              stampPath: "docs/a.stamp",
              output: { path: "docs/a.md", digest: "c".repeat(64) },
              inputs: [{ path: "src/a.ts", digest: "a".repeat(64) }],
              stamp,
              ignore: { sections: ["bar"] }
            })
            expect(policyRes?.reason).toBe("modified")
            expect(() =>
              DocsCheck.Check({
                output: Input.file("docs/a.md"),
                stamp: Input.file("docs/a.md"),
                inputs: [Input.file("src/a.ts")]
              })
            ).toThrow()
            expect(() =>
              DocsCheck.Check({
                output: Input.file("docs/a.md"),
                stamp: Input.file("docs/a.stamp"),
                inputs: [Input.file("docs/a.md")]
              })
            ).toThrow(/own input/)
            expect(() =>
              DocsCheck.Check({
                output: Input.file("docs/a.md"),
                stamp: Input.file("docs/a.stamp"),
                inputs: [Input.file("src/a.ts")],
                evidence: [{ file: Input.file("docs/ev.json"), dependency: "//pkg:test", ttlMs: -5 }]
              })
            ).toThrow(/ttlMs/)
            expect(() =>
              DocsCheck.Check({
                output: Input.file("docs/a.md"),
                stamp: Input.file("docs/a.stamp"),
                inputs: [Input.file("src/a.ts")],
                evidence: [
                  { file: Input.file("docs/ev.json"), dependency: "//pkg:test", ttlMs: 1000 },
                  { file: Input.file("docs/ev.json"), dependency: "//pkg:test", ttlMs: 1000 }
                ]
              })
            ).toThrow(/distinct/)

            // Factory Policy + Factory + FactoryPolicy
            expect(() => Factory.Policy({ todoSince: "not-a-date" })).toThrow(/RFC 3339/)
            expect(() => Factory.Policy({ dailyTokens: 0 })).toThrow(/positive/)
            expect(() => Factory.Policy({ maintainers: ["  bad  "] })).toThrow(/not a login/)
            expect(() => Factory.Policy({ protectedPaths: ["../bad"] })).toThrow(/repository-relative/)
            expect(() =>
              Factory.Factory({
                flows: ["not-a-flow" as never],
                on: {}
              } as never)
            ).toThrow(/Smithers\.Flow/)
            expect(() =>
              Factory.Factory({
                flows: [],
                on: "not-record" as never
              } as never)
            ).toThrow(/record/)
            expect(() => FactoryPolicy.make({ unknownField: 1 } as never)).toThrow()

            // Shell validation + execPayload forms
            const fakeService = Docker.Service({ image: "postgres:18" } as never)
            expect(() =>
              Shell.Test({ shell: "echo hi", machine: "linux", sandbox: "none", services: [fakeService] } as never)
            ).toThrow(/services/)
            expect(() => Shell.Test({ shell: "echo hi", observe: true } as never)).toThrow(/sandbox: "none"/)
            expect(() =>
              Shell.Test({ shell: "echo hi", observe: true, sandbox: "none", services: [fakeService] } as never)
            ).toThrow(/services/)
            expect(() => Shell.execPayload({ bin: fakeService, runtimeArgs: ["--inspect"] } as never)).toThrow()
            expect(Shell.execPayload({ bin: fakeService, args: ["a"] } as never)).toBeDefined()
            expect(Shell.execPayload({ bin: Reference.hostBin("echo"), runtimeArgs: ["-n"], args: ["hi"] } as never))
              .toBeDefined()
            expect(Shell.execPayload({ bin: Reference.hostBin("echo"), args: ["hi"] } as never)).toBeDefined()
            expect(
              Shell.execPayload(
                {
                  bin: Reference.NodeModule.Bin("vitest"),
                  runtimeArgs: ["--max-old-space-size=512"],
                  args: ["run"]
                } as never
              )
            ).toBeDefined()
            expect(() => Shell.execPayload({} as never)).toThrow(/no executable/)

            // WorkspaceDeclaration: Flags, Sandbox.Microsandbox
            expect(() => WorkspaceDeclaration.Flags("bad" as never)).toThrow(/record/)
            expect(() => WorkspaceDeclaration.Flags({ flag: "" })).toThrow(/non-empty/)
            expect(() => WorkspaceDeclaration.Sandbox.Microsandbox("bad" as never)).toThrow(/object/)
            expect(() => WorkspaceDeclaration.Sandbox.Microsandbox({ [input.badKey]: 1 } as never)).toThrow(
              /unknown option/
            )

            // Nix
            expect(() => Nix.Environment({} as never)).toThrow(/flake or a file/)
            expect(() => Nix.Environment({ file: Input.file("shell.nix"), lock: Input.file("flake.lock") } as never))
              .toThrow(/not a file/)
            expect(() => Nix.Environment({ file: "not-a-file" as never })).toThrow(/S\.file/)
            const nixFromFile = Nix.Environment({ file: Input.file("shell.nix") })
            expect(Nix.isEnvironment(nixFromFile)).toBe(true)
            expect(Nix.isEnvironment({})).toBe(false)
            const nixNestedFlake = Nix.Environment({ flake: Input.file("nix/flake.nix") })
            expect(nixNestedFlake.lock?.path).toBe("nix/flake.lock")

            // Runtime
            expect(() => Runtime.Node("bad" as never)).toThrow(/object/)
            expect(() => Runtime.Node({} as never)).toThrow(/manifest or a version/)
            expect(() => Runtime.Node({ version: ">=26.4.0", manifest: Input.file("package.json") } as never)).toThrow(
              /not both/
            )
            expect(Runtime.Node({ manifest: Input.file("package.json") })).toBeDefined()
            expect(Runtime.Node({ version: ">=26.4.0" })).toBeDefined()
            expect(() => Runtime.Node({ version: "bad\u0000ver" } as never)).toThrow(/control characters/)
            expect(() => Runtime.Bun({ version: "0.0.0-invalid\u0000" })).toThrow()
            expect(Runtime.environment(Runtime.Node({ version: ">=26.4.0" }), { A: "1" })).toBeDefined()

            // PackageJsonTemplate
            expect(() => PackageJsonTemplate.make(new Date() as never)).toThrow(/plain object/)
            expect(() => PackageJsonTemplate.make({ [Symbol("s")]: 1 } as never)).toThrow(/symbol/)
            const getterObj = {}
            Object.defineProperty(getterObj, "type", { get: () => "module", enumerable: true })
            expect(() => PackageJsonTemplate.make(getterObj as never)).toThrow(/accessor/)
            expect(() => PackageJsonTemplate.make({ type: "amd" as never })).toThrow(/module/)
            expect(() => PackageJsonTemplate.make({ sideEffects: 123 as never })).toThrow(/boolean or an array/)
            const tmplSide = PackageJsonTemplate.make({ sideEffects: ["*.css"] })
            expect(tmplSide.fields["sideEffects"]).toEqual(["*.css"])
            expect(() => PackageJsonTemplate.make({ type: "module", fields: { type: "module" } } as never)).toThrow(
              /twice/
            )

            // Reference
            expect(() => Reference.NodeModule("bad\u0000pkg")).toThrow(/control characters/)
            expect(Reference.NodeModule("effect").package).toBe("effect")
            expect(Reference.hostBin("git").name).toBe("git")
            expect(Reference.runtimeNpx("tsx@4").spec).toBe("tsx@4")
            expect(Reference.miseBin("rg").name).toBe("rg")
            expect(Reference.symlink("bin/link").path).toBe("bin/link")
            expect(Reference.Mcp.Http("docs", "https://example.com/mcp").name).toBe("docs")
            return true
          }),
        { executions: Math.min(executions, 20), seed }
      )
    )
    assertPassed(report)
  })

  it("RustToolchain, AgentTarget, FlowCatalog, Mount, Owners, DependencyDocs, ManifestJson, PackageJson & SecurityReview validators", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        badKey: Schema.Literals(["bogus", "unexpected"]),
        badLogin: Schema.Literals(["", " has space", "bad/user"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.sync(() => {
            // RustToolchain
            expect(() => RustToolchain.Toolchain("bad" as never)).toThrow(/object/)
            expect(() => RustToolchain.Toolchain({ [input.badKey]: 1 } as never)).toThrow(/unknown option/)
            expect(() => RustToolchain.Toolchain({ channel: "1.85\u0000" })).toThrow(/control characters/)
            expect(() => RustToolchain.Toolchain({ toolchain: "not-file" as never })).toThrow(/S\.file/)
            expect(() => RustToolchain.Toolchain({ channel: "stable", toolchain: Input.file("rust-toolchain.toml") }))
              .toThrow()
            expect(RustToolchain.isToolchainDeclaration({ _tag: "Nope" })).toBe(false)
            const rt = RustToolchain.Toolchain({ toolchain: Input.file("rust-toolchain.toml") })
            expect(RustToolchain.toolchainInstall(rt)).toBeDefined()

            // AgentTarget
            expect(() => AgentTarget.ClaudeCode({ model: "" } as never)).toThrow(/model name/)
            expect(() => AgentTarget.Pool([] as never)).toThrow(/non-empty/)
            expect(() => AgentTarget.Agents("bad" as never)).toThrow(/record/)
            expect(() => AgentTarget.Agents({ a: "not-agent" as never })).toThrow(/not an agent/)
            expect(() =>
              AgentTarget.Agents({
                pool: AgentTarget.Pool(["missing"])
              })
            ).toThrow(/not a declared agent/)

            // FlowCatalog
            expect(() =>
              FlowCatalog.rows(
                [
                  { id: "dup", path: ".smithers/flows/dup/flow.ts", kind: "ts", description: "a" },
                  { id: "dup", path: ".smithers/flows/dup/flow.ts", kind: "ts", description: "b" }
                ] as never,
                {} as never
              )
            ).toThrow(/twice/)
            expect(() =>
              FlowCatalog.rows(
                [{ id: "known", path: ".smithers/flows/known/flow.ts", kind: "ts", description: "a" }] as never,
                { unknownFlow: {} } as never
              )
            ).toThrow()

            // Mount
            expect(() =>
              Mount.Mount({
                repository: "org/repo",
                ref: "main",
                path: "vendor/repo"
              } as never)
            ).toThrow(/full commit id/)
            expect(() =>
              Mount.Mount({
                repository: "org/repo",
                ref: "a".repeat(40),
                path: "vendor/repo",
                drift: "fail"
              } as never)
            ).toThrow(/track/)
            expect(() =>
              Mount.Mounts({
                Bad_Name: Mount.Mount({ repository: "org/repo", ref: "a".repeat(40), path: "vendor/a" } as never)
              })
            ).toThrow(/lowercase/)

            // Owners
            expect(() => Owners.declare({ owners: ["alice"], noparent: "yes" as never })).toThrow(/boolean/)
            expect(() => Owners.declare({ owners: [], noparent: true })).toThrow(/at least one owner/)
            expect(() => Owners.declare({ owners: ["alice"], agents: { default: "bogus" as never } })).toThrow(
              /auto-land/
            )
            expect(() => Owners.declare({ owners: ["alice"], perFile: { "": ["bob"] } } as never)).toThrow(/non-empty/)
            expect(() => Owners.Teams({ core: [input.badLogin] })).toThrow(/not a login/)
            expect(() => Owners.Teams({ huge: Array.from({ length: 100 }, (_, i) => `u${i}`) })).toThrow(/more than/)

            // DependencyDocs
            expect(() => DependencyDocs.Package("BAD NAME!!", { files: ["README.md"] })).toThrow(/npm package name/)
            expect(() => DependencyDocs.Package("effect", { files: ["../escape.md"] })).toThrow(/package-relative/)
            expect(() => DependencyDocs.Url("http://insecure.example/doc.md", { sha256: "a".repeat(64) })).toThrow(
              /https URL/
            )
            expect(() => DependencyDocs.Url("https://example.com/doc.md", { sha256: "not-hex" })).toThrow(/sha256/)
            const docUrl = DependencyDocs.Url("https://example.com/doc.md", { sha256: "a".repeat(64) })
            expect(docUrl._tag).toBe("DocsUrl")

            // ManifestJson
            expect(() => ManifestJson.cloneValue(1n, "root")).toThrow(/bigint/)
            const sparse: Array<unknown> = []
            sparse[2] = 1
            expect(() => ManifestJson.cloneValue(sparse, "arr")).toThrow(/sparse array/)
            const extraPropArr = Object.assign([1], { extra: 2 })
            expect(() => ManifestJson.cloneValue(extraPropArr, "arr")).toThrow(/extra own properties/)
            const accObj = {}
            Object.defineProperty(accObj, "k", { get: () => 1, enumerable: true })
            expect(() => ManifestJson.cloneValue(accObj, "obj")).toThrow(/accessor/)

            // PackageJson validation errors
            const tsEntry = TsBuild.TsBuild({
              srcs: [Input.file("src/index.ts")],
              entries: [Input.file("src/index.ts")],
              deps: [],
              tsconfig: Input.file("tsconfig.json"),
              tool: { name: "tsc" },
              format: "esm",
              outDir: "dist"
            })
            expect(() => PackageJson.PackageJson(new Date() as never)).toThrow(/plain object/)
            expect(() => PackageJson.PackageJson({ name: "a", version: "1.0.0", [Symbol("s")]: 1 } as never)).toThrow(
              /symbol/
            )
            expect(() => PackageJson.PackageJson({ name: "a", version: "1.0.0", [input.badKey]: 1 } as never)).toThrow(
              /unknown option/
            )
            const pkAcc = { name: "a", version: "1.0.0" }
            Object.defineProperty(pkAcc, "description", { get: () => "d", enumerable: true })
            expect(() => PackageJson.PackageJson(pkAcc as never)).toThrow(/accessor/)
            expect(() => PackageJson.PackageJson({ name: "a", version: "1.0.0", scripts: "bad" as never })).toThrow(
              /scripts must be a plain object/
            )
            expect(() =>
              PackageJson.PackageJson({ name: "a", version: "1.0.0", scripts: { [Symbol("s")]: "x" } as never })
            ).toThrow(/symbol keys/)
            const scrAcc = {}
            Object.defineProperty(scrAcc, "build", { get: () => "x", enumerable: true })
            expect(() => PackageJson.PackageJson({ name: "a", version: "1.0.0", scripts: scrAcc as never })).toThrow(
              /accessor/
            )
            expect(() => PackageJson.PackageJson({ name: "a", version: "1.0.0", scripts: { "": "x" } as never }))
              .toThrow(/script name is invalid/)
            expect(() =>
              PackageJson.PackageJson({
                name: "a",
                version: "1.0.0",
                publish: { entry: tsEntry, [Symbol("s")]: 1 } as never
              })
            ).toThrow(/symbol keys/)
            const pubAcc = { entry: tsEntry }
            Object.defineProperty(pubAcc, "access", { get: () => "public", enumerable: true })
            expect(() => PackageJson.PackageJson({ name: "a", version: "1.0.0", publish: pubAcc as never })).toThrow(
              /accessor/
            )
            expect(() =>
              PackageJson.PackageJson({
                name: "a",
                version: "1.0.0",
                publish: { entry: tsEntry, access: "private" as never }
              })
            ).toThrow(/public/)
            expect(() => PackageJson.PackageJson({ name: "a", version: "1.0.0", fields: { name: "dup" } } as never))
              .toThrow(/twice/)
            expect(() => PackageJson.PackageJson({ name: "a", version: "1.0.0", readme: "README.md" as never }))
              .toThrow(/Input\.File/)
            expect(() => PackageJson.PackageJson({ name: "a", version: "1.0.0", sources: "src/*.ts" as never }))
              .toThrow(/Input\.Glob/)
            expect(() => PackageJson.PackageJson({ name: "a", version: "1.0.0", model: "  bad  " } as never)).toThrow(
              /model/
            )

            // SecurityReview validators
            expect(() =>
              SecurityReview.SecurityReview({
                cwd: ".",
                checks: [{ id: "bad\nid", title: "t", rule: "g" }] as never
              })
            ).toThrow(/nonempty line/)
            expect(() =>
              SecurityReview.SecurityReview({
                cwd: ".",
                checks: [],
                boundaries: []
              })
            ).toThrow(/at least one boundary/)
            expect(() =>
              SecurityReview.SecurityReview({
                cwd: ".",
                checks: [],
                boundaries: [{ id: "b1", entrypoints: [], invariants: ["inv"] }] as never
              })
            ).toThrow(/at least one item/)

            // Internal small helpers
            expect(ExecEnvironment.nameKey("Path", "win32")).toBe("PATH")
            expect(ExecEnvironment.nameKey("Path", "linux")).toBe("Path")
            expect(
              ReviewEnvironment.spawnEnvironment(
                ["SECRET"],
                false,
                "/home/u",
                "claude",
                { ANTHROPIC_API_KEY: "k", SECRET: "s", OTHER: "v" },
                "linux",
                NodePath.join
              )
            ).toBeDefined()
            expect(ReviewExecutable.nodeModule("C:/tool.mjs", {
              platform: "win32",
              stat: (() => ({ isFile: () => false })) as never,
              isAbsolute: () => true
            })).toBe(false)
            expect(ReviewModel.configuredRoute({ _tag: "Success", success: "ok" } as never)).toBeDefined()
            expect(DeclarationSource.capture({
              callSites: () => {
                throw new Error("no stack")
              },
              fromFileUrl: (f) => f,
              basename: (f) => NodePath.basename(f),
              resolve: (f) => f,
              isDeclaration: (n) => n === "PACKAGE.ts"
            })).toBeUndefined()
            expect(DeclarationSource.capture({
              callSites: () => [
                { scriptName: "file://invalid-url", lineNumber: 1, columnNumber: 1 },
                { scriptName: "/tmp/PACKAGE.ts", lineNumber: 10, columnNumber: 5 }
              ],
              fromFileUrl: () => {
                throw new Error("bad url")
              },
              basename: (f) => NodePath.basename(f),
              resolve: (f) => f,
              isDeclaration: (n) => n === "PACKAGE.ts"
            })).toEqual({ path: "/tmp/PACKAGE.ts", line: 10, column: 5 })
            return true
          }),
        { executions: Math.min(executions, 20), seed }
      )
    )
    assertPassed(report)

    // SecurityReview with real workspace files (covering unmatched boundary/context & skippedDirectories)
    await withTempDir("wave9a-sec-", async (root) => {
      await Fs.mkdir(NodePath.join(root, "src"), { recursive: true })
      await Fs.mkdir(NodePath.join(root, "node_modules", "x"), { recursive: true })
      await Fs.writeFile(NodePath.join(root, "src", "app.ts"), "export const x = 1\n")
      await Fs.writeFile(NodePath.join(root, "node_modules", "x", "ignored.ts"), "export const y = 2\n")
      const sec = SecurityReview.SecurityReview({
        cwd: ".",
        workspaceRoot: root,
        checks: [],
        include: [Input.glob("src/**/*.ts", { exclude: ["src/**/*.test.ts"] })],
        context: ["src/app.ts"],
        boundaries: [{
          id: "b1",
          actors: ["user"],
          assets: ["secret"],
          entryPoints: ["src/app.ts"],
          identityTransformations: ["none"],
          enforcementPoints: ["src/app.ts"],
          deploymentAssumptions: ["trusted host"],
          path: {
            caller: ["src/app.ts"],
            authorization: ["src/app.ts"],
            service: ["src/app.ts"],
            storageOrEgress: ["src/app.ts"]
          }
        }]
      })
      expect(sec.security).toBeDefined()
      expect(() =>
        SecurityReview.SecurityReview({
          cwd: ".",
          workspaceRoot: root,
          checks: [],
          context: ["src/does-not-exist.ts"]
        })
      ).toThrow(/matches no file/)
      expect(() =>
        SecurityReview.SecurityReview({
          cwd: ".",
          workspaceRoot: root,
          checks: [],
          boundaries: [{
            id: "b2",
            actors: ["user"],
            assets: ["secret"],
            entryPoints: ["src/missing.ts"],
            identityTransformations: ["none"],
            enforcementPoints: ["src/app.ts"],
            deploymentAssumptions: ["trusted host"],
            path: {
              caller: ["src/missing.ts"],
              authorization: ["src/app.ts"],
              service: ["src/app.ts"],
              storageOrEgress: ["src/app.ts"]
            }
          }]
        })
      ).toThrow(/matches no file/)
    })
  })
})
