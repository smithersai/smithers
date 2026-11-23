import { Fuzz } from "@smthrs/fuzz"
import { Smithers as S } from "@smthrs/targets"
import * as Input from "@smthrs/targets/Input"
import * as Nix from "@smthrs/targets/Nix"
import { Arbitrary, Effect, Schema } from "effect"
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as DockerExec from "../src/DockerExec.ts"
import * as FoundryExec from "../src/FoundryExec.ts"
import * as GitCommit from "../src/GitCommit.ts"
import * as GitSubmoduleExec from "../src/GitSubmoduleExec.ts"
import * as GoExec from "../src/GoExec.ts"
import * as MemoryBackend from "../src/MemoryBackend.ts"
import * as NixExec from "../src/NixExec.ts"
import * as HostProbes from "../src/internal/HostProbes.ts"
import { writeExecutable } from "./helpers/Executable.ts"
import * as OciArchive from "./helpers/OciArchive.ts"

const executions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? (process.env["EFFECT_FUZZ"] ? "500" : "120"))
const fsExecutions = Math.min(executions, 14)

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

const gitExec = (root: string, args: ReadonlyArray<string>): Promise<string> =>
  new Promise((resolve, reject) => {
    NodeChildProcess.execFile("git", [...args], { cwd: root }, (err, stdout) => {
      if (err !== null) reject(err)
      else resolve(stdout)
    })
  })

const Slug = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9]{1,6}$/))

describe("@smthrs/build-cli deep fuzz suite 2: GoExec, DockerExec, NixExec, FoundryExec, GitCommit, GitSubmoduleExec & MemoryBackend", () => {
  it("GoExec resolveGo/resolveNix/toolchainEnvironment/planRule across Go.Packages/Build/Test/Vet/Fmt/Bench/ModTidy fuzz invariants", async () => {
    const gen = Arbitrary.schema(
      Schema.Struct({
        slug: Slug,
        rule: Schema.Literals([
          "Go.Packages",
          "Go.Build",
          "Go.Test",
          "Go.Vet",
          "Go.Fmt",
          "Go.Lint",
          "Go.Bench",
          "Go.ModTidy"
        ]),
        offline: Schema.Boolean,
        badGo: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        gen,
        ({ slug, rule, offline, badGo }) =>
          Effect.promise(async () => {
            await withTempDir("smthrs-bc2-go-", async (root) => {
              const binDir = NodePath.join(root, "bin")
              const pkgDir = NodePath.join(root, "pkg", slug)
              await Fs.mkdir(binDir, { recursive: true })
              await Fs.mkdir(pkgDir, { recursive: true })
              await Fs.writeFile(NodePath.join(root, "go.mod"), `module example.org/${slug}\n\ngo 1.24.0\n`)
              await Fs.writeFile(NodePath.join(root, "go.sum"), "")
              await Fs.writeFile(NodePath.join(root, ".golangci.yml"), "version: 2\n")
              await Fs.writeFile(NodePath.join(pkgDir, "main.go"), `package ${slug}\nfunc F() int { return 1 }\n`)
              await Fs.writeFile(NodePath.join(pkgDir, "main_test.go"), `package ${slug}\n`)

              const goBin = await writeExecutable(
                NodePath.join(binDir, "go"),
                `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "version") {
  process.stdout.write(${JSON.stringify(badGo ? "not-go-version\n" : "go version go1.24.1 linux/amd64\n")});
  process.exit(${badGo ? 1 : 0});
}
if (args[0] === "env") {
  process.stdout.write(JSON.stringify({ GOROOT: ${JSON.stringify(root)}, GOTOOLDIR: ${JSON.stringify(binDir)}, GOVERSION: "go1.24.1", GOOS: "linux", GOARCH: "amd64", CGO_ENABLED: "0" }));
  process.exit(0);
}
if (args[0] === "list") {
  const pkg = {
    ImportPath: ${JSON.stringify(`example.org/${slug}/pkg/${slug}`)},
    Dir: ${JSON.stringify(pkgDir)},
    Name: ${JSON.stringify(slug)},
    GoFiles: ["main.go"],
    TestGoFiles: ["main_test.go"],
    Imports: [],
    Module: { Path: ${JSON.stringify(`example.org/${slug}`)}, Dir: ${JSON.stringify(root)}, Main: true }
  };
  process.stdout.write(JSON.stringify(pkg) + "\\n");
  process.exit(0);
}
process.exit(0);
`
              )

              await writeExecutable(
                NodePath.join(binDir, "nix"),
                `#!/bin/sh
if [ "$1" = "path-info" ] || [ "$1" = "build" ]; then
  echo ${JSON.stringify(root)}
  exit 0
fi
exit 1
`
              )

              const workspace = S.Workspace(`go-${slug}`, {
                repository: "git+https://example.invalid/go.git",
                cache: S.Cache({ directory: ".flows" })
              })
              const env = { PATH: `${binDir}${NodePath.delimiter}${process.env["PATH"] ?? ""}` }
              const ctx: GoExec.Context = {
                root,
                packagePath: "",
                environment: env,
                workspace
              }

              const resolved = await GoExec.resolveGo(ctx)
              expect(typeof resolved.ok).toBe("boolean")
              if (!badGo) {
                expect(resolved.ok).toBe(true)
              }

              const nixRes = await GoExec.resolveNix("go", ctx)
              expect(typeof nixRes.ok).toBe("boolean")

              const tcEnv = GoExec.toolchainEnvironment(ctx)
              expect(tcEnv).toBeDefined()

              const attrs: Record<string, unknown> =
                rule === "Go.Packages"
                  ? { pkgs: ["./..."], offline }
                  : rule === "Go.Build"
                  ? { pkg: `./pkg/${slug}`, out: `bin/${slug}`, offline }
                  : rule === "Go.Test"
                  ? { pkgs: ["./..."], race: false, offline }
                  : rule === "Go.Bench"
                  ? { pkgs: ["./..."], bench: ".", offline }
                  : rule === "Go.Lint"
                  ? { pkgs: ["./..."], config: Input.file(".golangci.yml"), offline }
                  : { pkgs: ["./..."], offline }

              const planned = await GoExec.planRule(rule, attrs, ctx, goBin)
              expect(planned).toBeDefined()
              expect(Array.isArray(planned.outDirs)).toBe(true)

              // Also cover offline + -mod=mod refusal branch
              const refused = await GoExec.planRule(
                "Go.Build",
                { pkg: `./pkg/${slug}`, out: `bin/${slug}`, offline: true, env: { GOFLAGS: "-mod=mod" } },
                ctx,
                goBin
              )
              expect(refused.refusal).toContain("offline")
            })
            return true
          }),
        { executions: fsExecutions, seed: 20261201 }
      )
    )
    assertPassed(report)
  }, 120_000)

  it("DockerExec resolveDocker/OCI archive/writeLoadableArchive/plan/serviceSpec/pushTagRefusal fuzz invariants", async () => {
    const gen = Arbitrary.schema(
      Schema.Struct({
        slug: Slug,
        rule: Schema.Literals(["Docker.Build", "Docker.Bake", "Docker.Push"]),
        dockerManifest: Schema.Boolean,
        attestation: Schema.Boolean,
        pax: Schema.Boolean,
        multiPlatform: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        gen,
        ({ slug, rule, dockerManifest, attestation, pax, multiPlatform }) =>
          Effect.promise(async () => {
            await withTempDir("smthrs-bc2-docker-", async (root) => {
              const binDir = NodePath.join(root, "bin")
              await Fs.mkdir(binDir, { recursive: true })
              await writeExecutable(
                NodePath.join(binDir, "docker"),
                `#!/bin/sh
case "$1" in
  --version) echo 'Docker version 27.1.0-stub, build stub' ;;
  info) echo '27.1.0-stub' ;;
  buildx) echo 'NAME/NODE DRIVER/ENDPOINT STATUS' ;;
  *) exit 0 ;;
esac
`
              )
              const env = { PATH: `${binDir}${NodePath.delimiter}${process.env["PATH"] ?? ""}` }
              const probes = HostProbes.none()

              const tool = await DockerExec.resolveDocker(env, probes)
              expect(tool.ok).toBe(true)

              // Missing docker refusal
              const missingTool = await DockerExec.resolveDocker({ PATH: NodePath.join(root, "empty") }, HostProbes.none())
              expect(missingTool.ok).toBe(false)

              // Pure helpers
              expect(DockerExec.pushTagRefusal(`v1-${slug}`)).toBeUndefined()
              for (const badTag of ["", "INVALID_UPPER:1", "has space:1", "http://bad/tag"]) {
                expect(DockerExec.pushTagRefusal(badTag)).toBeTruthy()
              }
              expect(DockerExec.outputDir("Docker.Build", `apps/${slug}`, { dockerfile: Input.file("Dockerfile"), context: "." })).toBeTruthy()
              expect(DockerExec.outputDir("Docker.Bake", `apps/${slug}`, { config: Input.file("docker-bake.hcl"), target: "app" })).toBeTruthy()
              expect(DockerExec.imageArchive("dist/img")).toBe("dist/img/image.tar")
              expect(DockerExec.loadedImageIds("Loaded image ID: sha256:abcdef0123456789\n")).toEqual([
                "sha256:abcdef0123456789"
              ])
              expect(
                DockerExec.pushedDigest("v1: digest: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef size: 100")
              ).toContain("sha256:")
              expect(
                DockerExec.manifestConfig(
                  JSON.stringify({ config: { digest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" } })
                )
              ).toContain("sha256:")
              expect(DockerExec.manifestConfig("not-json")).toBeUndefined()
              expect(DockerExec.containerName(`//apps/${slug}:serve`, ".", "inv-1")).toBeTruthy()

              // OCI Archive read + writeLoadableArchive + corrupt archive refusal
              const platforms = multiPlatform ? ["linux/amd64", "linux/arm64"] : ["linux/arm64"]
              const built = OciArchive.imageArchive({ platforms, dockerManifest, attestation, pax, seed: slug })
              const tarPath = NodePath.join(root, "image.tar")
              const loadablePath = NodePath.join(root, "loadable.tar")
              await Fs.writeFile(tarPath, built.bytes)
              const parsed = await DockerExec.readImageArchive(tarPath)
              if ("error" in parsed) {
                expect(typeof parsed.error).toBe("string")
              } else {
                await DockerExec.writeLoadableArchive(tarPath, loadablePath, parsed)
                const stat = await Fs.stat(loadablePath)
                expect(stat.size).toBeGreaterThan(0)
              }
              const badTar = NodePath.join(root, "bad.tar")
              await Fs.writeFile(badTar, "not-a-valid-tar")
              const badParsed = await DockerExec.readImageArchive(badTar)
              expect("error" in badParsed).toBe(true)

              // Plan Docker.Build / Docker.Bake / Docker.Push + prepareOutputs + serviceSpec
              await DockerExec.prepareOutputs(root, [`out/${slug}`])
              const planRes =
                rule === "Docker.Build"
                  ? await DockerExec.plan({
                      rule: "Docker.Build",
                      packagePath: "",
                      attrs: {
                        dockerfile: Input.file("Dockerfile"),
                        context: ".",
                        platforms: ["linux/arm64"],
                        buildArgs: { FOO: "bar" }
                      } as never,
                      environment: env,
                      probes
                    })
                  : rule === "Docker.Bake"
                  ? await DockerExec.plan({
                      rule: "Docker.Bake",
                      packagePath: "",
                      attrs: {
                        config: Input.file("docker-bake.hcl"),
                        target: "app" 
                      } as never,
                      environment: env,
                      probes
                    })
                  : await DockerExec.plan({
                      rule: "Docker.Push",
                      packagePath: "",
                      attrs: {
                        image: S.Docker.Build({
                          dockerfile: Input.file("Dockerfile"),
                          context: "."
                        }),
                        tags: [`ghcr.io/org/${slug}:v1`]
                      } as never,
                      environment: env,
                      probes
                    })
              expect(planRes).toBeDefined()

              // Empty tags push refusal
              const emptyPush = await DockerExec.plan({
                rule: "Docker.Push",
                packagePath: "",
                attrs: {
                  image: S.Docker.Build({ dockerfile: Input.file("Dockerfile"), context: "." }),
                  tags: []
                } as never,
                environment: env,
                probes
              })
              expect(emptyPush.refusal).toBeTruthy()

              // serviceSpec
              const svc = await DockerExec.serviceSpec({
                invocationId: `inv-${slug}`,
                label: `//apps/${slug}:svc`,
                cwd: ".",
                attrs: {
                  image: `ghcr.io/org/${slug}:v1`,
                  ports: { "8080": 18080 },
                  env: { MODE: "test" },
                  volumes: { "./data": "/data" }
                } as never,
                environment: env,
                probes
              })
              expect(svc).toBeDefined()
            })
            return true
          }),
        { executions: fsExecutions, seed: 20261202 }
      )
    )
    assertPassed(report)
  }, 120_000)

  it("NixExec resolveEnvironment/memo/assertToolVersion/satisfies & FoundryExec resolveMiseBin/plan fuzz invariants", async () => {
    const gen = Arbitrary.schema(
      Schema.Struct({
        slug: Slug,
        foundryRule: Schema.Literals(["Foundry.Build", "Foundry.Test", "Foundry.Fmt"]),
        foundryMode: Schema.Literals(["execute", "check", "write"]),
        forgeCfg: Schema.Literals(["default", "custom", "text", "fail"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        gen,
        ({ slug, foundryRule, foundryMode, forgeCfg }) =>
          Effect.promise(async () => {
            await withTempDir("smthrs-bc2-nixf-", async (root) => {
              // --- NixExec ---
              const hash = "0123456789abcdfghijklmnpqrsvwxyz"
              const closure = NodePath.join(root, "store", `${hash}-fake-env`)
              const dep = NodePath.join(root, "store", `${hash.split("").reverse().join("")}-fake-dep`)
              await Fs.mkdir(NodePath.join(closure, "bin"), { recursive: true })
              await Fs.mkdir(dep, { recursive: true })
              await writeExecutable(NodePath.join(closure, "bin", "node"), '#!/bin/sh\necho "v26.4.0"\n')
              await writeExecutable(NodePath.join(closure, "bin", "pnpm"), '#!/bin/sh\necho "11.21.0"\n')
              const fakeBin = NodePath.join(root, "fake-nix-bin")
              await Fs.mkdir(fakeBin, { recursive: true })
              await writeExecutable(
                NodePath.join(fakeBin, "nix"),
                `#!/bin/sh
case "$1" in --version) echo "nix (Nix) 2.99.0"; exit 0;; esac
sub=""
for a in "$@"; do case "$a" in build|print-dev-env|path-info) sub="$a"; break;; esac; done
case "$sub" in
  build) echo ${JSON.stringify(closure)};;
  print-dev-env) printf '%s' '{"variables":{"PATH":{"type":"exported","value":${JSON.stringify(`${closure}/bin`)}},"SSL_CERT_FILE":{"type":"exported","value":"/etc/ssl/cert.pem"}}}';;
  path-info) printf '%s\\n%s\\n' ${JSON.stringify(dep)} ${JSON.stringify(closure)};;
  *) exit 2;;
esac
`
              )
              await Fs.writeFile(NodePath.join(root, "flake.nix"), "{ outputs = { self }: { }; }\n")
              await Fs.writeFile(NodePath.join(root, "flake.lock"), '{"nodes":{},"root":"root","version":7}\n')

              const decl = Nix.Environment({ flake: Input.file("flake.nix"), lock: Input.file("flake.lock") })
              expect(NixExec.hostSystem("linux", "x64")).toBe("x86_64-linux")
              expect(NixExec.hostSystem("darwin", "arm64")).toBe("aarch64-darwin")
              expect(NixExec.satisfies("26.4.0", ">=26.4.0")).toBe(true)
              expect(NixExec.satisfies("20.0.0", ">=26.4.0")).toBe(false)

              const resolved = await NixExec.resolveEnvironment({
                root,
                declaration: decl,
                cacheDirectory: ".flows",
                environment: { PATH: fakeBin }
              })
              expect(NixExec.layer(resolved)).toContain("nix:")
              expect(NixExec.toolEnvironment(resolved).path.length).toBeGreaterThan(0)
              expect(NixExec.hostEnvironmentWith(resolved, { EXTRA: "1" })["EXTRA"]).toBe("1")

              // Second resolution hits disk memo
              const resolved2 = await NixExec.resolveEnvironment({
                root,
                declaration: decl,
                cacheDirectory: ".flows",
                environment: { PATH: fakeBin }
              })
              expect(resolved2.hash).toBe(resolved.hash)

              // assertToolVersion: pass, mismatch, missing
              const v = await NixExec.assertToolVersion(
                resolved,
                { name: "node", requirement: ">=26.4.0" },
                { root }
              )
              expect(v).toContain("26.4.0")
              let mismatchErr = false
              try {
                await NixExec.assertToolVersion(resolved, { name: "node", requirement: ">=99.0.0" }, { root })
              } catch (e) {
                mismatchErr = e instanceof NixExec.NixEnvironmentError
              }
              expect(mismatchErr).toBe(true)
              let missingToolErr = false
              try {
                await NixExec.assertToolVersion(resolved, { name: "nonexistent-tool", requirement: ">=1.0.0" }, { root })
              } catch (e) {
                missingToolErr = e instanceof NixExec.NixEnvironmentError
              }
              expect(missingToolErr).toBe(true)

              // Missing nix binary error
              let absentErr = false
              try {
                await NixExec.resolveEnvironment({
                  root,
                  declaration: decl,
                  environment: { PATH: NodePath.join(root, "empty") }
                })
              } catch (e) {
                absentErr = e instanceof NixExec.NixEnvironmentError && e.code === "nix_absent"
              }
              expect(absentErr).toBe(true)

              // --- FoundryExec ---
              const fBin = NodePath.join(root, "foundry-bin")
              await Fs.mkdir(fBin, { recursive: true })
              await writeExecutable(
                NodePath.join(fBin, "forge"),
                `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'forge Version: 1.2.3-fake\\nCommit SHA: abc\\n'; exit 0; fi
if [ "$1" = "config" ]; then
  case ${JSON.stringify(forgeCfg)} in
    fail) printf 'Error: bad foundry.toml\\n' >&2; exit 2;;
    text) printf 'Compiler run successful\\n';;
    custom) printf '{"out":"artifacts","cache_path":"compiler-cache","cache":false}\\n';;
    *) printf '{"out":"out","cache_path":"cache","cache":true}\\n';;
  esac
  exit 0
fi
exit 0
`
              )
              await Fs.writeFile(NodePath.join(root, "foundry.toml"), "[profile.default]\nsrc = 'src'\n")
              const ws = S.Workspace(`foundry-${slug}`, {
                repository: "git+https://example.invalid/foundry.git",
                cache: S.Cache({ directory: ".flows" })
              })
              const fPlan = await FoundryExec.plan({
                root,
                packagePath: "",
                workspace: ws,
                rule: foundryRule,
                mode: foundryMode,
                environment: { PATH: fBin },
                attrs: {
                  config: Input.file("foundry.toml"),
                  srcs: [Input.glob("src/**/*.sol")]
                } as never
              })
              expect(fPlan).toBeDefined()
              void (await FoundryExec.resolveMiseBin(root, S.Workspace("f", { repository: "git+https://example.invalid/f.git", cache: S.Cache({ directory: ".flows" }) }), "forge", { PATH: fBin }, HostProbes.none()))
            })
            return true
          }),
        { executions: fsExecutions, seed: 20261203 }
      )
    )
    assertPassed(report)
  }, 120_000)

  it("GitCommit, GitSubmoduleExec & MemoryBackend fuzz invariants on real temp git repos", async () => {
    const gen = Arbitrary.schema(
      Schema.Struct({
        slug: Slug,
        commitMode: Schema.Literals(["sweep-ok", "scoped-ok", "gates-fail", "empty", "gpg-fail"]),
        memMode: Schema.Literals(["ok", "unavailable", "failed"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        gen,
        ({ slug, commitMode, memMode }) =>
          Effect.promise(async () => {
            await withTempDir("smthrs-bc2-git-", async (root) => {
              await gitExec(root, ["init", "--quiet", "--initial-branch=main"])
              await gitExec(root, ["config", "core.autocrlf", "false"])
              await gitExec(root, ["config", "user.name", "smthrs fuzz"])
              await gitExec(root, ["config", "user.email", "fuzz@example.invalid"])
              await gitExec(root, ["config", "commit.gpgsign", "false"])
              await Fs.mkdir(NodePath.join(root, "scope"), { recursive: true })
              await Fs.writeFile(NodePath.join(root, "README.md"), "seed\n")
              await Fs.writeFile(NodePath.join(root, "scope", "owned.txt"), "base\n")
              await gitExec(root, ["add", "-A"])
              await gitExec(root, ["commit", "--quiet", "-m", "seed"])

              const commitTarget = S.Git.Commit({
                message: `fuzz: ${slug}`,
                gates: [S.Memory.Retain({ source: S.gitCommit("HEAD"), tags: ["fuzz"] })]
              })

              if (commitMode === "sweep-ok") {
                await Fs.writeFile(NodePath.join(root, "new.txt"), `body ${slug}\n`)
                const res = await GitCommit.commit({
                  root,
                  target: commitTarget,
                  sweepWorkingTree: true,
                  gateRunner: { run: async () => [] }
                })
                expect(res.sha.length).toBeGreaterThanOrEqual(7)
              } else if (commitMode === "scoped-ok") {
                await Fs.writeFile(NodePath.join(root, "scope", "owned.txt"), `updated ${slug}\n`)
                const res = await GitCommit.commit({
                  root,
                  target: commitTarget,
                  paths: ["scope"],
                  gateRunner: { run: async () => [] }
                })
                expect(res.sha.length).toBeGreaterThanOrEqual(7)
              } else if (commitMode === "gates-fail") {
                await Fs.writeFile(NodePath.join(root, "scope", "owned.txt"), `staged ${slug}\n`)
                await gitExec(root, ["add", "scope/owned.txt"])
                await Fs.writeFile(NodePath.join(root, "scope", "owned.txt"), `edited ${slug}\n`)
                let caught: unknown
                try {
                  await GitCommit.commit({
                    root,
                    target: commitTarget,
                    paths: ["scope"],
                    gateRunner: { run: async () => [{ target: "gate", message: "red" }] }
                  })
                } catch (e) {
                  caught = e
                }
                expect(GitCommit.isGitCommitError(caught)).toBe(true)
              } else if (commitMode === "empty") {
                let caught: unknown
                try {
                  await GitCommit.commit({
                    root,
                    target: commitTarget,
                    sweepWorkingTree: true,
                    gateRunner: { run: async () => [] }
                  })
                } catch (e) {
                  caught = e
                }
                expect(GitCommit.isGitCommitError(caught)).toBe(true)
              } else {
                await gitExec(root, ["config", "commit.gpgsign", "true"])
                await gitExec(root, ["config", "gpg.program", "false"])
                await Fs.writeFile(NodePath.join(root, "new.txt"), `gpg ${slug}\n`)
                let caught: unknown
                try {
                  await GitCommit.commit({
                    root,
                    target: commitTarget,
                    sweepWorkingTree: true,
                    gateRunner: { run: async () => [] }
                  })
                } catch (e) {
                  caught = e
                }
                expect(GitCommit.isGitCommitError(caught)).toBe(true)
              }

              // --- GitSubmoduleExec ---
              const sha1 = "1".repeat(40)
              await gitExec(root, ["update-index", "--add", "--cacheinfo", `160000,${sha1},deps/${slug}`])
              await Fs.writeFile(
                NodePath.join(root, ".gitmodules"),
                `[submodule "deps/${slug}"]\n\tpath = deps/${slug}\n\turl = https://example.invalid/${slug}.git\n`
              )
              const subPlan = await GitSubmoduleExec.plan({
                root,
                packagePath: "",
                rule: "Git.Submodule",
                attrs: { path: `deps/${slug}` } as never,
                environment: {}
              })
              expect(subPlan.gitlinks.length).toBe(1)
              expect(GitSubmoduleExec.isMaterialized(subPlan)).toBe(false)
              expect(await GitSubmoduleExec.verify(root, subPlan)).toBeTruthy()

              const multiPlan = await GitSubmoduleExec.plan({
                root,
                packagePath: "",
                rule: "Git.Submodules",
                attrs: { config: Input.file(".gitmodules"), paths: [`deps/${slug}`] } as never,
                environment: {}
              })
              expect(multiPlan.gitlinks.length).toBe(1)

              // --- MemoryBackend ---
              expect(MemoryBackend.parseMemoryHelpCommands("Commands:\n  get   Get\n  set   Set\n  list  List\n  rm    Rm\n")).toEqual([
                "get",
                "set",
                "list",
                "rm"
              ])
              MemoryBackend.assertMemoryCliCommand("set")
              let badCmd = false
              try {
                MemoryBackend.assertMemoryCliCommand("nope")
              } catch (e) {
                badCmd = MemoryBackend.isMemoryCapabilityMissing(e)
              }
              expect(badCmd).toBe(true)

              const fakeBin = NodePath.join(root, "mem-bin")
              await Fs.mkdir(fakeBin, { recursive: true })
              const fakeSmthrs = await writeExecutable(
                NodePath.join(fakeBin, "smithers"),
                `#!/bin/sh
if [ "$1" = "memory" ] && [ "$2" = "--help" ]; then
  printf 'Commands:\\n  get\\n  set\\n  list\\n  rm\\n'
  exit 0
fi
exit ${memMode === "failed" ? 2 : 0}
`
              )
              const locator = MemoryBackend.pathLocator({ PATH: fakeBin })
              expect(await locator.find()).toBe(fakeSmthrs)
              const spawned = MemoryBackend.spawnCli({ environment: { PATH: fakeBin } })
              const spawnRes = await spawned.run(fakeSmthrs, ["memory", "--help"], root)
              expect(spawnRes.exitCode).toBe(0)

              const retainTarget = S.Memory.Retain({ source: S.gitCommit("HEAD"), tags: ["fuzz", slug] })
              const memory = S.Memory.SmithersCloud({ bank: ["repo"] })
              if (memMode === "ok") {
                const calls: Array<ReadonlyArray<string>> = []
                const retained = await MemoryBackend.retain({
                  root,
                  target: retainTarget,
                  memory,
                  locator: { find: async () => fakeSmthrs },
                  cli: {
                    run: async (_bin, args) => {
                      calls.push(args)
                      return { exitCode: 0, stdout: "ok\n", stderr: "" }
                    }
                  }
                })
                expect(retained.facts.length).toBeGreaterThanOrEqual(1)
              } else if (memMode === "unavailable") {
                let unavail = false
                try {
                  await MemoryBackend.retain({
                    root,
                    target: retainTarget,
                    memory,
                    locator: { find: async () => undefined }
                  })
                } catch (e) {
                  unavail = MemoryBackend.isMemoryBackendUnavailable(e)
                }
                expect(unavail).toBe(true)
              } else {
                let cmdFailed = false
                try {
                  await MemoryBackend.retain({
                    root,
                    target: retainTarget,
                    memory,
                    locator: { find: async () => fakeSmthrs },
                    cli: {
                      run: async () => ({ exitCode: 2, stdout: "", stderr: "boom" })
                    }
                  })
                } catch (e) {
                  cmdFailed = MemoryBackend.isMemoryCommandFailed(e)
                }
                expect(cmdFailed).toBe(true)
              }
            })
            return true
          }),
        { executions: fsExecutions, seed: 20261204 }
      )
    )
    assertPassed(report)
  }, 120_000)
})
