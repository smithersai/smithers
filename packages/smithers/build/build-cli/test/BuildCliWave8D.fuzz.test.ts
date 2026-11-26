import { NodeServices } from "@effect/platform-node"
import { Fuzz } from "@smthrs/fuzz"
import { Smithers as S } from "@smthrs/targets"
import { Arbitrary, Effect, Schema } from "effect"
import * as NodeChildProcess from "node:child_process"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Http from "node:http"
import type { AddressInfo } from "node:net"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as DockerExec from "../src/DockerExec.ts"
import * as Engine from "../src/engine.ts"
import * as Executor from "../src/Executor.ts"
import * as FactoryProjectionExec from "../src/FactoryProjectionExec.ts"
import * as GithubRender from "../src/GithubRender.ts"
import * as GoExec from "../src/GoExec.ts"
import * as Machine from "../src/internal/Machine.ts"
import * as FetchExecutor from "../src/internal/rules/FetchExecutor.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as Planner from "../src/Planner.ts"
import * as Resolver from "../src/Resolver.ts"
import * as TestUnits from "../src/TestUnits.ts"
import { writeExecutable } from "./helpers/Executable.ts"

const executions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? "100")
const ioExecutions = Math.max(8, Math.min(executions, 14))
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

const writeFile = async (root: string, rel: string, content: string): Promise<string> => {
  const full = NodePath.isAbsolute(rel) ? rel : NodePath.join(root, rel)
  await Fs.mkdir(NodePath.dirname(full), { recursive: true })
  await Fs.writeFile(full, content, "utf8")
  return full
}

const slugArb = Schema.Literals(["r0", "r1", "r2", "r3"])

/** Build a tiny valid POSIX tar buffer with given filename -> content entries. */
const makeTar = (entries: ReadonlyArray<readonly [string, string | Buffer]>): Buffer => {
  const chunks: Array<Buffer> = []
  for (const [name, raw] of entries) {
    const body = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw
    const header = Buffer.alloc(512, 0)
    header.write(name, 0, Math.min(100, Buffer.byteLength(name)), "utf8")
    header.write("0000644\0", 100, 8, "ascii")
    header.write("0000000\0", 108, 8, "ascii")
    header.write("0000000\0", 116, 8, "ascii")
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii")
    header.write("00000000000\0", 136, 12, "ascii")
    header.fill(0x20, 148, 156)
    header[156] = 0x30
    header.write("ustar\0", 257, 6, "ascii")
    header.write("00", 263, 2, "ascii")
    let sum = 0
    for (let i = 0; i < 512; i++) sum += header[i]!
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii")
    chunks.push(header)
    chunks.push(body)
    const pad = (512 - (body.length % 512)) % 512
    if (pad > 0) chunks.push(Buffer.alloc(pad, 0))
  }
  chunks.push(Buffer.alloc(1024, 0))
  return Buffer.concat(chunks)
}

describe("@smthrs/build-cli Wave-8D: Resolver, PackageDiscovery, Planner, Executor, Engine, GoExec, GithubRender, DockerExec, FactoryProjectionExec, FetchExecutor & TestUnits deep fuzz", () => {
  it(
    "Resolver symlinks/#imports arrays/builtins/node_modules/scoped/dynamic, PackageDiscovery nested workspaces & workspaceFileAt, Planner bigint, Executor mergePlans & Engine hostile env",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          slug: slugArb,
          nestedKind: Schema.Literals(["dot_smithers", "workspace_ts"]),
          badSensitiveKind: Schema.Literals(["non_array", "throwing_getter", "bad_env_getter"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ slug, nestedKind, badSensitiveKind }) =>
            Effect.promise(async () => {
              await withTempDir("smthrs-w8d-core-", async (base) => {
                const root = NodePath.join(base, "ws")
                await Fs.mkdir(root, { recursive: true })

                // 1. Resolver deep fixture: symlinks (file, dir, broken), #imports array/conditions/builtin/invalid/pkg, scoped packages, node_modules relative, directory import, dynamic, query/fragment
                await writeFile(
                  root,
                  "package.json",
                  JSON.stringify({
                    name: "w8d-root",
                    imports: {
                      "#arr": [null, { unknownCond: "./nope.ts", default: "./src/real.ts" }],
                      "#builtin": "node:fs",
                      "#bad": "./not-allowed-rel",
                      "#ext": "@scope/pkg/sub",
                      "#deep": [[[[[[[[[["./too-deep.ts"]]]]]]]]]]
                    }
                  })
                )
                await writeFile(root, "src/real.ts", `export const r = "${slug}"\n`)
                await writeFile(root, "src/sub/index.ts", `export const sub = 1\n`)
                await writeFile(root, "src/asset.txt", `asset-${slug}\n`)
                await writeFile(
                  root,
                  "node_modules/@scope/pkg/package.json",
                  JSON.stringify({ name: "@scope/pkg", version: "1.0.0" })
                )
                await writeFile(root, "node_modules/@scope/pkg/sub.js", "export const x = 1\n")
                await writeFile(root, "node_modules/plain/index.js", "export const y = 2\n")
                await Fs.symlink("real.ts", NodePath.join(root, "src/sym-file.ts"))
                await Fs.symlink("sub", NodePath.join(root, "src/sym-dir"))
                await Fs.symlink("does-not-exist.ts", NodePath.join(root, "src/sym-broken.ts"))
                await writeFile(
                  root,
                  "src/entry.ts",
                  [
                    `import "#arr"`,
                    `import "#builtin"`,
                    `import "#bad"`,
                    `import "#ext"`,
                    `import "#deep"`,
                    `import "@scope/pkg/sub"`,
                    `import "@broken"`,
                    `import "@/empty"`,
                    `import "./sym-file.ts"`,
                    `import "./sym-dir"`,
                    `import "./sym-broken.ts"`,
                    `import "../node_modules/plain/index.js"`,
                    `import "../node_modules/@scope/pkg/sub.js"`,
                    `import "./asset.txt?raw#frag"`,
                    `import "/abs/path.ts"`,
                    `const dyn = (p: string) => import(p)`
                  ].join("\n")
                )

                const cfg = await Resolver.loadResolverConfig({ workspaceRoot: root })
                const closure = await Resolver.computeClosure({
                  config: cfg,
                  entries: ["src/entry.ts"]
                })
                expect(closure.result.files.length).toBeGreaterThanOrEqual(1)
                expect(closure.result.packages.some((p) => p.includes("@scope/pkg") || p.includes("plain"))).toBe(true)

                // 2. PackageDiscovery.workspaceFileAt (valid, directory, missing) & undeclared nested workspace detection
                await writeFile(root, "WORKSPACE.ts", "export const Workspace = 1\n")
                expect(await PackageDiscovery.workspaceFileAt(NodePath.join(root, "WORKSPACE.ts"))).toBe(
                  NodePath.join(root, "WORKSPACE.ts")
                )
                await expect(PackageDiscovery.workspaceFileAt(root)).rejects.toThrow(/not a regular file/)
                await expect(PackageDiscovery.workspaceFileAt(NodePath.join(root, "NOPE.ts"))).rejects.toThrow(
                  /does not exist/
                )

                const nestedDir = NodePath.join(root, "nested")
                if (nestedKind === "dot_smithers") {
                  await writeFile(nestedDir, ".smithers/WORKSPACE.ts", "export const Workspace = 1\n")
                } else {
                  await writeFile(nestedDir, "WORKSPACE.ts", "export const Workspace = 1\n")
                }
                await expect(PackageDiscovery.discover(root)).rejects.toThrow()
                await Fs.rm(nestedDir, { recursive: true, force: true })

                // 3. Planner.keyOf bigint error
                expect(() =>
                  Planner.keyOf({
                    version: 1,
                    target: "Shell.Test",
                    label: "//:bi",
                    inputs: { n: 42n }
                  } as never)
                ).toThrow(/bigint/)

                // 4. Executor.describeFailure massive payload exceeding Diagnostic.maximumMessageCodeUnits + budget exhaustion
                const hugeArr = Array.from({ length: 500 }, (_, i) => `item-${i}-${slug}-${"x".repeat(200)}`)
                const desc = Executor.describeFailure({ payload: hugeArr, extra: "z".repeat(40_000) })
                expect(desc.length).toBeLessThanOrEqual(100_000)
                expect(desc.length).toBeGreaterThan(10)

                // 5. Executor.mergePlans conflicting lint vs test verbs
                const baseTarget = (label: string, keyPreview: string) => ({
                  label,
                  package: "",
                  name: "t",
                  target: "Shell.Test",
                  rule: "Shell.Test",
                  kinds: ["test", "lint"] as const,
                  keyPreview,
                  cacheable: true,
                  dependencies: []
                })
                const p1 = { verb: "lint", pattern: "//:t", roots: ["//:t"], targets: [baseTarget("//:t", "k1")] }
                const p2 = { verb: "test", pattern: "//:t", roots: ["//:t"], targets: [baseTarget("//:t", "k2")] }
                expect(() => Executor.mergePlans([p1 as never, p2 as never])).toThrow()

                // 6. Engine hostile sensitiveEnvironment / environment getter validation
                if (badSensitiveKind === "non_array") {
                  await expect(
                    Engine.runInstall(root, { sensitiveEnvironment: "not-an-array" as never })
                  ).rejects.toThrow(/sensitiveEnvironment/)
                } else if (badSensitiveKind === "throwing_getter") {
                  const hostile: Array<string> = []
                  Object.defineProperty(hostile, 0, {
                    enumerable: true,
                    get() {
                      throw new Error("getter-boom")
                    }
                  })
                  hostile.length = 1
                  await expect(
                    Engine.runInstall(root, { sensitiveEnvironment: hostile })
                  ).rejects.toThrow(/sensitiveEnvironment/)
                } else {
                  const badEnv = new Proxy({}, {
                    ownKeys() {
                      throw new Error("env-boom")
                    }
                  })
                  await expect(
                    Engine.runInstall(root, { sensitiveEnvironment: ["BAD-NAME!"] })
                  ).rejects.toThrow(/environment/)
                }
              })
              return true
            }),
          { executions: ioExecutions, seed }
        )
      )
      assertPassed(report)
    },
    150_000
  )

  it(
    "GoExec (toolchain versions, resolveNix, Go.Packages/Difference/ModDownload/Generate/Fuzz & replace), GithubRender (runtimes, raw steps, unchanged write), DockerExec (corrupt archive), FactoryProjectionExec (stale home check/write) & FetchExecutor (body_too_large & transportReason)",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          slug: slugArb,
          goEmptyGenerate: Schema.Boolean,
          nixHasBin: Schema.Boolean,
          runtimeKind: Schema.Literals(["node_file", "bun", "go", "none"]),
          factoryMode: Schema.Literals(["check", "write"]),
          fetchFailKind: Schema.Literals(["content_length", "conn_refused"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ slug, goEmptyGenerate, nixHasBin, runtimeKind, factoryMode, fetchFailKind }) =>
            Effect.promise(async () => {
              await withTempDir("smthrs-w8d-exec-", async (base) => {
                const root = NodePath.join(base, "ws")
                const binDir = NodePath.join(base, "bin")
                const extMod = NodePath.join(base, "ext-mod")
                await Fs.mkdir(root, { recursive: true })
                await Fs.mkdir(binDir, { recursive: true })
                await Fs.mkdir(extMod, { recursive: true })

                // 1. GoExec: fake `go` handling `version` and `list -json` (returning both in-tree & replaced out-of-tree module!)
                await writeFile(root, "go.mod", `module example.com/w8d\n\ngo 1.23\n`)
                await writeFile(root, "go.sum", `example.com/dep v1.0.0 h1:abc=\n`)
                await writeFile(root, "flake.nix", `{}\n`)
                await writeFile(root, "flake.lock", `{"nodes":{}}\n`)
                await writeFile(root, "pkg/a/a.go", `package a\n`)
                await writeFile(root, "pkg/b/b.go", `package b\n`)
                await writeFile(extMod, "ext.go", `package ext\n`)
                const goroot = NodePath.join(base, "goroot")
                const gotooldir = NodePath.join(goroot, "pkg/tool")
                await Fs.mkdir(NodePath.join(goroot, "bin"), { recursive: true })
                await Fs.mkdir(gotooldir, { recursive: true })
                await writeExecutable(NodePath.join(goroot, "bin/go"), "#!/bin/sh\necho ok\n")
                await writeExecutable(NodePath.join(gotooldir, "compile"), "#!/bin/sh\necho ok\n")

                const goStubPath = await writeExecutable(
                  NodePath.join(binDir, "go"),
                  `#!/bin/sh
if [ "$1" = "version" ]; then
  echo "go version go1.23.0 linux/amd64"
  exit 0
fi
if [ "$1" = "env" ]; then
  printf '{"GOROOT":"%s","GOTOOLDIR":"%s"}\n' "${goroot}" "${gotooldir}"
  exit 0
fi
if [ "$1" = "list" ]; then
  case "$*" in
    *"./empty"*)
      exit 0
      ;;
    *"./pkg/b"*)
      printf '{"ImportPath":"example.com/w8d/pkg/b","Dir":"%s/pkg/b","GoFiles":["b.go"]}\\n' "${root}"
      exit 0
      ;;
    *)
      printf '{"ImportPath":"example.com/w8d/pkg/a","Dir":"%s/pkg/a","GoFiles":["a.go"],"Module":{"Path":"example.com/w8d","Dir":"%s","Main":true}}\\n' "${root}" "${root}"
      printf '{"ImportPath":"example.com/ext","Dir":"%s","GoFiles":["ext.go"],"Module":{"Path":"example.com/ext","Dir":"%s","Replace":{"Path":"%s","Dir":"%s"}}}\\n' "${extMod}" "${extMod}" "${extMod}" "${extMod}"
      exit 0
      ;;
  esac
fi
exit 0
`
                )

                const goWs = S.Workspace("go-w8d", {
                  repository: "git+https://example.invalid/go-w8d.git",
                  cache: S.Cache({ directory: ".flows" }),
                  toolchains: [
                    S.Go.Toolchain({
                      mod: S.file("//go.mod"),
                      sum: S.file("//go.sum"),
                      versions: S.Nix.DevShell({ flake: S.file("//flake.nix"), lock: S.file("//flake.lock") })
                    })
                  ]
                })

                const nixCtx: GoExec.Context = {
                  root,
                  packagePath: "",
                  workspace: goWs,
                  environment: { PATH: binDir },
                  nix: {
                    path: [nixHasBin ? binDir : NodePath.join(base, "empty-nix")],
                    hash: "nix-hash-123",
                    inputs: [{ path: "flake.nix", digest: "0".repeat(64) }],
                    storePath: "/nix/store/fake",
                    closure: [],
                    variables: {},
                    nix: "2.24.0",
                    system: "x86_64-linux"
                  } as never
                }
                const nixRes = await GoExec.resolveNix("go", nixCtx)
                expect(nixRes.ok).toBe(nixHasBin)

                const goCtx: GoExec.Context = {
                  root,
                  packagePath: "",
                  workspace: goWs,
                  environment: { PATH: `${binDir}${NodePath.delimiter}/usr/bin:/bin` },
                  nix: {
                    path: [binDir],
                    hash: "nix-hash-123",
                    inputs: [{ path: "flake.nix", digest: "0".repeat(64) }],
                    storePath: "/nix/store/fake",
                    closure: [],
                    variables: {},
                    nix: "2.24.0",
                    system: "x86_64-linux"
                  } as never
                }
                const resolvedGo = await GoExec.resolveGo(goCtx)
                expect(resolvedGo.ok).toBe(true)

                const modDl = S.Go.ModDownload({
                  mod: S.file("//go.mod"),
                  sum: S.file("//go.sum"),
                  outDirs: ["//.gomodcache"],
                  sandbox: { network: true }
                })
                const pkgsAll = S.Go.Packages({ pkgs: ["./pkg/..."] })
                const pkgsB = S.Go.Packages({ pkgs: ["./pkg/b"] })
                const diffPkgs = S.Files.difference(pkgsAll, pkgsB)

                const genPlan = await GoExec.planRule(
                  "Go.Generate",
                  {
                    pkgs: goEmptyGenerate ? ["./empty"] : diffPkgs,
                    changes: ["pkg/**"],
                    data: [modDl]
                  },
                  goCtx,
                  goStubPath
                )
                if (goEmptyGenerate) {
                  expect(genPlan.refusal).toContain("empty")
                } else {
                  expect(genPlan.argv).toContain("generate")
                  expect(genPlan.closureIdentity).toBeDefined()
                }

                const fuzzPlan = await GoExec.planRule(
                  "Go.Fuzz",
                  { pkg: "./pkg/a", fuzz: "FuzzDemo", fuzzTime: "1s", data: [modDl] },
                  goCtx,
                  goStubPath
                )
                expect(fuzzPlan.argv).toContain("test")

                // 2. GithubRender with node-version-file / bun / go / undefined runtimes + raw steps + unchanged write
                const rawSteps = [
                  { uses: "actions/checkout@v4", with: { fetchDepth: "0" } },
                  { run: "echo single-line", id: "s1", if: "always()", shell: "bash", workingDirectory: "." },
                  { run: ["echo line1", "echo line2"], env: { FOO: slug } },
                  { name: "Named Uses", uses: "actions/cache@v4", with: { path: ".flows" } },
                  { name: "Named Run", run: "echo named" }
                ]
                const runT = S.Shell.Test({ shell: "echo ok", sandbox: "none" })
                const wfSteps = S.Github.Workflow({
                  name: "ci-steps",
                  on: { push: { branches: ["main"] } },
                  runsOn: "ubuntu-latest",
                  steps: rawSteps as never
                })
                const wfRun = S.Github.Workflow({
                  name: "ci-run",
                  on: { push: { branches: ["main"] } },
                  runsOn: "ubuntu-latest",
                  run: [runT]
                })
                const ghRuntime = runtimeKind === "node_file"
                  ? S.Runtime.Node({ manifest: S.file("//.nvmrc") })
                  : runtimeKind === "bun"
                  ? S.Runtime.Bun({ version: "1.2.0" })
                  : runtimeKind === "go"
                  ? undefined
                  : undefined
                await writeFile(root, ".nvmrc", "22\n")
                await writeFile(root, "package.json", JSON.stringify({ name: "gh-w8d", version: "1.0.0" }))
                await writeFile(root, "yarn.lock", "")
                const ghPkgJson = S.file("//package.json")
                const ciGen = S.Github.CiGen({ workflows: [wfSteps, wfRun] })
                const ghWorkspace = S.Workspace("gh-w8d", {
                  repository: "git+https://example.invalid/gh.git",
                  cache: S.Cache({ directory: ".flows" }),
                  ...(ghRuntime === undefined
                    ? {}
                    : {
                      runtime: ghRuntime,
                      packageManager: S.PackageManager.Yarn({ manifest: ghPkgJson, lockfile: S.file("//yarn.lock") }),
                      nodeModules: S.Npm.NodeModules({ packageJson: ghPkgJson })
                    }),
                  ...(runtimeKind === "go"
                    ? {
                      toolchains: [
                        S.Go.Toolchain({
                          mod: S.file("//go.mod"),
                          sum: S.file("//go.sum"),
                          versions: S.Nix.DevShell({ flake: S.file("//flake.nix"), lock: S.file("//flake.lock") })
                        })
                      ]
                    }
                    : {})
                })
                const ghIndex = PackageIndex.make({
                  root,
                  workspace: ghWorkspace,
                  factory: undefined,
                  packages: [{
                    file: "PACKAGE.ts",
                    packagePath: "",
                    value: S.Package({ targets: { runT, wfSteps, wfRun, ciGen } })
                  }]
                })
                const rendered = GithubRender.render({
                  ciGen,
                  workspace: ghWorkspace,
                  resolve: ghIndex,
                  packageDir: ""
                })
                expect(rendered.files.length).toBeGreaterThanOrEqual(1)
                const firstWrite = await GithubRender.write(root, rendered)
                expect(firstWrite).toBeDefined()
                // Second write hits `existing === file.content` -> unchanged!
                const secondWrite = await GithubRender.write(root, rendered)
                expect(secondWrite.unchanged.length).toBeGreaterThanOrEqual(1)

                // 3. DockerExec.readImageArchive with corrupt manifest digest (ImageArchiveError L303-317)
                const badTar = makeTar([
                  [
                    "manifest.json",
                    JSON.stringify([{ Config: "blobs/sha256/not-a-valid-digest", RepoTags: ["t:1"], Layers: [] }])
                  ]
                ])
                const tarPath = NodePath.join(base, "bad-image.tar")
                await Fs.writeFile(tarPath, badTar)
                const imgRes = await DockerExec.readImageArchive(tarPath)
                expect("error" in imgRes).toBe(true)

                // 4. FactoryProjectionExec check/write when stale homeOutput exists but FACTORY.ts exports no home
                const projWs = NodePath.join(base, "proj-ws")
                await Fs.mkdir(projWs, { recursive: true })
                await writeFile(
                  projWs,
                  ".smithers/flows/demo/SKILL.md",
                  "---\nname: demo\ndescription: demo flow\n---\n# Demo\n"
                )
                await writeFile(projWs, "stale-home.json", "{}\n")
                const projExit = await Effect.runPromise(
                  Effect.exit(
                    FactoryProjectionExec.renderProjection(projWs, {
                      mode: factoryMode,
                      root: ".smithers/flows",
                      workflows: ".smithers/workflows",
                      output: "catalog.json",
                      homeOutput: "stale-home.json",
                      home: null,
                      factory: S.Factory({ summary: "demo factory", flows: [] })
                    }).pipe(Effect.provide(NodeServices.layer))
                  )
                )
                expect(["Success", "Failure"]).toContain(projExit._tag)

                // 5. FetchExecutor.download with Content-Length > limitBytes & connection refused transportReason
                const digest = createHash("sha256").update("x").digest("hex")
                if (fetchFailKind === "content_length") {
                  const srv = Http.createServer((_req, res) => {
                    res.writeHead(200, { "content-length": "999999999" })
                    res.end("x")
                  })
                  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve))
                  const port = (srv.address() as AddressInfo).port
                  try {
                    await expect(
                      FetchExecutor.download({
                        root: base,
                        url: `http://127.0.0.1:${port}/big`,
                        outFile: "fetched.bin",
                        sha256: digest,
                        limitBytes: 1024
                      })
                    ).rejects.toThrow(/over the 1024 limit|body_too_large/i)
                  } finally {
                    await new Promise<void>((resolve) => srv.close(() => resolve()))
                  }
                } else {
                  await expect(
                    FetchExecutor.download({
                      root: base,
                      url: "http://127.0.0.1:1/unreachable",
                      outFile: "fetched.bin",
                      sha256: digest
                    })
                  ).rejects.toThrow(/Fetch request failed/i)
                }

                // 6. TestUnits discover/select in a multi-package workspace with strict/conservative globalInputs
                const tuWs = NodePath.join(base, "tu-ws")
                await writeFile(tuWs, "package.json", JSON.stringify({ name: "tu-root", private: true }))
                await writeFile(tuWs, "packages/a/package.json", JSON.stringify({ name: "@tu/a", version: "1.0.0" }))
                await writeFile(tuWs, "packages/a/src/index.ts", `export const a = "${slug}"\n`)
                await writeFile(
                  tuWs,
                  "packages/b/package.json",
                  JSON.stringify({ name: "@tu/b", version: "1.0.0", dependencies: { "@tu/a": "workspace:*" } })
                )
                await writeFile(tuWs, "packages/b/test/b.test.ts", `import { a } from "@tu/a"\nconsole.log(a)\n`)
                await writeFile(tuWs, "global.config.ts", `export const g = 1\n`)
                const bTest = S.Vitest({
                  config: S.file("//package.json"),
                  tests: [S.glob("test/*.test.ts")],
                  sources: [S.glob("src/**")],
                  environment: "node",
                  passWithNoTests: false,
                  units: "file",
                  deps: []
                })
                const tuIndex = PackageIndex.make({
                  root: tuWs,
                  workspace: S.Workspace("tu-w8d", {
                    repository: "git+https://example.invalid/tu.git",
                    cache: S.Cache({ directory: ".flows" })
                  }),
                  factory: undefined,
                  packages: [{
                    file: "packages/b/PACKAGE.ts",
                    packagePath: "packages/b",
                    value: S.Package({ targets: { test: bTest } })
                  }]
                })
                const discovered = await TestUnits.discover({
                  index: tuIndex,
                  target: "//packages/b:test"
                })
                expect(discovered.units.length).toBe(1)
              })
              return true
            }),
          { executions: ioExecutions, seed }
        )
      )
      assertPassed(report)
    },
    150_000
  )
})
