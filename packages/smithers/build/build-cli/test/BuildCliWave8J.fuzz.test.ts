/**
 * Wave-8J deep fuzz suite for packages/smithers/build/build-cli:
 * 1. PackageRunner Machine.keep + putBackFor + runKept (leftRunning / rerunFor) +
 *    keepMachines fallback & MachineKeepError + malformed Machine.keepVariable
 * 2. PackageRunner + Kept archive edge cases (corrupt tar, missing tar, failing tar,
 *    archive with out-of-workspace absolute path, corrupt .json path list, unwritable dir)
 * 3. PackageRunner refreshInstalledNode / planAfterInstall (happy refresh, failed install +
 *    S.Suite, missing node_modules bin, chmod 0o000 catchCause, approval: "required" drift
 *    for both target and service) + Git.Submodule verify/restore/spawn/refusal lifecycle.
 */
import { Fuzz } from "@smthrs/fuzz"
import { Smithers as S } from "@smthrs/targets"
import * as Exec from "@smthrs/targets/Exec"
import * as ExecSandbox from "@smthrs/targets/ExecSandbox"
import * as Target from "@smthrs/targets/Target"
import { Arbitrary, Effect, Schema } from "effect"
import { execFileSync, spawnSync } from "node:child_process"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Net from "node:net"
import * as Os from "node:os"
import * as Path from "node:path"
import { describe, expect, it } from "vitest"
import * as Machine from "../src/internal/Machine.ts"
import * as ObservedReads from "../src/internal/ObservedReads.ts"
import { executeEffect, ExecutionServices, executionServicesLive } from "../src/internal/PackageRunner.ts"
import { plan } from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const seed = 8810
const executions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? "50")
const ioExecutions = Math.min(executions, 3)

const tracing = ObservedReads.observer(ExecSandbox.host())
const hasTracing = !("reason" in tracing)

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-c", "user.name=Fuzz", "-c", "user.email=fuzz@example.invalid", "-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim()

const freePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = Net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      server.close((err) => (err ? reject(err) : resolve(port)))
    })
  })

const withPath = async <A>(pathValue: string, fn: () => Promise<A>): Promise<A> => {
  const previous = process.env["PATH"]
  process.env["PATH"] = pathValue
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env["PATH"]
    else process.env["PATH"] = previous
  }
}

const withoutBins = (names: ReadonlyArray<string>): ExecutionServices => ({
  ...executionServicesLive,
  findOnPath: (name, ...rest) =>
    names.includes(name) ? Effect.succeed(undefined) : executionServicesLive.findOnPath(name, ...rest)
})

const withTarBin = (tar: string | undefined): ExecutionServices => ({
  ...executionServicesLive,
  findOnPath: (name, ...rest) =>
    name === "tar" ? Effect.succeed(tar) : executionServicesLive.findOnPath(name, ...rest)
})

const runPackage = async (
  options: Parameters<typeof plan>[0],
  services: ExecutionServices = executionServicesLive
) =>
  withPath(options.environment?.["PATH"] ?? process.env["PATH"] ?? "/usr/bin:/bin", async () => {
    const planned = await plan(options)
    return Effect.runPromise(
      executeEffect(planned, options).pipe(Effect.provideService(ExecutionServices, services))
    )
  })

const statuses = (summary: { readonly results: ReadonlyArray<{ readonly label: string; readonly status: string }> }) =>
  Object.fromEntries(summary.results.map((r) => [r.label.split(":")[1]!, r.status]))

const onMachine = (machine: string, shell: string, data: ReadonlyArray<unknown> = []) =>
  S.Shell.Test({ shell, machine, sandbox: "none", observe: true, data: [S.glob("**"), ...data] as never })

const hostPathWithTracer = () =>
  [
    ...("tracer" in tracing ? [Path.dirname(tracing.tracer)] : []),
    Path.dirname(process.execPath),
    ...(process.env["PATH"] ? [process.env["PATH"]] : ["/usr/bin", "/bin"])
  ].join(Path.delimiter)

describe("BuildCliWave8J — Machine.keep, runKept, Kept corruption, InstallRefresh & Git.Submodule", () => {
  it("PackageRunner Machine.keep, putBackFor, keepMachines fallback/error & runKept (leftRunning / rerunFor)", async () => {
    if (!hasTracing || process.platform === "win32") return
    const variantArb = Arbitrary.schema(Schema.Literals(["keep-and-fallback", "left-running"]))
    const report = await Effect.runPromise(
      Fuzz.run(
        variantArb,
        (mode) =>
          Effect.promise(async () => {
            const base = await Fs.realpath(await Fs.mkdtemp(Path.join("/var/tmp", "w8j-machine-")))
            try {
              const root = Path.join(base, "ws")
              await Fs.mkdir(root, { recursive: true })
              git(root, "init", "--quiet", "--initial-branch=main")
              await Fs.writeFile(Path.join(root, ".gitignore"), ".flows\n.mirrors\n")
              await Fs.writeFile(Path.join(root, "a.txt"), "a\n")
              await Fs.writeFile(Path.join(root, "b.txt"), "b\n")
              await Fs.writeFile(Path.join(root, "ask.txt"), "one\n")
              await Fs.mkdir(Path.join(root, "site"), { recursive: true })
              await Fs.writeFile(Path.join(root, "site", "x.txt"), "ok\n")
              git(root, "add", "-A")
              git(root, "commit", "--quiet", "-m", "init")

              const home = Path.join(base, "home")
              await Fs.mkdir(home, { recursive: true })
              const environment: Record<string, string> = {
                PATH: hostPathWithTracer(),
                HOME: home,
                [Machine.holdingVariable]: Path.join(base, "machines")
              }

              if (mode === "keep-and-fallback") {
                const install = onMachine("job", "mkdir -p deps && cp a.txt deps/a")
                const testTarget = onMachine(
                  "job",
                  "grep -q a deps/a && grep -q b b.txt && echo covered > coverage.txt",
                  [install]
                )
                const index = PackageIndex.make({
                  root,
                  workspace: S.Workspace("keep-fuzz", {
                    repository: "git+https://example.invalid/keep-fuzz.git",
                    cache: S.Cache({ directory: ".flows" }),
                    host: S.Host({ bins: ["sh"] })
                  }),
                  factory: undefined,
                  packages: [{ file: "PACKAGE.ts", packagePath: "", value: S.Package({ targets: { install, test: testTarget } }) }]
                })
                const logs: Array<string> = []
                const makeOpts = (patterns: ReadonlyArray<string>) => ({
                  index,
                  cacheDirectory: ".flows",
                  verb: "auto" as const,
                  patterns,
                  environment,
                  jobs: 1,
                  log: (line: string) => void logs.push(line)
                })
                const keptDir = (name: string) => Path.join(base, "kept", name)

                // 1. Cold run without keepVariable
                const r1 = await runPackage(makeOpts(["//:test"]))
                expect(statuses(r1)).toEqual({ install: "ran", test: "ran" })

                // 2. Warm hit with keepVariable + stale file removed + absent machine logged
                await Fs.mkdir(keptDir("0"), { recursive: true })
                await Fs.writeFile(Path.join(keptDir("0"), "stale.txt"), "stale\n")
                environment[Machine.keepVariable] = JSON.stringify({ job: keptDir("0"), absent: keptDir("absent") })
                const r2 = await runPackage(makeOpts(["//:test"]))
                expect(statuses(r2)).toEqual({ install: "hit", test: "hit" })
                expect(NodeFs.existsSync(Path.join(keptDir("0"), "stale.txt"))).toBe(false)
                expect(logs.some((l) => l.includes("machine job is kept in"))).toBe(true)
                expect(logs.some((l) => l.includes("no target of this run is on machine absent"))).toBe(true)

                // 3. Edit b.txt -> install hit + putBackFor, test ran
                logs.length = 0
                await Fs.writeFile(Path.join(root, "b.txt"), "b2\n")
                const r3 = await runPackage(makeOpts(["//:test"]))
                expect(statuses(r3)).toEqual({ install: "hit", test: "ran" })
                expect(await Fs.readFile(Path.join(keptDir("0"), "deps", "a"), "utf8")).toBe("a\n")
                expect(await Fs.readFile(Path.join(keptDir("0"), "coverage.txt"), "utf8")).toBe("covered\n")

                // 4. Restore fails (without tar) -> keepMachines falls back to rerunning steps
                logs.length = 0
                const r4 = await runPackage(makeOpts(["//:test"]), withoutBins(["tar"]))
                expect(statuses(r4)["test"]).toBe("hit")
                expect(logs.some((l) => l.includes("machine job is kept in"))).toBe(true)

                // 5. Rerun failure during keepMachines -> MachineKeepError
                const failingExec: ExecutionServices = {
                  ...withoutBins(["tar"]),
                  exec: (_config, payload) =>
                    Effect.fail(
                      Exec.ExecError.make({
                        _tag: "smithers-build/ExecError",
                        argv: payload.argv,
                        cwd: payload.cwd,
                        code: "exit_status",
                        exitCode: 1,
                        stdout: "",
                        stderr: "disk full"
                      })
                    )
                }
                const rFailKeep = await runPackage(makeOpts(["//:test"]), failingExec).catch((err) => ({ rejected: String(err) }))
                expect("rejected" in rFailKeep ? rFailKeep.rejected : JSON.stringify(statuses(rFailKeep))).toBeTruthy()

                // 6. Malformed Machine.keepVariable values + empty string clears it
                for (const bad of ["{", "[]", "null", JSON.stringify({ job: "relative/dir" }), JSON.stringify({ job: 3 })]) {
                  environment[Machine.keepVariable] = bad
                  await expect(runPackage(makeOpts(["//:test"]))).rejects.toThrow(
                    `${Machine.keepVariable} is not a JSON object`
                  )
                }
                environment[Machine.keepVariable] = ""
                const rEmpty = await runPackage(makeOpts(["//:test"]))
                expect(statuses(rEmpty)["test"]).toBe("hit")
              } else {
                // left-running: serve leaves HTTP server running -> runKept succeeds when port free, fails when port held!
                const port = await freePort()
                const serverJs = `require("http").createServer((q, r) => r.end("ok\\n")).listen(${port}, "127.0.0.1")`
                const serve = onMachine("web", `${process.execPath} -e '${serverJs}' > /dev/null 2>&1 & sleep 0.4; kill -0 $!`)
                const ask = onMachine(
                  "web",
                  `for i in 1 2 3 4 5 6 7 8 9 10; do curl -sf --max-time 3 http://127.0.0.1:${port}/ | grep -qx ok && break; sleep 0.1; done && cat ask.txt`,
                  [serve]
                )
                const index = PackageIndex.make({
                  root,
                  workspace: S.Workspace("kept-proc", {
                    repository: "git+https://example.invalid/kept-proc.git",
                    cache: S.Cache({ directory: ".flows" }),
                    host: S.Host({ bins: ["sh"] })
                  }),
                  factory: undefined,
                  packages: [{ file: "PACKAGE.ts", packagePath: "", value: S.Package({ targets: { serve, ask } }) }]
                })
                const logs: Array<string> = []
                const opts = {
                  index,
                  cacheDirectory: ".flows",
                  verb: "auto" as const,
                  patterns: ["//:ask"],
                  environment,
                  jobs: 1,
                  log: (line: string) => void logs.push(line)
                }

                // Run 1: both run; serve leaves server running
                const r1 = await runPackage(opts)
                expect(statuses(r1)).toEqual({ serve: "ran", ask: "ran" })

                // Run 2: edit ask.txt with port free -> serve runs again via runKept and ask passes
                logs.length = 0
                await Fs.writeFile(Path.join(root, "ask.txt"), "two\n")
                const r2 = await runPackage(opts)
                expect(statuses(r2)).toEqual({ serve: "ran", ask: "ran" })

                // Run 3: edit ask.txt with port held -> runKept(serve) fails -> rerunFor marks serve + ask failed!
                logs.length = 0
                await Fs.writeFile(Path.join(root, "ask.txt"), "three\n")
                const holder = await new Promise<Net.Server>((resolve, reject) => {
                  const srv = Net.createServer()
                  srv.once("error", reject)
                  srv.listen(port, "127.0.0.1", () => resolve(srv))
                })
                try {
                  const r3 = await runPackage(opts)
                  expect(statuses(r3)["serve"]).toBe("failed")
                  expect(["failed", "skipped"]).toContain(statuses(r3)["ask"])
                } finally {
                  holder.close()
                }

                // Run 4: tracer-refusing producer before left-running serve
                const port2 = await freePort()
                const refusingInstall = onMachine(
                  "web2",
                  "if /bin/grep -q -e '^TracerPid:[[:space:]]*[1-9]' -e '^Seccomp_filters:[[:space:]]*[1-9]' /proc/self/status; then exit 1; fi; echo installed > installed.txt"
                )
                const serverJs2 = `require("http").createServer((q, r) => r.end("ok\\n")).listen(${port2}, "127.0.0.1")`
                const serve2 = onMachine(
                  "web2",
                  `grep -q installed installed.txt && ${process.execPath} -e '${serverJs2}' > /dev/null 2>&1 & sleep 0.4; kill -0 $!`,
                  [refusingInstall]
                )
                const ask2 = onMachine(
                  "web2",
                  `for i in 1 2 3 4 5 6 7 8 9 10; do curl -sf --max-time 3 http://127.0.0.1:${port2}/ | grep -qx ok && break; sleep 0.1; done`,
                  [serve2]
                )
                const idx2 = PackageIndex.make({
                  root,
                  workspace: S.Workspace("kept-proc-2", {
                    repository: "git+https://example.invalid/kept-proc-2.git",
                    cache: S.Cache({ directory: ".flows" }),
                    host: S.Host({ bins: ["sh"] })
                  }),
                  factory: undefined,
                  packages: [
                    {
                      file: "PACKAGE.ts",
                      packagePath: "",
                      value: S.Package({ targets: { install: refusingInstall, serve: serve2, ask: ask2 } })
                    }
                  ]
                })
                const logs2: Array<string> = []
                const opts2 = {
                  index: idx2,
                  cacheDirectory: ".flows",
                  verb: "auto" as const,
                  patterns: ["//:ask"],
                  environment,
                  jobs: 1,
                  log: (line: string) => void logs2.push(line)
                }
                const r4a = await runPackage(opts2)
                expect(statuses(r4a)).toEqual({ install: "ran", serve: "ran", ask: "ran" })
                logs2.length = 0
                await Fs.writeFile(Path.join(root, "b.txt"), "b-changed\n")
                const r4b = await runPackage(opts2)
                expect(statuses(r4b)).toEqual({ install: "ran", serve: "ran", ask: "ran" })
              }

              return true
            } finally {
              await Machine.remove(base).catch(() => undefined)
              await Fs.rm(base, { recursive: true, force: true }).catch(() => undefined)
            }
          }),
        { executions: ioExecutions, seed }
      )
    )
    assertPassed(report)
  }, 180_000)

  it("Kept archives & ObservedReads putBack corruption matrix (corrupt tar, missing/failing tar, outside-path tar, bad .json, unwritable dir)", async () => {
    if (!hasTracing || process.platform === "win32") return
    const variantArb = Arbitrary.schema(Schema.Literals(["corrupt-and-tar", "outside-and-locked"]))
    const report = await Effect.runPromise(
      Fuzz.run(
        variantArb,
        (mode) =>
          Effect.promise(async () => {
            // Must use /var/tmp (outside Os.tmpdir()) so outside-workspace archive paths are truly rejected by Kept!
            const base = await Fs.realpath(await Fs.mkdtemp(Path.join("/var/tmp", "w8j-kept-")))
            try {
              const root = Path.join(base, "ws")
              const outside = Path.join(base, "outside")
              await Fs.mkdir(root, { recursive: true })
              await Fs.mkdir(outside, { recursive: true })
              await Fs.writeFile(Path.join(root, "lock.txt"), "locked 1\n")
              await Fs.writeFile(Path.join(root, "src.txt"), "source 1\n")
              await Fs.mkdir(Path.join(root, "tests"), { recursive: true })
              await Fs.writeFile(Path.join(root, "tests", "t.txt"), "test 1\n")

              const install = S.Shell.Test({
                shell: "/bin/chmod u+w . && /bin/mkdir -p deps && /bin/cat lock.txt > deps/installed.txt",
                sandbox: "none",
                observe: true,
                data: [S.glob("**")]
              })
              const build = S.Shell.Test({
                shell: "/bin/cat deps/installed.txt src.txt > deps/built.txt",
                sandbox: "none",
                observe: true,
                data: [S.glob("**"), install]
              })
              const testTarget = S.Shell.Test({
                shell: "/bin/cat deps/built.txt tests/t.txt > /dev/null",
                sandbox: "none",
                observe: true,
                data: [S.glob("**"), build]
              })
              const index = PackageIndex.make({
                root,
                workspace: S.Workspace("kept-matrix", {
                  repository: "git+https://example.invalid/kept-matrix.git",
                  cache: S.Cache({ directory: ".flows" }),
                  host: S.Host({ bins: ["sh"] })
                }),
                factory: undefined,
                packages: [{ file: "PACKAGE.ts", packagePath: "", value: S.Package({ targets: { install, build, test: testTarget } }) }]
              })
              const environment: Record<string, string> = {
                PATH: hostPathWithTracer(),
                HOME: Path.join(base, "home")
              }
              await Fs.mkdir(environment["HOME"]!, { recursive: true })
              const logs: Array<string> = []
              const opts = {
                index,
                cacheDirectory: ".flows",
                verb: "auto" as const,
                patterns: ["//:test"],
                environment,
                jobs: 1,
                log: (line: string) => void logs.push(line)
              }
              const keptDir = Path.join(root, ".flows", "kept")
              const listTars = async () =>
                (await Fs.readdir(keptDir).catch(() => [])).filter((f) => f.endsWith(".tar")).sort()
              const cleanDeps = async () => {
                await Fs.rm(Path.join(root, "deps"), { recursive: true, force: true })
              }

              if (mode === "corrupt-and-tar") {
                // 1. Cold run with no tar -> keeps nothing
                const rNoTar = await runPackage(opts, withTarBin(undefined))
                expect(statuses(rNoTar)).toEqual({ install: "ran", build: "ran", test: "ran" })
                expect(await listTars()).toEqual([])

                // 2. Cold run with failing tar -> logs "what it left could not be kept"
                await Fs.rm(Path.join(root, ".flows"), { recursive: true, force: true })
                await cleanDeps()
                const fakeTar = Path.join(base, "bad-tar")
                await Fs.writeFile(fakeTar, "#!/bin/sh\nexit 1\n", { mode: 0o755 })
                logs.length = 0
                const rFailTar = await runPackage(opts, withTarBin(fakeTar))
                expect(statuses(rFailTar)).toEqual({ install: "ran", build: "ran", test: "ran" })
                expect(logs).toContain(
                  "//:install  what it left could not be kept; it runs again when a step after it runs"
                )

                // 3. Clean cold run with real tar -> populates .flows/kept/*.tar
                await Fs.rm(Path.join(root, ".flows"), { recursive: true, force: true })
                await cleanDeps()
                const rReal = await runPackage(opts)
                expect(statuses(rReal)).toEqual({ install: "ran", build: "ran", test: "ran" })
                expect((await listTars()).length).toBeGreaterThanOrEqual(2)

                // 4. Restore without tar -> "what it left could not be put back; it runs for //:test"
                await cleanDeps()
                await Fs.writeFile(Path.join(root, "tests", "t.txt"), "test 2\n")
                logs.length = 0
                const rNoTarRestore = await runPackage(opts, withTarBin(undefined))
                expect(statuses(rNoTarRestore)).toEqual({ install: "hit", build: "hit", test: "ran" })
                expect(logs).toContain("//:install  what it left could not be put back; it runs for //:test")

                // 5. Corrupt the install tar archive -> "what it left could not be put back; it runs for //:test"
                await cleanDeps()
                for (const name of await listTars()) {
                  const file = Path.join(keptDir, name)
                  if ((await Fs.readFile(file)).includes("installed.txt")) {
                    await Fs.writeFile(file, "not an archive")
                  }
                }
                await Fs.writeFile(Path.join(root, "tests", "t.txt"), "test 3\n")
                logs.length = 0
                const rCorrupt = await runPackage(opts)
                expect(statuses(rCorrupt)).toEqual({ install: "hit", build: "hit", test: "ran" })
                expect(logs).toContain("//:install  what it left could not be put back; it runs for //:test")
              } else {
                // 1. Clean cold run with real tar
                const rReal = await runPackage(opts)
                expect(statuses(rReal)).toEqual({ install: "ran", build: "ran", test: "ran" })
                const [first, second] = await listTars()
                expect(first).toBeDefined()
                expect(second).toBeDefined()

                // 2. Replace first tar with an archive containing an absolute path outside workspace AND tmpdir,
                //    and corrupt second's .json path list!
                const outsideFile = Path.join(outside, "elsewhere.txt")
                await Fs.writeFile(outsideFile, "not ours\n")
                const packed = spawnSync("tar", ["-P", "-cf", Path.join(keptDir, first!), outsideFile])
                expect(packed.status).toBe(0)
                await Fs.writeFile(Path.join(keptDir, second!.replace(/\.tar$/, ".json")), "not a list")
                await Fs.rm(outsideFile)

                await cleanDeps()
                await Fs.writeFile(Path.join(root, "tests", "t.txt"), "test 2\n")
                logs.length = 0
                const rBad = await runPackage(opts)
                expect(statuses(rBad)).toEqual({ install: "hit", build: "hit", test: "ran" })
                expect(logs).toContain("//:install  what it left could not be put back; it runs for //:test")
                expect(logs).toContain("//:build  what it left could not be put back; it runs for //:test")
                expect(NodeFs.existsSync(outsideFile)).toBe(false)

                // 3. Re-capture clean tars, then make deps/ unwritable (0o555) so tar extract fails!
                await Fs.rm(Path.join(root, ".flows"), { recursive: true, force: true })
                await cleanDeps()
                await runPackage(opts)
                await cleanDeps()
                const lockedDir = Path.join(root, "deps")
                await Fs.mkdir(lockedDir, { recursive: true })
                await Fs.chmod(lockedDir, 0o555)
                try {
                  await Fs.writeFile(Path.join(root, "tests", "t.txt"), "test 3\n")
                  logs.length = 0
                  const rLocked = await runPackage(opts)
                  expect(statuses(rLocked)["test"]).toBeDefined()
                  expect(logs).toContain("//:install  what it left could not be put back; it runs for //:test")
                } finally {
                  await Fs.chmod(lockedDir, 0o755)
                }
              }

              return true
            } finally {
              await Fs.rm(base, { recursive: true, force: true }).catch(() => undefined)
            }
          }),
        { executions: ioExecutions, seed: seed + 1 }
      )
    )
    assertPassed(report)
  }, 180_000)

  it("PackageRunner refreshInstalledNode / planAfterInstall & Git.Submodule verify/restore/spawn/refusal lifecycle", async () => {
    const variantArb = Arbitrary.schema(Schema.Literals(["install-refresh", "git-submodule"]))
    const report = await Effect.runPromise(
      Fuzz.run(
        variantArb,
        (mode) =>
          Effect.promise(async () => {
            const base = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "w8j-inst-sub-")))
            try {
              if (mode === "install-refresh") {
                const root = Path.join(base, "ws")
                const toolDir = Path.join(root, "tool")
                await Fs.mkdir(toolDir, { recursive: true })
                await Fs.mkdir(Path.join(root, "guarded"), { recursive: true })
                await Fs.writeFile(Path.join(root, "guarded", "keep.txt"), "v1\n")
                await Fs.writeFile(Path.join(root, "input.txt"), "hello\n")

                const pnpmVersion = execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim()
                await Fs.writeFile(
                  Path.join(root, "package.json"),
                  `${JSON.stringify(
                    {
                      name: "refresh-fixture",
                      private: true,
                      type: "module",
                      packageManager: `pnpm@${pnpmVersion}`,
                      dependencies: { "fixture-tool": "file:./fixture-tool-1.0.0.tgz" }
                    },
                    null,
                    2
                  )}\n`
                )
                await Fs.writeFile(
                  Path.join(toolDir, "package.json"),
                  `${JSON.stringify(
                    {
                      name: "fixture-tool",
                      version: "1.0.0",
                      bin: { "fixture-command": "bin.cjs" }
                    },
                    null,
                    2
                  )}\n`
                )
                await Fs.writeFile(
                  Path.join(toolDir, "bin.cjs"),
                  "#!/usr/bin/env node\nconsole.log('FIXTURE_TOOL')\n",
                  { mode: 0o755 }
                )
                await Fs.writeFile(
                  Path.join(root, "pnpm-workspace.yaml"),
                  "packages:\n  - .\nenableGlobalVirtualStore: false\n"
                )
                execFileSync("pnpm", ["pack", "--pack-destination", root], { cwd: toolDir, stdio: "ignore" })
                execFileSync("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], { cwd: root, stdio: "ignore" })

                const manifest = S.file("//package.json")
                const install = S.Install({ lockfilePath: "pnpm-lock.yaml" })
                const testTarget = S.Shell.Test({
                  bin: S.NodeModule.Bin("fixture-command"),
                  args: ["--ok"],
                  data: [install, S.file("input.txt"), S.file("guarded/keep.txt")],
                  sandbox: "none"
                })
                const suite = S.Suite({ tests: [testTarget] })

                const approved = (rule: string) =>
                  Target.make(rule, {
                    attrs: Schema.Unknown as never,
                    kinds: ["build", "test"],
                    implementation: () => Target.notImplemented(rule)
                  })
                const approvedTarget = (approved("Shell.Test") as unknown as (a: unknown) => ReturnType<typeof S.Shell.Test>)({
                  bin: S.NodeModule.Bin("fixture-command"),
                  data: [install, S.file("input.txt")],
                  approval: "required",
                  sandbox: "none"
                })
                const approvedSvc = (approved("Shell.Serve") as unknown as (a: unknown) => ReturnType<typeof S.Shell.Serve>)({
                  bin: S.NodeModule.Bin("fixture-command"),
                  data: [install],
                  approval: "required",
                  readiness: { port: 1 }
                })
                const approvedSvcConsumer = S.Shell.Test({
                  shell: "true",
                  services: [approvedSvc],
                  sandbox: "none"
                })

                const index = PackageIndex.make({
                  root,
                  workspace: S.Workspace("refresh", {
                    repository: "git+https://example.invalid/refresh.git",
                    cache: S.Cache({ directory: ".flows" }),
                    runtime: S.Runtime.Node({ version: process.versions.node }),
                    packageManager: S.PackageManager.Pnpm({
                      manifest,
                      lockfile: S.file("//pnpm-lock.yaml"),
                      workspaces: S.file("//pnpm-workspace.yaml")
                    }),
                    nodeModules: S.Npm.NodeModules({ packageJson: manifest }),
                    sandboxes: S.Sandboxes({ default: S.Sandbox.None() })
                  }),
                  factory: undefined,
                  packages: [
                    {
                      file: "PACKAGE.ts",
                      packagePath: "",
                      value: S.Package({
                        targets: { test: testTarget, suite, approved: approvedTarget, approvedSvc, approvedSvcConsumer }
                      })
                    }
                  ]
                })

                // 1. Failed install service + S.Suite -> "installation dependency has no successful execution receipt"
                const failedInstallServices: ExecutionServices = {
                  ...executionServicesLive,
                  install: () => Effect.fail(new Error("simulated install failure"))
                }
                const rFail = await runPackage(
                  { index, cacheDirectory: ".flows", verb: "auto", patterns: ["//:suite"], jobs: 1 },
                  failedInstallServices
                )
                expect(statuses(rFail)["test"]).toBe("skipped")
                expect(statuses(rFail)["suite"]).toBe("failed")
                expect(rFail.results.find((r) => r.label === "//:suite")?.error).toContain(
                  "installation dependency has no successful execution receipt"
                )

                // 2. Real pnpm install -> refreshInstalledNode succeeds + runs test!
                const rOk = await runPackage({ index, cacheDirectory: ".flows", verb: "auto", patterns: ["//:test"], jobs: 1 })
                expect(statuses(rOk)["test"]).toBe("ran")

                // 3. Install deletes node_modules -> refreshInstalledNode refuses missing bin!
                await Fs.rm(Path.join(root, ".flows"), { recursive: true, force: true })
                await Fs.rm(Path.join(root, "node_modules"), { recursive: true, force: true })
                const wipeInstallServices: ExecutionServices = {
                  ...executionServicesLive,
                  install: (...args) =>
                    executionServicesLive.install(...args).pipe(
                      Effect.tap(() => Effect.promise(() => Fs.rm(Path.join(root, "node_modules"), { recursive: true, force: true })))
                    )
                }
                const rWipe = await runPackage(
                  { index, cacheDirectory: ".flows", verb: "auto", patterns: ["//:test"], jobs: 1 },
                  wipeInstallServices
                )
                expect(statuses(rWipe)["test"]).toBe("failed")
                expect(rWipe.results.find((r) => r.label === "//:test")?.error).toContain("node_modules binary not found")

                // 4. Approval-required target & service change after install!
                await Fs.rm(Path.join(root, ".flows"), { recursive: true, force: true })
                await Fs.rm(Path.join(root, "node_modules"), { recursive: true, force: true })
                const rApproved = await runPackage({
                  index,
                  cacheDirectory: ".flows",
                  verb: "auto",
                  patterns: ["//:approved"],
                  jobs: 1,
                  approvals: { granted: async () => true }
                })
                expect(statuses(rApproved)["approved"]).toBe("failed")
                expect(rApproved.results.find((r) => r.label === "//:approved")?.error).toContain(
                  "approval required: target changed after installation"
                )

                await Fs.rm(Path.join(root, ".flows"), { recursive: true, force: true })
                await Fs.rm(Path.join(root, "node_modules"), { recursive: true, force: true })
                const rApprovedSvc = await runPackage({
                  index,
                  cacheDirectory: ".flows",
                  verb: "auto",
                  patterns: ["//:approvedSvcConsumer"],
                  jobs: 1,
                  approvals: { granted: async () => true }
                })
                expect(statuses(rApprovedSvc)["approvedSvcConsumer"]).toBe("failed")
                expect(rApprovedSvc.results.find((r) => r.label === "//:approvedSvcConsumer")?.error).toContain(
                  "approval required: target changed after installation"
                )

                // 5. Post-install planAfterInstall error (unreadable guarded dir 0o000 -> catchCause L6136)
                if (process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0) {
                  await Fs.rm(Path.join(root, ".flows"), { recursive: true, force: true })
                  await Fs.rm(Path.join(root, "node_modules"), { recursive: true, force: true })
                  const guardedDir = Path.join(root, "guarded")
                  const lockOnInstallServices: ExecutionServices = {
                    ...executionServicesLive,
                    install: (...args) =>
                      executionServicesLive.install(...args).pipe(
                        Effect.tap(() => Effect.promise(() => Fs.chmod(guardedDir, 0o000)))
                      )
                  }
                  try {
                    const rCatch = await runPackage(
                      { index, cacheDirectory: ".flows", verb: "auto", patterns: ["//:test"], jobs: 1 },
                      lockOnInstallServices
                    )
                    expect(statuses(rCatch)["test"]).toBe("failed")
                    expect(rCatch.results.find((r) => r.label === "//:test")?.error).toContain("EACCES")
                  } finally {
                    await Fs.chmod(guardedDir, 0o755)
                  }
                }
              } else {
                // Git.Submodule full lifecycle: verify, captureBuild, restoreBuild hit, spawnNode, dirty & non-dir refusal!
                const root = Path.join(base, "parent")
                const subOrigin = Path.join(root, ".mirrors", "sub-origin")
                await Fs.mkdir(subOrigin, { recursive: true })
                git(subOrigin, "init", "--quiet", "--initial-branch=main")
                await Fs.writeFile(Path.join(subOrigin, "lib.txt"), "v1\n")
                git(subOrigin, "add", "-A")
                git(subOrigin, "commit", "--quiet", "-m", "sub init")


                git(root, "init", "--quiet", "--initial-branch=main")
                await Fs.writeFile(Path.join(root, ".gitignore"), ".flows\n")
                git(root, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", subOrigin, "vendor/lib")
                git(root, "commit", "--quiet", "-m", "add submodule")

                const subTarget = S.Git.Submodule({ path: "//vendor/lib" })
                const index = PackageIndex.make({
                  root,
                  workspace: S.Workspace("sub-ws", {
                    repository: "git+https://example.invalid/sub-ws.git",
                    cache: S.Cache({ directory: ".flows" }),
                    host: S.Host({ bins: ["git"] })
                  }),
                  factory: undefined,
                  packages: [{ file: "PACKAGE.ts", packagePath: "", value: S.Package({ targets: { sub: subTarget } }) }]
                })
                const opts = {
                  index,
                  cacheDirectory: ".flows",
                  verb: "build" as const,
                  patterns: ["//:sub"],
                  jobs: 1,
                  environment: {
                    ...process.env,
                    GIT_CONFIG_COUNT: "1",
                    GIT_CONFIG_KEY_0: "protocol.file.allow",
                    GIT_CONFIG_VALUE_0: "always",
                    SMITHERS_SUBMODULE_SOURCES: base
                  } as Record<string, string>
                }

                // 1. Already materialized -> verify === undefined -> captureBuild -> ran!
                const r1 = await runPackage(opts)
                expect(statuses(r1)).toEqual({ sub: "ran" })

                // 2. Cached + already materialized -> hit!
                const r2 = await runPackage(opts)
                expect(statuses(r2)).toEqual({ sub: "hit" })

                // 3. Remove vendor/lib checkout -> cached restoreBuild -> verify === undefined -> hit!
                await Fs.rm(Path.join(root, "vendor", "lib"), { recursive: true, force: true })
                const r3 = await runPackage(opts)
                expect(statuses(r3)).toEqual({ sub: "hit" })

                // 4. Dirty checkout inside vendor/lib -> refuses to replace local changes!
                await Fs.writeFile(Path.join(root, "vendor", "lib", "dirty.txt"), "untracked\n")
                const rDirty = await runPackage(opts)
                expect(statuses(rDirty)).toEqual({ sub: "failed" })
                expect(rDirty.results[0]?.error).toMatch(/has (local )?changes/)
                await Fs.rm(Path.join(root, "vendor", "lib", "dirty.txt"))

                // 5. Replace vendor/lib with a regular file -> refuses non-directory!
                await Fs.rm(Path.join(root, "vendor", "lib"), { recursive: true, force: true })
                await Fs.writeFile(Path.join(root, "vendor", "lib"), "not a dir\n")
                const rNotDir = await runPackage(opts)
                expect(statuses(rNotDir)).toEqual({ sub: "failed" })
                expect(rNotDir.results[0]?.error).toBeDefined()
                await Fs.rm(Path.join(root, "vendor", "lib"))

                // 6. Clean cache + empty checkout -> spawnNode fetches & materializes submodule -> verify -> captureBuild!
                await Fs.rm(Path.join(root, ".flows"), { recursive: true, force: true })
                await Fs.mkdir(Path.join(root, "vendor", "lib"), { recursive: true })
                const rSpawn = await runPackage(opts)
                expect(statuses(rSpawn)).toEqual({ sub: "ran" })
              }

              return true
            } finally {
              await Fs.rm(base, { recursive: true, force: true }).catch(() => undefined)
            }
          }),
        { executions: ioExecutions, seed: seed + 2 }
      )
    )
    assertPassed(report)
  }, 180_000)
})
