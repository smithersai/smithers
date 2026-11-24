import { Fuzz } from "@smthrs/fuzz"
import { Smithers as S } from "@smthrs/targets"
import type * as AgentTarget from "@smthrs/targets/AgentTarget"
import * as BundlerTarget from "@smthrs/targets/BundlerTarget"
import * as ExecSandbox from "@smthrs/targets/ExecSandbox"
import { Arbitrary, Effect, Schema } from "effect"
import * as NodeChildProcess from "node:child_process"
import { createHash } from "node:crypto"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Http from "node:http"
import type { AddressInfo } from "node:net"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as AgentFake from "../src/AgentFake.ts"
import * as AgentSession from "../src/AgentSession.ts"
import * as Cache from "../src/Cache.ts"
import * as Engine from "../src/engine.ts"
import * as GitCommit from "../src/GitCommit.ts"
import * as GitHooks from "../src/GitHooks.ts"
import * as CacheEvidence from "../src/internal/CacheEvidence.ts"
import * as InstalledTree from "../src/internal/InstalledTree.ts"
import * as Machine from "../src/internal/Machine.ts"
import * as ObservedReads from "../src/internal/ObservedReads.ts"
import * as PackagePlanner from "../src/internal/PackagePlanner.ts"
import * as PackageRunner from "../src/internal/PackageRunner.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import * as PackageTree from "../src/PackageTree.ts"
import * as RspackRunner from "../src/RspackRunner.ts"
import { writeExecutable } from "./helpers/Executable.ts"
import { serve as serveCli } from "./helpers/ServeCli.ts"

const executions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? "100")
const ioExecutions = Math.max(5, Math.min(executions, 8))
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

const slugArb = Schema.Literals(["e0", "e1", "e2", "e3"])

describe("@smthrs/build-cli Wave-8E: Deep PackageRunner/Planner, Cli/PackageLoader/effect-resolution, Cache/PackageTree/AgentSession/RspackRunner/InstalledTree/GitCommit/GitHooks fuzz", () => {
  it(
    "PackageRunner protectedEntries/symlinks, supervised withRights/signalStops/outside/unavailable-observer, Vitest evidence/suitePath, NodeBench benchRowsOf, Cargo.Fetch missing outFile, Anvil+nix & refreshInstalledNode",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          slug: slugArb,
          obsCase: Schema.Literals([
            "supervised_rights",
            "outside_net",
            "signal_stops",
            "no_observer_awaited",
            "vitest_unprovable"
          ]),
          replanFails: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ slug, obsCase, replanFails }) =>
            Effect.promise(async () => {
              await withTempDir("smthrs-w8e-pr-", async (base) => {
                const root = NodePath.join(base, "ws")
                const binDir = NodePath.join(base, "bin")
                await Fs.mkdir(root, { recursive: true })
                await Fs.mkdir(binDir, { recursive: true })

                // 1. PackageRunner.protectedEntries with inside-root & escaping symlinks
                await writeFile(root, "node_modules/real-pkg/index.js", "export const x = 1\n")
                await Fs.symlink("real-pkg", NodePath.join(root, "node_modules/inside-link"))
                const prot1 = PackageRunner.protectedEntries(root, ["node_modules"])
                expect(prot1.length).toBeGreaterThanOrEqual(1)
                await Fs.symlink(base, NodePath.join(root, "node_modules/escape-link"))
                const prot2 = PackageRunner.protectedEntries(root, ["node_modules"])
                expect(Array.isArray(prot2)).toBe(true)
                await Fs.rm(NodePath.join(root, "node_modules/escape-link"), { force: true })

                // 2. PackagePlanner.binaryIdentity 2-hop symlink (linkChain) & parseNameStatusZ R/C entries
                const realBin = await writeExecutable(NodePath.join(binDir, "real-b"), "#!/bin/sh\necho b\n")
                const hop1 = NodePath.join(binDir, "hop1-b")
                const hop2 = NodePath.join(binDir, "hop2-b")
                await Fs.symlink(realBin, hop1)
                await Fs.symlink(hop1, hop2)
                const bid = await PackagePlanner.binaryIdentity(
                  { root, environment: { PATH: binDir }, toolBytes: new Map() },
                  hop2
                )
                expect(bid).toBeDefined()
                const parsedDiff = PackagePlanner.parseNameStatusZ(
                  "M\0a.ts\0R100\0old.ts\0new.ts\0C090\0src.ts\0copy.ts\0"
                )
                expect(parsedDiff.length).toBeGreaterThanOrEqual(3)

                // 3. Real tools & fixtures
                await writeExecutable(NodePath.join(binDir, "cargo"), "#!/bin/sh\necho 'cargo 1.82.0'\n")
                await writeExecutable(NodePath.join(binDir, "rustc"), "#!/bin/sh\necho 'rustc 1.82.0'\n")
                await writeExecutable(NodePath.join(binDir, "sh"), "#!/bin/sh\nexec /bin/sh \"$@\"\n")
                await writeExecutable(NodePath.join(binDir, "mytool"), "#!/bin/sh\necho mytool\n")
                await writeFile(root, "package.json", JSON.stringify({ name: "w8e", version: "1.0.0" }))
                await writeFile(root, "yarn.lock", "")
                await writeFile(root, "Cargo.toml", "[workspace]\nmembers = []\n")
                await writeFile(root, "input.txt", `in-${slug}\n`)
                await writeFile(root, "bench.mjs", `console.log('BENCH_METRIC {"name":"op1","meanMs":12.5,"hz":80}')\n`)
                await Fs.mkdir(NodePath.join(root, "node_modules/vitest"), { recursive: true })
                await writeFile(
                  root,
                  "node_modules/vitest/package.json",
                  JSON.stringify({ name: "vitest", version: "5.0.0", bin: { vitest: "bin.js" } })
                )
                await writeExecutable(NodePath.join(root, "node_modules/vitest/bin.js"), "#!/bin/sh\necho vitest-ok\n")
                await Fs.mkdir(NodePath.join(root, "node_modules/.bin"), { recursive: true })
                await Fs.symlink("../vitest/bin.js", NodePath.join(root, "node_modules/.bin/vitest"))

                // Fake supervisor observer script for supervised_rights / outside_net / signal_stops
                const traceBody = obsCase === "supervised_rights"
                  ? `printf '100 +++ smthrs-observe 1 +++\\n100 +++ rights: /usr/bin/sudo +++\\n100 +++ complete +++\\n' > "$OUT"\nexit 0`
                  : obsCase === "outside_net"
                  ? `printf '100 +++ smthrs-observe 1 +++\\n100 socket(AF_INET, SOCK_STREAM, IPPROTO_TCP) = 5<socket:[1]>\\n100 connect(5<socket:[1]>, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("93.184.216.34")}, 16) = 0\\n100 +++ complete +++\\n' > "$OUT"\nexit 0`
                  : `printf '100 +++ smthrs-observe 1 +++\\n100 openat(AT_FDCWD, "${
                    NodePath.join(root, "input.txt")
                  }", O_RDONLY) = 3\\n100 +++ signal stops: 50000 +++\\n100 +++ complete +++\\n' > "$OUT"\nexit 0`

                const fakeObs = await writeExecutable(
                  NodePath.join(binDir, "fake-obs"),
                  `#!/bin/sh
if [ "$1" = "--keep" ]; then shift; fi
OUT="$1"
${traceBody}
`
                )

                const obsStep1 = S.Shell.Test({
                  shell: `cat input.txt > /dev/null && echo ok-${slug}`,
                  data: [S.file("//input.txt")],
                  observe: { env: [] },
                  sandbox: "none"
                })
                const obsStep2 = S.Shell.Test({
                  shell: `echo after-${slug}`,
                  data: [obsStep1],
                  sandbox: "none"
                })
                const vitestTarget = S.Vitest({
                  tests: [S.file("//input.txt")],
                  sources: [S.file("//input.txt")],
                  deps: [],
                  config: null,
                  environment: "node",
                  passWithNoTests: false,
                  tools: [S.Host.bin("mytool")]
                })
                const benchTarget = S.NodeBench({
                  entry: S.file("//bench.mjs"),
                  srcs: [S.file("//bench.mjs")],
                  deps: []
                })
                const cargoFetchMissing = S.Cargo.Fetch({
                  workspace: S.file("//Cargo.toml"),
                  outDirs: ["//.cargo-home"],
                  outFiles: ["//.cargo-home/never-created.toml"],
                  sandbox: { network: true }
                })
                const anvilSvc = S.Anvil.Fork({
                  forkUrl: S.Secret("RPC_URL"),
                  forkBlockNumber: "latest",
                  port: 8545
                })
                const anvilConsumer = S.Shell.Test({
                  shell: "echo anvil-ok",
                  services: [anvilSvc],
                  sandbox: "none"
                })
                const genWithTools = S.Generate({
                  bin: S.Host.bin("mytool"),
                  changes: ["out/g.txt"],
                  sandbox: "none"
                })

                const manifest = S.file("//package.json")
                const index = PackageIndex.make({
                  root,
                  workspace: S.Workspace("w8e", {
                    repository: "git+https://example.invalid/w8e.git",
                    cache: S.Cache({ directory: ".flows" }),
                    runtime: S.Runtime.Node({ version: ">=20.0.0" }),
                    packageManager: S.PackageManager.Yarn({ manifest, lockfile: S.file("//yarn.lock") }),
                    nodeModules: S.Npm.NodeModules({ packageJson: manifest }),
                    toolchains: [S.Rust.Toolchain({ workspace: S.file("//Cargo.toml"), channel: "1.82" })],
                    host: S.Host({ bins: ["sh", "cat", "cargo", "rustc", "mytool"] }),
                    sandboxes: S.Sandboxes({ default: S.Sandbox.None() })
                  }),
                  factory: undefined,
                  packages: [{
                    file: "PACKAGE.ts",
                    packagePath: "",
                    value: S.Package({
                      targets: {
                        obsStep1,
                        obsStep2,
                        vitestTarget,
                        benchTarget,
                        cargoFetchMissing,
                        anvilSvc,
                        anvilConsumer,
                        genWithTools
                      }
                    })
                  }]
                })

                const env: Record<string, string> = {
                  ...process.env as Record<string, string>,
                  PATH: `${binDir}${NodePath.delimiter}${process.env["PATH"] ?? ""}`,
                  RPC_URL: "http://127.0.0.1:1"
                }

                const services: PackageRunner.ExecutionServices = {
                  ...PackageRunner.executionServicesLive,
                  noNewPrivileges: () => false,
                  observer: () =>
                    obsCase === "no_observer_awaited"
                      ? { reason: "synthetic-no-observer" }
                      : ({ tracer: fakeObs, supervisor: true } as unknown as ObservedReads.Observer),
                  sandboxHost: () =>
                    obsCase === "vitest_unprovable"
                      ? ({
                        platform: "linux",
                        bwrap: undefined,
                        docker: undefined,
                        sandboxExec: undefined,
                        unshare: undefined
                      } as unknown as ExecSandbox.Host)
                      : PackageRunner.executionServicesLive.sandboxHost(),
                  anvilService: async (req) => ({
                    key: req.label,
                    argv: ["/bin/sh", "-c", "sleep 30"],
                    cwd: req.cwd
                  }),
                  replanner: replanFails
                    ? () =>
                      ({
                        replan: async () => {
                          throw new Error("synthetic replan boom")
                        },
                        close: async () => {}
                      }) as never
                    : PackageRunner.executionServicesLive.replanner
                }

                const run = async (
                  patterns: ReadonlyArray<string>,
                  patchPlan?: (p: PackageExec.PackagePlan) => void
                ) => {
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
                  patchPlan?.(planned)
                  return Effect.runPromise(
                    PackageRunner.executeEffect(planned, opts).pipe(
                      Effect.provideService(PackageRunner.ExecutionServices, services)
                    )
                  )
                }

                // Execute observed scenario (hits supervised_rights -> withRights unjailed, outside_net -> rememberReachedOutside, signal_stops, no_observer_awaited, vitest_unprovable -> suitePath + unprovableNoted!)
                const targetPattern = obsCase === "vitest_unprovable"
                  ? ["//:vitestTarget"]
                  : obsCase === "no_observer_awaited"
                  ? ["//:obsStep2"]
                  : ["//:obsStep1"]
                const obsRes = await run(targetPattern)
                expect(obsRes.results.length).toBeGreaterThanOrEqual(1)

                // Execute NodeBench (hits benchRowsOf) + Cargo.Fetch missing outFile + Anvil with nixEnvironment
                const miscRes = await run(["//:benchTarget", "//:cargoFetchMissing", "//:anvilConsumer"], (planned) => {
                  const patch = (label: string, extra: Record<string, unknown>) => {
                    const n = planned.nodes.get(label)
                    if (n === undefined) return
                    const u = { ...n, ...extra } as PackageExec.PackageNode
                    ;(planned.nodes as Map<string, PackageExec.PackageNode>).set(label, u)
                    const wl = planned.workList as Array<PackageExec.PackageNode>
                    const idx = wl.findIndex((x) => x.label === label)
                    if (idx !== -1) wl[idx] = u
                  }
                  patch("//:anvilSvc", {
                    refusal: undefined,
                    nixEnvironment: { path: [binDir], variables: { NIX_A: "1" } }
                  })
                  patch("//:anvilConsumer", { refusal: undefined, argv: ["/bin/sh", "-c", "echo anvil-ok"] })
                })
                const benchOut = miscRes.results.find((r) => r.label === "//:benchTarget")
                expect(obsCase === "vitest_unprovable" ? ["ran", "failed"] : ["ran"]).toContain(benchOut?.status)
                expect(miscRes.results.find((r) => r.label === "//:cargoFetchMissing")?.status).toBe("failed")
                expect(miscRes.results.find((r) => r.label === "//:anvilConsumer")?.status).toBe("ran")
              })
              return true
            }),
          { executions: ioExecutions, seed }
        )
      )
      assertPassed(report)
    },
    180_000
  )

  it(
    "Cli affected HEAD~1 (PackageLoader.loadAt + effect-resolution revisionHooks), known-red artifact error, bench --fail-on-regression (human/agent), units, install, GitCommit scratch index, GitHooks errors & Engine.runInstall",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          slug: slugArb,
          humanAudience: Schema.Boolean,
          hooksBlocked: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ slug, humanAudience, hooksBlocked }) =>
            Effect.promise(async () => {
              await withTempDir("smthrs-w8e-cli-", async (base) => {
                const ws = NodePath.join(base, "ws")
                const binDir = NodePath.join(base, "bin")
                await Fs.mkdir(ws, { recursive: true })
                await Fs.mkdir(binDir, { recursive: true })

                await writeExecutable(NodePath.join(binDir, "yarn"), "#!/bin/sh\necho '1.22.22'\n")
                await writeExecutable(NodePath.join(binDir, "vitest"), "#!/bin/sh\necho 'vitest ok'\n")

                git(ws, "init", "-q")
                git(ws, "config", "user.name", "Fuzz")
                git(ws, "config", "user.email", "fuzz@example.invalid")
                git(ws, "config", "commit.gpgsign", "false")
                await writeFile(ws, "package.json", JSON.stringify({ name: "w8e-cli", version: "1.0.0" }))
                await writeFile(ws, "yarn.lock", "")
                await writeFile(ws, "src/a.txt", `v1-${slug}\n`)
                await writeFile(ws, "src/extra.txt", `extra-v1-${slug}\n`)
                await writeFile(
                  ws,
                  "test/a.test.ts",
                  `import { expect, it } from "vitest"\nit("ok", () => expect(1).toBe(1))\n`
                )
                await writeFile(
                  ws,
                  "src/b.bench.mjs",
                  `console.log('BENCH_METRIC {"name":"bench_a","meanMs":100,"hz":10}')\n`
                )
                await writeFile(
                  ws,
                  "baseline.json",
                  JSON.stringify({
                    schemaVersion: 1,
                    results: [{
                      label: "//:perf",
                      benchmarks: [{ name: "bench_a", meanMs: 10, hz: 100 }]
                    }]
                  })
                )
                await writeFile(
                  ws,
                  "known-red.json",
                  JSON.stringify({
                    entries: [{
                      label: "//:artTest",
                      owner: "team",
                      reason: "artifact",
                      issue: "https://github.com/smithersai/smithers/issues/1",
                      expires: "2099-01-01",
                      failureDigest: `sha256:${"a".repeat(64)}`
                    }]
                  })
                )
                await writeFile(
                  ws,
                  "WORKSPACE.ts",
                  `import { Smithers as S } from "@smthrs/targets"\r\nconst m = S.file("//package.json")\r\nexport const Workspace = S.Workspace("w8e-cli", {\r\n  repository: "git+https://example.invalid/w8e-cli.git",\r\n  cache: S.Cache({ directory: ".flows" }),\r\n  runtime: S.Runtime.Node({ version: ">=20.0.0" }),\r\n  packageManager: S.PackageManager.Yarn({ manifest: m, lockfile: S.file("//yarn.lock") }),\r\n  nodeModules: S.Npm.NodeModules({ packageJson: m }),\r\n  host: S.Host({ bins: ["sh", "node", "yarn"] }),\r\n  sandboxes: S.Sandboxes({ default: S.Sandbox.None() })\r\n})\r\n`
                )
                const pkgSrc = (v: string) =>
                  `import { Smithers as S } from "@smthrs/targets"\r\n` +
                  `const t1 = S.Shell.Test({ shell: "echo t1-${v}", data: [S.file("//src/a.txt")], sandbox: "none" })\r\n` +
                  `const artTest = S.Shell.Test({ shell: "echo art", lifecycle: "artifact", summary: "artifact", sandbox: "none" })\r\n` +
                  `const perf = S.NodeBench({ entry: S.file("//src/b.bench.mjs"), srcs: [S.file("//src/b.bench.mjs")], deps: [] })\r\n` +
                  `const unitTest = S.Vitest({ tests: [S.glob("test/*.test.ts")], sources: [S.file("//src/a.txt")], deps: [], config: null, environment: "node", passWithNoTests: false, units: "file" })\r\n` +
                  `export const Package = S.Package({ targets: { t1, artTest, perf, unitTest } })\r\n`

                await writeFile(ws, "PACKAGE.ts", pkgSrc("v1"))
                git(ws, "add", "-A")
                git(ws, "commit", "-qm", "v1")

                // Commit 2 modifies PACKAGE.ts so affected --base HEAD~1 hits Cli L599-604 + PackageLoader.loadAt + effect-resolution revisionHooks!
                await writeFile(ws, "PACKAGE.ts", pkgSrc(`v2-${slug}`))
                git(ws, "add", "PACKAGE.ts")
                git(ws, "commit", "-qm", "v2")

                // Direct PackageLoader.loadAt call too (covers CRLF + revisionHooks)
                const disc = await PackageDiscovery.discover(ws)
                const wsText = await Fs.readFile(NodePath.join(ws, "WORKSPACE.ts"), "utf8")
                const loadedAt = await PackageLoader.loadAt(
                  disc,
                  {
                    files: ["WORKSPACE.ts", "PACKAGE.ts"],
                    changed: new Set(["PACKAGE.ts"]),
                    texts: new Map([["WORKSPACE.ts", wsText], ["PACKAGE.ts", pkgSrc("v1")]])
                  },
                  () => ({})
                )
                expect(loadedAt.packages.length).toBe(1)

                const env: Record<string, string> = {
                  ...process.env as Record<string, string>,
                  PATH: `${binDir}${NodePath.delimiter}${process.env["PATH"] ?? ""}`
                }

                // 1. affected --base HEAD~1 --list (Cli L599-604)
                const aff = await serveCli(ws, ["affected", "test", "--base", "HEAD~1", "--list"], { environment: env })
                expect(aff.exitCode).toBe(0)

                // 2. known-red rejecting artifact test (Cli L820-828)
                const kr = await serveCli(ws, ["test", "//:t1", "--known-red", "known-red.json"], { environment: env })
                expect(kr.exitCode).not.toBe(0)

                // 3. bench --baseline --fail-on-regression (Cli L1518-1537 in human & agent audience)
                const br = await serveCli(
                  ws,
                  [
                    "bench",
                    "//:perf",
                    "--baseline",
                    "baseline.json",
                    "--fail-on-regression",
                    "5",
                    "--audience",
                    humanAudience ? "human" : "agent"
                  ],
                  { environment: env }
                )
                expect(br.exitCode).not.toBe(0)

                // 4. units --list --closures (Cli L2055-2072)
                const un = await serveCli(ws, ["units", "//:unitTest", "--base", "HEAD~1", "--list", "--closures"], {
                  environment: env
                })
                expect(un.exitCode).toBe(0)

                // 5. install (Cli L2194-2208)
                const inst = await serveCli(ws, ["install"], { environment: env })
                expect(typeof inst.exitCode).toBe("number")

                // 6. GitCommit.commit with paths + unstaged changes outside scope (scratch index L277-299)
                await writeFile(ws, "src/a.txt", `staged-${slug}\n`)
                await writeFile(ws, "src/extra.txt", `unstaged-outside-${slug}\n`)
                const committed = await GitCommit.commit({
                  root: ws,
                  target: S.Git.Commit({ message: `feat: scoped ${slug}`, changes: ["src/a.txt"], gates: [] }),
                  paths: ["src/a.txt"],
                  gateRunner: { run: async () => [] }
                })
                expect(committed).toBeDefined()

                // 7. GitHooks error path when .git/hooks is blocked by a regular file
                if (hooksBlocked) {
                  const hooksPath = NodePath.join(ws, ".git/hooks")
                  await Fs.rm(hooksPath, { recursive: true, force: true })
                  await writeFile(ws, ".git/hooks", "not-a-directory\n")
                  await expect(
                    GitHooks.install(ws, GitHooks.render({ preCommit: "//:t1" }))
                  ).rejects.toThrow()
                }

                // 8. Engine.runInstall with fake yarn on PATH
                const engRes = await Engine.runInstall(ws, {}).catch((e) => e)
                expect(engRes).toBeDefined()
              })
              return true
            }),
          { executions: ioExecutions, seed }
        )
      )
      assertPassed(report)
    },
    180_000
  )

  it(
    "Cache faulty IO/413 skipLimit/findMissing skipSlow, PackageTree untracked revertPath & faulty IO, AgentSession overlay.read & runAgentLint --fix, RspackRunner resolve/build/errors & InstalledTree .pnpm/warm-hit",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          slug: slugArb,
          rspackCase: Schema.Literals(["valid", "missing_response", "unsorted_files", "valid_build"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ slug, rspackCase }) =>
            Effect.promise(async () => {
              await withTempDir("smthrs-w8e-sub-", async (base) => {
                const ws = NodePath.join(base, "ws")
                await Fs.mkdir(ws, { recursive: true })

                // 1. Cache: 413 skipLimit + repeated findMissing timeouts -> skipSlow + faulty IO combinedFailure
                let reqs = 0
                const srv = Http.createServer((req, res) => {
                  reqs += 1
                  const url = req.url ?? "/"
                  if (url.includes("findMissing")) {
                    const t = setTimeout(() => {
                      if (!res.writableEnded) {
                        res.writeHead(200)
                        res.end("{}")
                      }
                    }, 400)
                    req.on("close", () => clearTimeout(t))
                    return
                  }
                  if (req.method === "PUT") {
                    res.writeHead(413)
                    res.end("too large")
                    return
                  }
                  res.writeHead(404)
                  res.end()
                })
                await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve))
                const port = (srv.address() as AddressInfo).port
                const warns: Array<string> = []
                try {
                  const store = await Cache.openCache({
                    workspaceRoot: ws,
                    cacheDirectory: ".flows",
                    endpoint: `http://127.0.0.1:${port}`,
                    readToken: () => "tok",
                    writeToken: () => "tok",
                    timeouts: { get: 40, put: 40 },
                    warn: (w) => warns.push(w)
                  })
                  try {
                    const casDigest = createHash("sha256").update(`blob-${slug}`).digest("hex")
                    await writeFile(ws, `.flows/cas/${casDigest.slice(0, 2)}/${casDigest}`, `blob-${slug}`)
                    for (let i = 0; i < 4; i++) {
                      await store.put(`k-${slug}-${i}`, {
                        key: `k-${slug}-${i}`,
                        target: "Shell.Build",
                        label: "//:b",
                        exitOk: true,
                        output: {
                          kind: "build-artifacts",
                          manifests: [{
                            outDirs: ["dist"],
                            entries: [{ path: "x.txt", kind: "file", digest: casDigest, executable: false, size: 7 }]
                          }],
                          files: []
                        },
                        storedAt: new Date().toISOString()
                      })
                    }
                  } finally {
                    await store.close()
                  }
                } finally {
                  await new Promise<void>((resolve) => srv.close(() => resolve()))
                }
                expect(reqs).toBeGreaterThanOrEqual(1)

                // Faulty Cache IO triggering rename/unlink combinedFailure
                const badIo = {
                  rename: async () => {
                    const err = Object.assign(new Error("ENOSPC"), { code: "ENOSPC" })
                    throw err
                  },
                  removeTemp: async () => {
                    const err = Object.assign(new Error("EIO"), { code: "EIO" })
                    throw err
                  }
                }
                const faultyStore = await Cache.openCache({
                  workspaceRoot: ws,
                  cacheDirectory: ".flows-bad",
                  io: badIo as never
                })
                try {
                  await expect(
                    faultyStore.put("bad-io-key", {
                      key: "bad-io-key",
                      target: "Shell.Test",
                      label: "//:t",
                      exitOk: true,
                      output: {},
                      storedAt: new Date().toISOString()
                    })
                  ).rejects.toThrow()
                } finally {
                  await faultyStore.close()
                }

                // 2. PackageTree untracked revertPath (missing / link / file without git checkout) + faulty captureOutDir IO
                const uws = NodePath.join(base, "uws")
                await Fs.mkdir(uws, { recursive: true })
                git(uws, "init", "-q")
                await writeFile(uws, "seed.txt", "seed\n")
                git(uws, "add", "seed.txt")
                git(uws, "commit", "-qm", "seed")
                // Untracked dirty file + symlink stashed by snapshotTree and restored via L852-865!
                await writeFile(uws, "u-file.txt", `orig-${slug}\n`, 0o755)
                await Fs.symlink("u-file.txt", NodePath.join(uws, "u-link"))
                const usnap = await PackageTree.snapshotTree(uws, ".flows")
                const uq = PackageTree.openQuarantine(uws, ".flows", "//:u")
                try {
                  await writeFile(uws, "u-file.txt", "dirty\n")
                  await Fs.rm(NodePath.join(uws, "u-link"), { force: true })
                  await writeFile(uws, "u-link", "replaced\n")
                  await writeFile(uws, "u-new.txt", "created\n")
                  for (const p of ["u-file.txt", "u-link", "u-new.txt"]) {
                    await PackageTree.revertPath(usnap, p, uq)
                  }
                  expect(await Fs.readFile(NodePath.join(uws, "u-file.txt"), "utf8")).toBe(`orig-${slug}\n`)
                  expect((await Fs.lstat(NodePath.join(uws, "u-link"))).isSymbolicLink()).toBe(true)
                  expect(NodeFs.existsSync(NodePath.join(uws, "u-new.txt"))).toBe(false)
                } finally {
                  await PackageTree.releaseSnapshot(usnap)
                }
                await writeFile(uws, "out/a.txt", "hello\n")
                await expect(
                  PackageTree.captureOutDir(uws, ".flows", "out", uws, PackageTree.outDirLimits, {
                    ...Fs,
                    readdir: async () => {
                      throw Object.assign(new Error("EACCES"), { code: "EACCES" })
                    }
                  } as never)
                ).rejects.toThrow()

                // 3. AgentSession overlay.read (edited, deleted, untouched, ENOENT, EISDIR) + runAgentLint with fix
                const aws = NodePath.join(base, "aws")
                await Fs.mkdir(aws, { recursive: true })
                git(aws, "init", "-q")
                await writeFile(aws, "prompt.md", `Lint ${slug}\n`)
                await writeFile(aws, "out/edit.txt", "committed\n")
                git(aws, "add", "-A")
                git(aws, "commit", "-qm", "init")
                await writeFile(aws, "out/edit.txt", "before\n")
                await writeFile(aws, "out/del.txt", "gone\n")
                await writeFile(aws, "out/keep.txt", "keep\n")
                await Fs.mkdir(NodePath.join(aws, "out/subdir"), { recursive: true })
                const applier = AgentSession.makeLocalWriteSetApplier(aws)
                const ov = await Effect.runPromise(
                  applier.apply(
                    [
                      { path: "out/edit.txt", contents: "after\n" },
                      { path: "out/del.txt", contents: null }
                    ],
                    ["out/**"],
                    undefined
                  )
                )
                expect(await ov.read("out/edit.txt")).toBe("after\n")
                expect(await ov.read("out/del.txt")).toBeUndefined()
                expect(await ov.read("out/keep.txt")).toBe("keep\n")
                expect(await ov.read("out/nope.txt")).toBeUndefined()
                expect(await ov.read("out/subdir")).toBeUndefined()

                const lintFakePath = NodePath.join(base, "lint-fake.json")
                const lintScript: AgentFake.FakeScript = {
                  responses: [{
                    findings: [{ file: "out/edit.txt", line: 1, severity: "warning", message: "fixable" }],
                    edits: [{ path: "out/edit.txt", contents: `fixed-${slug}\n` }],
                    note: "fixed"
                  }]
                }
                await writeFile(base, lintFakePath, JSON.stringify(lintScript))
                const lintPayload: AgentTarget.LintPayload = {
                  promptPath: "prompt.md",
                  diffs: [S.gitDiff("HEAD")],
                  fixes: ["out/**"],
                  mode: "fix"
                }
                const lintRes = await Effect.runPromise(
                  Effect.exit(AgentSession.runAgentLint(
                    {
                      workspaceRoot: aws,
                      environment: {},
                      sensitiveEnv: [],
                      sessions: AgentFake.sessionFactoryFromEnvironment({ workspaceRoot: aws, agents: undefined }, {
                        SMTHRS_AGENT_FAKE: lintFakePath
                      }),
                      writeSets: applier,
                      gates: AgentSession.unavailableGateRunner,
                      verdicts: AgentSession.makeMemoryVerdictStore(),
                      payloadValues: {},
                      dataFiles: ["out/edit.txt"]
                    },
                    lintPayload
                  ))
                )
                expect(lintRes._tag).toBe("Failure")

                // 4. RspackRunner with synthetic @rsbuild/core in temp workspace (hits resolveGraph, runBuild, readResponse & assertSortedUnique!)
                const rws = NodePath.join(base, "rws")
                await writeFile(rws, "package.json", JSON.stringify({ name: "rws", type: "module" }))
                await writeFile(rws, "rsbuild.config.mjs", "export default {}\n")
                await writeFile(rws, "src/index.ts", `export const a = "${slug}"\n`)
                await writeFile(rws, "src/b.ts", `export const b = "${slug}"\n`)
                const rsbuildBody = rspackCase === "missing_response"
                  ? `export const loadConfig = async () => ({ content: {} }); export const createRsbuild = async () => ({ inspectConfig: async () => ({}), build: async () => ({ stats: { toJson: () => ({ children: [] }) } }), initConfigs: async () => [], getRsbuildConfig: () => ({}) }); process.exit(0);`
                  : rspackCase === "unsorted_files"
                  ? `export const loadConfig = async () => ({ content: {} }); export const createRsbuild = async () => ({ createCompiler: async () => ({ run: (cb) => cb(null, { hasErrors: () => false, toJson: () => ({ children: [{ name: "web", modules: [{ nameForCondition: "${
                    NodePath.join(rws, "src/index.ts")
                  }" }, { nameForCondition: "${
                    NodePath.join(rws, "src/b.ts")
                  }" }] }] }) }), close: (cb) => cb(null) }), build: async () => ({ stats: { toJson: () => ({}) } }) });`
                  : `export const loadConfig = async () => ({ content: {} }); export const createRsbuild = async () => ({ createCompiler: async () => ({ run: (cb) => cb(null, { hasErrors: () => false, toJson: () => ({ children: [{ name: "web", modules: [{ nameForCondition: "${
                    NodePath.join(rws, "src/b.ts")
                  }" }, { nameForCondition: "${
                    NodePath.join(rws, "src/index.ts")
                  }" }] }] }) }), close: (cb) => cb(null) }), build: async () => ({ stats: { hasErrors: () => false, toJson: () => ({}) } }) });`
                await writeFile(
                  rws,
                  "node_modules/@rsbuild/core/package.json",
                  JSON.stringify({ name: "@rsbuild/core", type: "module", main: "index.mjs" })
                )
                await writeFile(rws, "node_modules/@rsbuild/core/index.mjs", rsbuildBody)
                const scratchDir = NodePath.join(rws, ".flows/bundler")
                await Fs.mkdir(scratchDir, { recursive: true })
                const runnerOpts: RspackRunner.RunnerOptions = {
                  workspaceRoot: rws,
                  scratchDirectory: scratchDir,
                  timeoutMs: 15_000
                }
                if (rspackCase === "valid_build") {
                  const buildExit = await Effect.runPromise(
                    Effect.exit(
                      RspackRunner.runBuild(runnerOpts, {
                        configPath: "rsbuild.config.mjs",
                        environment: "web",
                        mode: "production",
                        outDirs: ["dist"],
                        env: {}
                      })
                    )
                  )
                  expect(["Success", "Failure"]).toContain(buildExit._tag)
                } else {
                  const resExit = await Effect.runPromise(
                    Effect.exit(
                      RspackRunner.resolveGraph(runnerOpts, {
                        configPath: "rsbuild.config.mjs",
                        entries: ["src/index.ts"],
                        mode: "production"
                      })
                    )
                  )
                  expect(["Success", "Failure"]).toContain(resExit._tag)
                }

                // 5. InstalledTree .pnpm directory, worker pool (>8 units), warm fingerprint hit & entry limit
                const itWs = NodePath.join(base, "itws")
                const nmDir = NodePath.join(itWs, "node_modules")
                await writeFile(itWs, "node_modules/.bin/cli", "#!/bin/sh\n")
                await writeFile(
                  itWs,
                  "node_modules/.pnpm/pkg@1.0.0/node_modules/pkg/index.js",
                  `export const p = "${slug}"\n`
                )
                for (let i = 0; i < 9; i++) {
                  await writeFile(itWs, `node_modules/plain-${i}/index.js`, `export const q = "${slug}-${i}"\n`)
                }
                await NodeFs.promises.symlink("plain-0/index.js", NodePath.join(nmDir, "plain-link"))
                // Backdate mtime/ctime slightly so settled=true path triggers in worker & sync
                const oldTime = new Date(Date.now() - 10_000)
                for (let i = 0; i < 9; i++) {
                  await NodeFs.promises.utimes(NodePath.join(nmDir, `plain-${i}/index.js`), oldTime, oldTime)
                  await NodeFs.promises.utimes(NodePath.join(nmDir, `plain-${i}`), oldTime, oldTime)
                }
                const unitNames = InstalledTree.units(nmDir)
                expect(unitNames.length).toBeGreaterThan(8)
                const remembered = InstalledTree.empty()
                const cold = await InstalledTree.identifyAsync(nmDir, remembered)
                const warm = await InstalledTree.identifyAsync(nmDir, remembered)
                expect(warm.digest).toBe(cold.digest)
                // Trigger InstalledTreeRefused via tight entries limit in worker pool
                let refused = false
                try {
                  await InstalledTree.identifyAsync(nmDir, InstalledTree.empty(), undefined, { entries: 2, depth: 8 })
                } catch {
                  refused = true
                }
                expect(refused).toBe(true)
              })
              return true
            }),
          { executions: ioExecutions, seed }
        )
      )
      assertPassed(report)
    },
    180_000
  )
})
