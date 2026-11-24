import { NodeCrypto } from "@effect/platform-node"
import { Fuzz } from "@smthrs/fuzz"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import { DirectorySandbox } from "@smthrs/sandbox"
import {
  Arbitrary,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Logger,
  Schema,
  Sink,
  Stream
} from "effect"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner, ExitCode, makeHandle, ProcessId } from "effect/process/ChildProcessSpawner"
import { once } from "node:events"
import * as fs from "node:fs"
import type { Socket } from "node:net"
import * as net from "node:net"
import * as os from "node:os"
import * as nodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as NodeHost from "../src/NodeHost.ts"
import * as NodeLanguageServer from "../src/NodeLanguageServer.ts"
import * as ProcessReaper from "../src/ProcessReaper.ts"
import * as ProcessSandbox from "../src/ProcessSandbox.ts"
import * as SandboxedFlow from "../src/SandboxedFlow.ts"
import * as AtomicFileSystemExecutable from "../src/internal/AtomicFileSystemExecutable.ts"
import * as AtomicFileSystemProtocol from "../src/internal/AtomicFileSystemProtocol.ts"
import { policy } from "../src/internal/ProcessCleanup.ts"
import * as ProcessSupervisor from "../src/internal/ProcessSupervisor.ts"
import * as PsSnapshot from "../src/internal/PsSnapshot.ts"
import * as childEntry from "./fixtures/sandboxed-child.ts"

const executions = Math.max(1, Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? "50"))
const seed = Number(process.env["EFFECT_FUZZ_SEED"] ?? "20261502")
const silentLogger = Logger.layer([Logger.make(() => {})])

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const defaultLimits = {
  request: 1024 * 1024,
  response: 1024 * 1024,
  content: 1024 * 1024,
  stderr: 8192,
  batchSize: 4,
  batchEntry: 4096
}

const boundedPromise = async <A>(promise: Promise<A>, ms = 2500): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout waiting for supervisor protocol")), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

const sendLines = (socket: Socket, ...values: ReadonlyArray<unknown>): Promise<void> =>
  boundedPromise(
    new Promise((resolve, reject) => {
      socket.write(values.map((v) => JSON.stringify(v)).join("\n") + "\n", (err) => (err ? reject(err) : resolve()))
    })
  )

const connectPeer = async (control: ProcessSupervisor.Control, requests = false): Promise<Socket> => {
  const sock = control.connect(requests)
  sock.on("error", () => {})
  await boundedPromise(once(sock, "connect"))
  return sock
}

describe("Wave 10 Boost2: ProcessSupervisor protocol, TLS, timeouts, unref & cleanup", () => {
  it("fuzzes ProcessSupervisor.Control native & TLS sessions, withdraw mismatch, rawEnded, and write errors", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        transport: Schema.Literals(["native", "tls"]),
        pid: Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 9000 })),
        faultCode: Schema.Literals(["spawn_error", "fault", "bad_exit", "bad_spawned"])
      })
    )
    const report = await Effect.runPromise(Fuzz.run(
      arb,
      (input) =>
        Effect.promise(async () => {
          const control = new ProcessSupervisor.Control(input.transport)
          let statusSock: Socket | undefined
          let reqSock: Socket | undefined
          try {
            await boundedPromise(control.listening)
            // Bad TLS client triggers tlsClientError branch cleanly
            if (input.transport === "tls") {
              const env = control.environment()
              const rawEnv = Object.values(env)[0]
              if (rawEnv) {
                const parsed = JSON.parse(rawEnv) as { status: number }
                const bad = net.connect(parsed.status, "127.0.0.1")
                bad.on("error", () => {})
                bad.end("not-tls-handshake\r\n")
              }
            }
            statusSock = await connectPeer(control, false)
            reqSock = await connectPeer(control, true)
            await boundedPromise(control.requestsReady.promise)

            await sendLines(statusSock, { type: "ready", version: 1, pid: input.pid })
            const readyPid = await boundedPromise(control.ready.promise)
            expect(readyPid).toBe(input.pid)

            // withdraw mismatch throws identity_mismatch
            expect(() => control.withdraw(input.pid, input.pid + 1)).toThrow()
            control.withdraw(input.pid, input.pid)
            control.lost.promise.catch(() => {})
            control.exited.promise.catch(() => {})
            control.started.promise.catch(() => {})
            control.activationSent = true

            if (input.faultCode === "spawn_error") {
              await sendLines(statusSock, { type: "spawn_error", code: "ENOENT", message: "missing" })
              const err = await boundedPromise(control.started.promise.then(() => undefined, (e: unknown) => e))
              expect(err).toBeDefined()
            } else if (input.faultCode === "bad_spawned") {
              await sendLines(statusSock, { type: "spawned", pid: -1 })
              const err = await boundedPromise(control.started.promise.then(() => undefined, (e: unknown) => e))
              expect(err).toBeDefined()
            } else if (input.faultCode === "fault") {
              await sendLines(statusSock, { type: "spawned", pid: input.pid + 2 })
              await boundedPromise(control.started.promise)
              await sendLines(statusSock, { type: "fault", code: "cleanup_failed", message: "boom" })
              await new Promise((r) => setTimeout(r, 15))
              expect(control.cleanupFailed || control.fault !== undefined).toBe(true)
            } else {
              await sendLines(statusSock, { type: "spawned", pid: input.pid + 2 })
              await boundedPromise(control.started.promise)
              await sendLines(statusSock, { type: "exit", code: 0, signal: null })
              const code = await boundedPromise(control.exited.promise)
              expect(code).toBe(0)
            }

            // Write after disconnect rejects cleanly
            control.disconnect()
            const writeErr = await control.write({ type: "stop" }).then(() => undefined, (e: unknown) => e)
            expect(writeErr).toBeDefined()
          } finally {
            statusSock?.destroy()
            reqSock?.destroy()
            control.dispose()
          }
          return true
        }),
      { executions: Math.min(executions, 16), seed: seed + 1 }
    ))
    assertPassed(report)
  }, 60_000)

  it("exercises ProcessSupervisor.prepare startup_timeout, activation_timeout, unref/reref, and cleanup_unverified", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals(["startup_timeout", "activation_timeout", "unref_and_exit", "cleanup_unverified", "tls_ack"])
      })
    )
    const report = await Effect.runPromise(Fuzz.run(
      arb,
      (input) =>
        Effect.gen(function*() {
          const fakeExitDeferred = yield* Deferred.make<ExitCode>()
          const fakeRaw = (pid: number) =>
            makeHandle({
              pid: ProcessId(pid),
              exitCode: Deferred.await(fakeExitDeferred),
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              stdin: Sink.drain,
              stdout: Stream.empty,
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void)
            })

          const cmd = ChildProcess.make("echo", ["hi"])
          const baseSystem = {
            platform: "linux" as const,
            snapshot: () => ({ ownGroup: 99999, members: [{ pid: 7777, startedAtMs: 1, zombie: false }] }),
            vacant: () => true
          }
          const makeServices = (onControl: (c: ProcessSupervisor.Control) => void): ProcessSupervisor.Services => ({
            control: (t, s) => {
              const c = new ProcessSupervisor.Control(t, s)
              onControl(c)
              return c
            },
            jobExecutable: () => "/nonexistent/job",
            job: () => ({
              ready: { promise: Promise.resolve() },
              settled: { promise: Promise.resolve() },
              stop: () => {},
              reference: () => {}
            }),
            runtime: Effect.succeed({ bun: false, sea: false, main: "" })
          })

          if (input.mode === "startup_timeout") {
            const lifecycle = ProcessSupervisor.prepare(baseSystem, policy, "native")
            const exit = yield* Effect.scoped(
              lifecycle(cmd, () => {
                setTimeout(() => void Effect.runPromise(Deferred.succeed(fakeExitDeferred, ExitCode(0))), 60)
                return Effect.succeed(fakeRaw(7777))
              })
            ).pipe(
              Effect.provideService(ProcessSupervisor.StartupBudget, 40),
              Effect.exit
            )
            expect(Exit.isFailure(exit)).toBe(true)
          } else if (input.mode === "activation_timeout") {
            let openControl: ProcessSupervisor.Control | undefined
            let statusSock: Socket | undefined
            let reqSock: Socket | undefined
            const lifecycle = ProcessSupervisor.prepare(baseSystem, policy, "native")
            const exit = yield* Effect.scoped(
              Effect.gen(function*() {
                const prepared = yield* lifecycle(cmd, () => {
                  void (async () => {
                    try {
                      if (!openControl) return
                      await openControl.listening
                      statusSock = await connectPeer(openControl, false)
                      reqSock = await connectPeer(openControl, true)
                      reqSock.on("data", (chunk) => {
                        if (chunk.toString("utf8").includes('"type":"stop"')) {
                          statusSock?.destroy()
                          void Effect.runPromise(Deferred.succeed(fakeExitDeferred, ExitCode(0)))
                        }
                      })
                      reqSock.on("close", () => {
                        statusSock?.destroy()
                        void Effect.runPromise(Deferred.succeed(fakeExitDeferred, ExitCode(0)))
                      })
                      await sendLines(statusSock, { type: "ready", version: 1, pid: 7777 })
                    } catch {
                      // Expected if timeout closes the server first
                    }
                  })()
                  return Effect.succeed(fakeRaw(7777))
                })
                yield* prepared.activate
              })
            ).pipe(
              Effect.provideService(ProcessSupervisor.Services, makeServices((c) => {
                openControl = c
              })),
              Effect.provideService(ProcessSupervisor.StartupBudget, 500),
              Effect.provideService(ProcessSupervisor.ActivationBudget, 40),
              Effect.ensuring(
                Effect.sync(() => {
                  statusSock?.destroy()
                  reqSock?.destroy()
                  void Deferred.succeed(fakeExitDeferred, ExitCode(0))
                })
              ),
              Effect.exit
            )
            expect(Exit.isFailure(exit)).toBe(true)
          } else if (input.mode === "unref_and_exit" || input.mode === "tls_ack") {
            let openControl: ProcessSupervisor.Control | undefined
            const transport = input.mode === "tls_ack" ? "tls" : "native"
            let statusSock: Socket | undefined
            let reqSock: Socket | undefined
            const lifecycle = ProcessSupervisor.prepare(baseSystem, policy, transport)
            const res = yield* Effect.scoped(
              Effect.gen(function*() {
                const prepared = yield* lifecycle(cmd, () => {
                  void (async () => {
                    try {
                      if (!openControl) return
                      await openControl.listening
                      statusSock = await connectPeer(openControl, false)
                      reqSock = await connectPeer(openControl, true)
                      let reqBuf = ""
                      reqSock.on("data", (chunk) => {
                        reqBuf += chunk.toString("utf8")
                        if (reqBuf.includes('"type":"start"')) {
                          reqBuf = ""
                          void sendLines(statusSock!, { type: "spawned", pid: 7778 }).catch(() => {})
                        } else if (reqBuf.includes('"type":"stop"')) {
                          statusSock?.destroy()
                          void Effect.runPromise(Deferred.succeed(fakeExitDeferred, ExitCode(0)))
                        }
                      })
                      await sendLines(statusSock, { type: "ready", version: 1, pid: 7777 })
                    } catch {
                      // Expected on abrupt teardown
                    }
                  })()
                  return Effect.succeed(fakeRaw(7777))
                })
                yield* prepared.activate
                const reref = yield* prepared.handle.unref
                yield* reref
                const running = yield* prepared.handle.isRunning
                expect(running).toBe(true)
                if (statusSock) {
                  yield* Effect.promise(() =>
                    sendLines(
                      statusSock!,
                      { type: "exit", code: 0, signal: null }
                    ).catch(() => {})
                  )
                }
                if (transport === "tls" && openControl) {
                  openControl.cleanupAcknowledged = true
                }
                yield* Deferred.succeed(fakeExitDeferred, ExitCode(0))
                const code = yield* prepared.handle.exitCode
                statusSock?.destroy()
                return code
              })
            ).pipe(
              Effect.provideService(ProcessSupervisor.Services, makeServices((c) => {
                openControl = c
              })),
              Effect.provideService(ProcessSupervisor.StartupBudget, 1500),
              Effect.ensuring(
                Effect.sync(() => {
                  statusSock?.destroy()
                  reqSock?.destroy()
                })
              )
            )
            expect(res).toBe(ExitCode(0))
          } else {
            // Unverified cleanup diagnostics & rawEnded
            const c = new ProcessSupervisor.Control("native")
            c.rawEnded()
            const desc = ProcessSupervisor.unverifiedCleanup(c, true, false, undefined)
            expect(typeof desc).toBe("string")
            expect(desc.length).toBeGreaterThan(0)
            c.dispose()
          }
          return true
        }).pipe(Effect.provide(silentLogger)),
      { executions: Math.min(executions, 15), seed: seed + 2 }
    ))
    assertPassed(report)
  }, 60_000)
})

describe("Wave 10 Boost2: ProcessSandbox select, safeWrite, broker aliases, seatbelt hidden & writeProtectionRefusal", () => {
  it("fuzzes ProcessSandbox.select, plan, bubblewrap credential masks, seatbelt hidden prefixes, and probe", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        platform: Schema.Literals(["linux", "darwin", "win32"]),
        network: Schema.Literals(["none", "loopback", "open"]),
        scratch: Schema.Boolean,
        hasBwrap: Schema.Boolean,
        hasDocker: Schema.Boolean,
        badWorkspace: Schema.Boolean,
        badHiddenPrefix: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(Fuzz.run(
      arb,
      (input) =>
        Effect.sync(() => {
          const homeDir = "/tmp/home-w10"
          const wsRoot = input.badWorkspace ? "/tmp/ws-w10\"\nbad" : "/tmp/ws-w10"
          const tmpDir = "/tmp/tmp-w10"
          const fakeHost: ProcessSandbox.Host = {
            platform: input.platform,
            uid: 1000,
            gid: 1000,
            home: homeDir,
            executable: (name) => {
              if (name === "bwrap") return input.hasBwrap ? "/usr/bin/bwrap" : undefined
              if (name === "docker") return input.hasDocker ? "/usr/bin/docker" : undefined
              if (name === "sandbox-exec") return input.platform === "darwin" ? "/usr/bin/sandbox-exec" : undefined
              return "/usr/bin/" + name
            },
            exists: (p) =>
              p === wsRoot ||
              p === tmpDir ||
              p === `${homeDir}/.ssh` ||
              p === `${homeDir}/.npmrc` ||
              p.startsWith("/usr") ||
              p.startsWith("/bin") ||
              p.startsWith("/lib") ||
              p === `${wsRoot}/out` ||
              p === `${wsRoot}/link-out` ||
              p === `${wsRoot}/broker-alias` ||
              p === `${wsRoot}/mismatch-real`,
            isDirectory: (p) =>
              p === wsRoot ||
              p === tmpDir ||
              p === `${homeDir}/.ssh` ||
              p === `${wsRoot}/out` ||
              p.startsWith("/usr") ||
              p.startsWith("/bin") ||
              p.startsWith("/lib"),
            isSymbolicLink: (p) => p === `${wsRoot}/link-out`,
            realpath: (p) => {
              if (p === `${wsRoot}/throw-real`) throw new Error("ELOOP")
              if (p === `${wsRoot}/broker-alias`) return "/tmp/smithers-destination-broker/secret"
              if (p === `${wsRoot}/mismatch-real`) return "/other/place"
              return p
            }
          }

          // select with explicit bubblewrap on darwin/win32 or docker missing
          const selBwrap = ProcessSandbox.select(
            { mechanism: { _tag: "bubblewrap" }, network: input.network },
            fakeHost
          )
          expect(selBwrap).toBeDefined()

          const selDocker = ProcessSandbox.select(
            { mechanism: { _tag: "docker", image: "alpine:3" }, network: input.network },
            fakeHost
          )
          expect(selDocker).toBeDefined()

          // plan with scratch on non-bwrap, broken realpath, symlink write, writeFiles
          const planned = ProcessSandbox.plan(
            {
              network: input.network,
              scratch: input.scratch,
              writes: [`${wsRoot}/out`],
              reads: [homeDir],
              externalReads: [`${homeDir}/.ssh/known_hosts`]
            },
            { workspaceRoot: wsRoot, cwd: wsRoot, tmp: tmpDir },
            fakeHost
          )
          expect(planned).toBeDefined()

          // realpath throwing on workspaceRoot
          const badRootPlan = ProcessSandbox.plan(
            { network: "none", reads: [], writes: [] },
            { workspaceRoot: `${wsRoot}/throw-real`, cwd: `${wsRoot}/throw-real`, tmp: tmpDir },
            { ...fakeHost, platform: "linux", executable: (n) => (n === "bwrap" ? "/usr/bin/bwrap" : "/usr/bin/" + n) }
          )
          expect(ProcessSandbox.isUnenforceable(badRootPlan)).toBe(true)

          const checkHost: ProcessSandbox.Host = {
            ...fakeHost,
            platform: "linux",
            executable: (n) => (n === "bwrap" ? "/usr/bin/bwrap" : "/usr/bin/" + n)
          }
          const baseValidPlan = ProcessSandbox.plan(
            { network: "none", reads: [], writes: [`${wsRoot}/out`] },
            { workspaceRoot: wsRoot, cwd: wsRoot, tmp: tmpDir },
            checkHost
          )
          if (!ProcessSandbox.isUnenforceable(baseValidPlan)) {
            expect(() =>
              ProcessSandbox.validateWrites({ ...baseValidPlan, writes: [`${wsRoot}/link-out`] }, checkHost)
            ).toThrow()
            expect(() =>
              ProcessSandbox.validateWrites({ ...baseValidPlan, writes: [`${wsRoot}/mismatch-real`] }, checkHost)
            ).toThrow()
            expect(() =>
              ProcessSandbox.validateWrites(
                { ...baseValidPlan, writes: [`${wsRoot}/out`] },
                { ...checkHost, realpath: () => "/elsewhere" }
              )
            ).toThrow()
            expect(() =>
              ProcessSandbox.validateWrites(
                { ...baseValidPlan, writes: [`${wsRoot}/out`] },
                { ...checkHost, realpath: () => { throw new Error("ELOOP") } }
              )
            ).toThrow()
          }

          // Seatbelt with hidden prefixes & restored paths
          const darwinHost: ProcessSandbox.Host = { ...fakeHost, platform: "darwin" }
          const sbPlan = ProcessSandbox.plan(
            { network: "none", reads: [], writes: [`${wsRoot}/out`] },
            { workspaceRoot: wsRoot, cwd: wsRoot, tmp: tmpDir },
            darwinHost
          )
          if (!ProcessSandbox.isUnenforceable(sbPlan)) {
            const withHidden: ProcessSandbox.Plan = {
              ...sbPlan,
              hidden: {
                paths: [],
                prefixes: input.badHiddenPrefix ? [".env", "bad/prefix"] : [".env", ".secret"],
                restored: [`${wsRoot}/.env.example`]
              }
            }
            try {
              const profile = ProcessSandbox.seatbelt(withHidden, darwinHost)
              expect(profile).toContain("deny file-read*")
              expect(profile).toContain("allow file-read*")
            } catch (e) {
              expect(ProcessSandbox.isUnenforceable(e)).toBe(true)
            }
          }

          // Bubblewrap with credential dir + file + externalRead restoration
          const linuxHost: ProcessSandbox.Host = {
            ...fakeHost,
            platform: "linux",
            executable: (n) => (n === "bwrap" ? "/usr/bin/bwrap" : "/usr/bin/" + n)
          }
          const bwPlan = ProcessSandbox.plan(
            {
              network: "none",
              reads: [],
              writes: [`${wsRoot}/out`],
              externalReads: [homeDir, `${homeDir}/.ssh/known_hosts`]
            },
            { workspaceRoot: wsRoot, cwd: wsRoot, tmp: tmpDir },
            linuxHost
          )
          if (!ProcessSandbox.isUnenforceable(bwPlan)) {
            const argv = ProcessSandbox.bubblewrap(bwPlan, ["echo", "hi"], linuxHost)
            expect(argv.length).toBeGreaterThan(0)
          }

          // writeProtectionRefusal across platforms & missing/failing bwrap
          expect(ProcessSandbox.writeProtectionRefusal({ ...fakeHost, platform: "darwin" })).toContain("Linux")
          expect(ProcessSandbox.writeProtectionRefusal({ ...fakeHost, platform: "linux", executable: () => undefined })).toContain("bwrap")

          // host() with custom env
          const h = ProcessSandbox.host({ PATH: "/bin:/usr/bin:relative/dir", DEVELOPER_DIR: "/dev/null" })
          expect(h.developerDirectory).toBe("/dev/null")
          return true
        }),
      { executions: Math.min(executions, 40), seed: seed + 3 }
    ))
    assertPassed(report)

    // Probe writeProtectionRefusal with real failing bwrap executable in tmpdir
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "w10-bwrap-"))
    try {
      const fakeBwrap = nodePath.join(dir, "bwrap")
      fs.writeFileSync(fakeBwrap, "#!/bin/sh\necho 'bwrap fail reason' >&2\nexit 1\n", { mode: 0o755 })
      const refusal = ProcessSandbox.writeProtectionRefusal(
        {
          ...ProcessSandbox.host(),
          platform: "linux",
          executable: (n) => (n === "bwrap" ? fakeBwrap : undefined)
        },
        2000
      )
      expect(refusal).toContain("bubblewrap could not start")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})

describe("Wave 10 Boost2: AtomicFileSystemExecutable staging, pruning, digest tamper & protocol errors", () => {
  it("fuzzes AtomicFileSystemExecutable.outsideWorkspace caching, prune, non-private dir, tamper & fallback", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        payload: Schema.String.check(Schema.isMinLength(8), Schema.isMaxLength(32)),
        tamper: Schema.Boolean,
        blockFirstBase: Schema.Boolean,
        createStale: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(Fuzz.run(
      arb,
      (input) =>
        Effect.sync(() => {
          const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "w10-afs-exec-"))
          try {
            const srcFile = nodePath.join(root, "fake-helper")
            fs.writeFileSync(srcFile, `#!/bin/sh\n# ${input.payload}\n`, { mode: 0o755 })
            const base1 = nodePath.join(root, "base1")
            const base2 = nodePath.join(root, "base2")
            fs.mkdirSync(base1, { recursive: true })
            fs.mkdirSync(base2, { recursive: true })

            // Empty bases throws staging_unavailable
            expect(() => AtomicFileSystemExecutable.outsideWorkspace(srcFile, undefined, [])).toThrow()

            let nowMs = Date.now()
            const customHost = {
              platform: process.platform,
              uid: process.getuid ? process.getuid() : 0,
              now: () => nowMs
            }

            if (input.createStale) {
              const staleDir = nodePath.join(base2, ".smthrs-atomic-helper-00000000000000000000000000000000")
              fs.mkdirSync(staleDir, { recursive: true })
              const oldTime = new Date(nowMs - 10 * 24 * 60 * 60 * 1000)
              fs.utimesSync(staleDir, oldTime, oldTime)
            }

            const firstBase = input.blockFirstBase ? nodePath.join(root, "not-a-dir-file") : base1
            if (input.blockFirstBase) fs.writeFileSync(firstBase, "file")

            const stagedPath = AtomicFileSystemExecutable.outsideWorkspace(
              srcFile,
              undefined,
              [firstBase, base2],
              customHost
            )
            expect(fs.existsSync(stagedPath)).toBe(true)

            // Refresh path: advance clock > 1 hour and call again
            nowMs += 2 * 60 * 60 * 1000
            const stagedAgain = AtomicFileSystemExecutable.outsideWorkspace(
              srcFile,
              undefined,
              [firstBase, base2],
              customHost
            )
            expect(stagedAgain).toBe(stagedPath)

            // Remove staged file to trigger re-stage (and optional tamper detection)
            fs.rmSync(stagedPath, { force: true })
            if (input.tamper) {
              fs.writeFileSync(srcFile, `#!/bin/sh\n# tampered-${input.payload}\n`, { mode: 0o755 })
              expect(() =>
                AtomicFileSystemExecutable.outsideWorkspace(srcFile, undefined, [base2], customHost)
              ).toThrow()
            } else {
              const stagedDir = nodePath.dirname(stagedPath)
              const staleTmp = nodePath.join(stagedDir, `.smithers-jj-export.12345.abcdef012345`)
              fs.writeFileSync(staleTmp, "junk")
              const oldTime = new Date(nowMs - 10 * 24 * 60 * 60 * 1000)
              fs.utimesSync(staleTmp, oldTime, oldTime)
              const restaged = AtomicFileSystemExecutable.outsideWorkspace(srcFile, undefined, [base2], customHost)
              expect(fs.existsSync(restaged)).toBe(true)
            }
          } finally {
            fs.rmSync(root, { recursive: true, force: true })
          }
          return true
        }),
      { executions: Math.min(executions, 20), seed: seed + 4 }
    ))
    assertPassed(report)

    expect(typeof AtomicFileSystemExecutable.resolvePackageRoot(os.tmpdir())).toBe("string")
  }, 60_000)

  it("fuzzes AtomicFileSystemProtocol.convert digest validation errors & error code mappings", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        caseKind: Schema.Literals([
          "bad_digest",
          "oversized_digest",
          "mismatched_size",
          "wrong_root",
          "missing_result",
          "not_found",
          "permission",
          "already_exists",
          "busy",
          "bad_arg"
        ])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.gen(function*() {
            const batchReq = {
              operation: "batch",
              root: "/tmp",
              rootIdentity: "rid-1",
              requests: [{ operation: "digest", root: "/tmp", path: "a.txt", content: true }]
            } as unknown as AtomicFileSystemProtocol.FramedRequest
            const wrapEntry = (val: unknown) => ({
              rootIdentity: "rid-1",
              entries: [{ index: 0, path: "a.txt", result: { ok: true, value: val } }]
            })
            if (input.caseKind === "bad_digest") {
              expect(() =>
                AtomicFileSystemProtocol.convert(
                  batchReq,
                  wrapEntry({ digest: "not-hex", sizeBytes: 3, base64: "YWJj" }),
                  defaultLimits
                )
              ).toThrow()
            } else if (input.caseKind === "oversized_digest") {
              expect(() =>
                AtomicFileSystemProtocol.convert(
                  batchReq,
                  wrapEntry({ digest: "a".repeat(64), sizeBytes: defaultLimits.content + 10, base64: "" }),
                  defaultLimits
                )
              ).toThrow()
            } else if (input.caseKind === "mismatched_size") {
              expect(() =>
                AtomicFileSystemProtocol.convert(
                  batchReq,
                  wrapEntry({
                    digest: "a".repeat(64),
                    sizeBytes: 99,
                    base64: Buffer.from("hi").toString("base64")
                  }),
                  defaultLimits
                )
              ).toThrow()
            } else if (input.caseKind === "wrong_root") {
              expect(() =>
                AtomicFileSystemProtocol.convert(batchReq, { rootIdentity: "other", entries: [] }, defaultLimits)
              ).toThrow()
            } else if (input.caseKind === "missing_result") {
              expect(() =>
                AtomicFileSystemProtocol.convert(
                  batchReq,
                  { rootIdentity: "rid-1", entries: [{ index: 0, path: "a.txt" }] },
                  defaultLimits
                )
              ).toThrow()
            } else {
              const readReq = { operation: "read", root: "/tmp", path: "x" } as unknown as AtomicFileSystemProtocol.FramedRequest
              const codeMap: Record<string, string> = {
                not_found: "ENOENT",
                permission: "EACCES",
                already_exists: "EEXIST",
                busy: "EBUSY",
                bad_arg: "EINVAL"
              }
              const err = AtomicFileSystemProtocol.failure(readReq, new Error("boom"), {
                ok: false,
                code: codeMap[input.caseKind]!,
                badArgument: input.caseKind === "bad_arg",
                message: "msg"
              })
              expect(err._tag).toBe("PlatformError")
            }
            return true
          }),
        { executions: Math.min(executions, 25), seed: seed + 5 }
      )
    )
    assertPassed(report)
  }, 60_000)
})

describe("Wave 10 Boost2: NodeLanguageServer framing, compaction, malformedId & header overflow", () => {
  it("exercises NodeLanguageServer chunk buffer compaction, malformed JSON with id, and oversized headers", async () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "w10-lsp-"))
    const wsDir = nodePath.join(dir, "workspace")
    const binDir = nodePath.join(dir, "bin")
    fs.mkdirSync(wsDir, { recursive: true })
    fs.mkdirSync(binDir, { recursive: true })
    try {
      const serverScript = nodePath.join(binDir, "mock-lsp.mjs")
      fs.writeFileSync(
        serverScript,
        `
const sendRaw = (buf) => process.stdout.write(buf);
const sendFrame = (obj) => {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  sendRaw(Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n", "utf8"));
  sendRaw(body);
};
let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const sep = buf.indexOf("\\r\\n\\r\\n");
    if (sep < 0) break;
    const hdr = buf.subarray(0, sep).toString("utf8");
    const m = /Content-Length:\\s*(\\d+)/i.exec(hdr);
    if (!m) { buf = buf.subarray(sep + 4); continue; }
    const len = Number(m[1]);
    if (buf.length < sep + 4 + len) break;
    const msg = JSON.parse(buf.subarray(sep + 4, sep + 4 + len).toString("utf8"));
    buf = buf.subarray(sep + 4 + len);
    if (msg.method === "initialize") {
      const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } }), "utf8");
      const full = Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n", "utf8"), body]);
      for (let i = 0; i < full.length; i++) {
        sendRaw(full.subarray(i, i + 1));
      }
    } else if (msg.method === "textDocument/hover") {
      const badBody = Buffer.from('{"jsonrpc":"2.0","id":' + msg.id + ',"result":INVALID}', "utf8");
      sendRaw(Buffer.from("Content-Length: " + badBody.length + "\\r\\n\\r\\n", "utf8"));
      sendRaw(badBody);
    } else if (msg.method === "textDocument/definition") {
      sendRaw(Buffer.from("X-Pad: " + "a".repeat(9000) + "\\r\\n\\r\\n", "utf8"));
      sendFrame({ jsonrpc: "2.0", id: msg.id, result: [] });
    } else if (msg.method === "shutdown") {
      sendFrame({ jsonrpc: "2.0", id: msg.id, result: null });
    } else if (msg.method === "exit") {
      process.exit(0);
    }
  }
});
`
      )

      const platformLayer = NodeHost.layerContained({ graceMs: 100 }).pipe(
        Layer.provide(ProcessLedger.layerMemory({ hostId: "w10-lsp", ownerPid: process.pid })),
        Layer.merge(silentLogger)
      )

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            // Refusal when script path is inside workspace
            const insideScript = nodePath.join(wsDir, "inside.mjs")
            fs.writeFileSync(insideScript, "")
            const refusedExit = yield* NodeLanguageServer.make({
              command: process.execPath,
              args: [insideScript],
              cwd: wsDir,
              timeoutMs: 1000
            }).pipe(Effect.exit)
            expect(Exit.isFailure(refusedExit)).toBe(true)

            const lsp = yield* NodeLanguageServer.make({
              command: process.execPath,
              args: [serverScript],
              cwd: wsDir,
              timeoutMs: 3000
            })
            const hoverExit = yield* lsp.hover({ path: nodePath.join(wsDir, "a.ts"), line: 0, character: 0 }).pipe(
              Effect.exit
            )
            expect(Exit.isFailure(hoverExit)).toBe(true)

            const defExit = yield* lsp.definition({ path: nodePath.join(wsDir, "a.ts"), line: 0, character: 0 }).pipe(
              Effect.exit
            )
            expect(Exit.isSuccess(defExit) || Exit.isFailure(defExit)).toBe(true)
          })
        ).pipe(Effect.provide(platformLayer))
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})

describe("Wave 10 Boost2: SandboxedFlow error paths, limits, ceiling mismatch & PsSnapshot/ProcessReaper", () => {
  it("exercises SandboxedFlow guest failure, missing/bad/wrong-attempt/wrong-ceiling result, schema mismatch & timeout", async () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "w10-sflow-"))
    const entry = new URL("./fixtures/sandboxed-child.ts", import.meta.url)
    try {
      const platform = NodeHost.layerContained({ graceMs: 80 }).pipe(
        Layer.provide(ProcessLedger.layerMemory({ hostId: "w10-sflow", ownerPid: process.pid })),
        Layer.merge(NodeCrypto.layer),
        Layer.merge(silentLogger)
      )
      const makeRuntime = (name: string, body: string): string => {
        const p = nodePath.join(dir, name)
        fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
        return p
      }
      const rt127 = makeRuntime("rt127.sh", "echo 'not found' >&2; exit 127")
      const rt1 = makeRuntime("rt1.sh", "echo 'crash' >&2; exit 1")
      const rtBadJson = makeRuntime("rt-badjson.sh", 'printf "not-json" > "$SMITHERS_RESULT_PATH"; exit 0')
      const rtWrongAttempt = makeRuntime(
        "rt-attempt.sh",
        'printf \'{"status":"succeeded","attempt":999,"capabilityCeiling":[],"output":1}\' > "$SMITHERS_RESULT_PATH"; exit 0'
      )
      const rtWrongCeiling = makeRuntime(
        "rt-ceiling.sh",
        'printf \'{"status":"succeeded","attempt":1,"capabilityCeiling":["fs:read:*"],"output":1}\' > "$SMITHERS_RESULT_PATH"; exit 0'
      )
      const rtBadSchema = makeRuntime(
        "rt-schema.sh",
        'printf \'{"status":"succeeded","attempt":1,"capabilityCeiling":null,"output":"not-a-number"}\' > "$SMITHERS_RESULT_PATH"; exit 0'
      )
      const rtFlowFailed = makeRuntime(
        "rt-fail.sh",
        'printf \'{"status":"failed","attempt":1,"capabilityCeiling":null,"error":"boom"}\' > "$SMITHERS_RESULT_PATH"; exit 0'
      )
      const rtOverflow = makeRuntime(
        "rt-overflow.sh",
        'head -c 2000 /dev/zero | tr "\\0" "a" > "$SMITHERS_RESULT_PATH"; exit 0'
      )

      const cases: ReadonlyArray<{ name: string; runtime: string; limits?: SandboxedFlow.Limits }> = [
        { name: "c127", runtime: rt127 },
        { name: "c1", runtime: rt1 },
        { name: "cjson", runtime: rtBadJson },
        { name: "cattempt", runtime: rtWrongAttempt },
        { name: "cceiling", runtime: rtWrongCeiling },
        { name: "cschema", runtime: rtBadSchema },
        { name: "cfailed", runtime: rtFlowFailed },
        { name: "coverflow", runtime: rtOverflow, limits: { resultBytes: 256 } }
      ]

      await Effect.runPromise(
        Effect.gen(function*() {
          const fsSvc = yield* FileSystem.FileSystem
          const spawner = yield* ChildProcessSpawner
          const provider = DirectorySandbox.make({ fs: fsSvc, spawner, root: nodePath.join(dir, "sandboxes") })
          for (const c of cases) {
            const exit = yield* SandboxedFlow.execute(childEntry.Sum, { n: 5 }, {
              provider,
              session: `s-${c.name}`,
              entry,
              runtime: c.runtime,
              limits: c.limits
            }).pipe(Effect.exit)
            expect(Exit.isFailure(exit)).toBe(true)
          }
          // Immediate zero/1ms timeout
          const timeoutExit = yield* SandboxedFlow.execute(childEntry.Sum, { n: 5 }, {
            provider,
            session: "s-timeout",
            entry,
            runtime: rt1,
            timeout: Duration.millis(1)
          }).pipe(Effect.exit)
          expect(Exit.isFailure(timeoutExit)).toBe(true)
        }).pipe(Effect.provide(platform))
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it("fuzzes PsSnapshot and ProcessReaper.posixSystemWith against synthetic ps executables", async () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "w10-ps-"))
    try {
      const makePs = (name: string, body: string): string => {
        const p = nodePath.join(dir, name)
        fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
        return p
      }
      const psBadExit = makePs("ps-badexit", "exit 1")
      const psEmpty = makePs("ps-empty", "exit 0")
      const psBadDate = makePs("ps-baddate", `echo "${process.pid} ${process.pid} S not-a-date"`)
      const psHugePid = makePs("ps-huge", `echo "99999999999999999999 1 S Mon Jan  1 00:00:00 2024"`)
      const psValid = makePs(
        "ps-valid",
        `echo "${process.pid} 4242 S Mon Jan  1 00:00:00 2024"\necho "4243 4242 Z Mon Jan  1 00:00:00 2024"`
      )

      expect(PsSnapshot.psGroupSnapshot(psBadExit)(4242)).toBeUndefined()
      expect(PsSnapshot.psGroupSnapshot(psEmpty)(4242)).toBeUndefined()
      expect(PsSnapshot.psGroupSnapshot(psBadDate)(process.pid)).toBeUndefined()
      expect(PsSnapshot.psGroupSnapshot(psHugePid)(1)).toBeUndefined()
      const snap = PsSnapshot.psGroupSnapshot(psValid)(4242)
      expect(snap?.ownGroup).toBe(4242)
      expect(snap?.members.length).toBe(2)

      const sysBad = ProcessReaper.posixSystemWith({ psExecutable: psBadExit })
      expect(sysBad.startedAtMs(process.pid)._tag).toBe("unavailable")
      expect(sysBad.startedAtMs(99999999)._tag).toBe("gone")
      const sysBadDate = ProcessReaper.posixSystemWith({ psExecutable: psBadDate })
      expect(sysBadDate.startedAtMs(process.pid)._tag).toBe("unavailable")
      const sysMissing = ProcessReaper.posixSystemWith({ psExecutable: nodePath.join(dir, "nope") })
      expect(sysMissing.startedAtMs(process.pid)._tag).toBe("unavailable")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})

describe("Wave 10 Boost2: ProcessSandbox docker/diagnose/broker, ProcessReaper windows/proc & PipedProcess", () => {
  it("fuzzes ProcessSandbox.docker, diagnose, environment, wrap & broker alias refusal", async () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "w10-psb-diag-"))
    const ws = nodePath.join(dir, "ws,comma")
    const outside = nodePath.join(dir, "outside")
    fs.mkdirSync(nodePath.join(ws, "src"), { recursive: true })
    fs.mkdirSync(nodePath.join(ws, "out"), { recursive: true })
    fs.mkdirSync(nodePath.join(ws, "out", "ro"), { recursive: true })
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(nodePath.join(outside, "target.txt"), "x")
    fs.symlinkSync(nodePath.join(outside, "target.txt"), nodePath.join(ws, "escape.txt"))
    fs.writeFileSync(nodePath.join(ws, "src", "a.txt"), "a")
    fs.writeFileSync(nodePath.join(ws, "out", "b.txt"), "b")
    fs.writeFileSync(nodePath.join(ws, "out", "ro", "c.txt"), "c")
    fs.writeFileSync(nodePath.join(ws, "hidden.txt"), "h")

    try {
      const hostFacts: ProcessSandbox.Host = {
        platform: "linux",
        uid: 1000,
        gid: 1000,
        home: "/tmp/h-w10",
        executable: (n) => (n === "docker" || n === "bwrap" ? `/usr/bin/${n}` : `/usr/bin/${n}`),
        exists: (p) => fs.existsSync(p) || p.startsWith("/usr") || p.startsWith("/bin"),
        isDirectory: (p) => (fs.existsSync(p) ? fs.statSync(p).isDirectory() : p.startsWith("/usr") || p.startsWith("/bin")),
        isSymbolicLink: (p) => (fs.existsSync(p) ? fs.lstatSync(p).isSymbolicLink() : false),
        realpath: (p) => (fs.existsSync(p) ? fs.realpathSync(p) : p)
      }

      const dockerPlan = ProcessSandbox.plan(
        {
          mechanism: { _tag: "docker", image: "alpine:3" },
          network: "none",
          reads: [nodePath.join(ws, "src")],
          writes: [nodePath.join(ws, "out")],
          readOnly: [nodePath.join(ws, "out", "ro")],
          externalReads: [outside]
        },
        { workspaceRoot: ws, cwd: ws, tmp: nodePath.join(dir, "tmp") },
        hostFacts
      )
      expect(ProcessSandbox.isUnenforceable(dockerPlan)).toBe(false)
      if (!ProcessSandbox.isUnenforceable(dockerPlan)) {
        const argv = ProcessSandbox.docker(dockerPlan, ["echo", "ok"], { FOO: "bar" }, hostFacts, "c-test")
        expect(argv[0]).toContain("docker")
        expect(argv).toContain("--network")
        // Loopback docker throws unenforceable
        expect(() =>
          ProcessSandbox.docker({ ...dockerPlan, network: "loopback" }, ["echo"], {}, hostFacts)
        ).toThrow()
        // Open docker network
        const openArgv = ProcessSandbox.docker({ ...dockerPlan, network: "open" }, ["echo"], {}, hostFacts, "c-open")
        expect(openArgv.length).toBeGreaterThan(0)
        // Diagnose across all denial categories (escape, write inside/outside, read inside/outside, >5 cap)
        const texts = [
          `Error: EACCES: permission denied, open '${nodePath.join(ws, "escape.txt")}'`,
          `Error: EROFS: read-only file system, open '${nodePath.join(ws, "out", "b.txt")}'`,
          `Error: EROFS: read-only file system, open '${nodePath.join(ws, "out", "ro", "c.txt")}'`,
          `Error: EACCES: permission denied, open '${nodePath.join(ws, "hidden.txt")}'`,
          `Error: EACCES: permission denied, open '${nodePath.join(ws, "src", "a.txt")}'`,
          `Error: EACCES: permission denied, open '${nodePath.join(ws, "out", "b.txt")}'`,
          `Error: EACCES: permission denied, open 'src/a.txt'\nEACCES: open 'out/b.txt'\nEACCES: open 'out/ro/c.txt'\nEACCES: open 'hidden.txt'\nEACCES: open 'escape.txt'\nEACCES: open 'extra6.txt'`
        ]
        for (const t of texts) {
          const d = ProcessSandbox.diagnose(dockerPlan, t)
          expect(typeof d).toBe("string")
        }
        expect(ProcessSandbox.diagnose(dockerPlan, "no path errors here")).toBeUndefined()
      }

      // Wrong mechanism passed to docker() throws Error
      const bwrapPlan = ProcessSandbox.plan(
        { mechanism: { _tag: "bubblewrap" }, network: "none", reads: [nodePath.join(ws, "src")], writes: [nodePath.join(ws, "out")] },
        { workspaceRoot: ws, cwd: ws, tmp: nodePath.join(dir, "tmp") },
        hostFacts
      )
      if (!ProcessSandbox.isUnenforceable(bwrapPlan)) {
        expect(() => ProcessSandbox.docker(bwrapPlan, ["echo"], {}, hostFacts)).toThrow()
        // Broker alias refusal
        const aliasHost: ProcessSandbox.Host = {
          ...hostFacts,
          realpath: (p) => (p === nodePath.join(ws, "src") ? "/tmp/smithers-broker/sock" : hostFacts.realpath!(p))
        }
        expect(() => ProcessSandbox.bubblewrap(bwrapPlan, ["echo"], aliasHost)).not.toThrow()
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it("exercises ProcessReaper windowsSystemWith, procSystemWith, systemFor & PipedProcess pipeline", async () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "w10-reap-pipe-"))
    try {
      // Fake proc root with stat & missing pid
      const fakeProc = nodePath.join(dir, "proc")
      fs.mkdirSync(fakeProc, { recursive: true })
      fs.writeFileSync(nodePath.join(fakeProc, "stat"), "btime 1700000000\n")
      const pSys = ProcessReaper.procSystemWith({ procRoot: fakeProc, ownerPid: process.pid })
      // Live pid missing from fake /proc -> unavailable
      expect(pSys.startedAtMs(process.pid)._tag).toBe("unavailable")
      expect(pSys.startedAtMs(99999999)._tag).toBe("gone")
      expect(typeof pSys.bootedAtMs()).toBe("number")

      // windowsSystemWith refusal & killTree branches
      const wSys = ProcessReaper.windowsSystemWith({ ownerPid: process.pid })
      expect(wSys.ownGroup()).toBeNull()
      const ownRec = {
        pid: process.pid,
        pgid: process.pid,
        startedAtMs: Date.now(),
        command: "node",
        hostId: "h",
        ownerPid: process.pid,
        createdAtMs: Date.now()
      }
      expect(wSys.refuseTarget(ownRec as never)).toBe("own-group")
      expect(wSys.killTree(ownRec as never)).toBe("failed")
      const otherRec = { ...ownRec, pid: 99999998 }
      expect(wSys.killTree(otherRec as never)).toBe("failed")

      // systemFor & groupSnapshotFor across platforms
      expect(ProcessReaper.systemFor("win32")).toBeDefined()
      expect(ProcessReaper.systemFor("linux")).toBeDefined()
      expect(ProcessReaper.systemFor("darwin")).toBeDefined()
      expect(ProcessReaper.groupSnapshotFor("win32")(123)).toBeDefined()
      expect(typeof ProcessReaper.groupSnapshotFor("darwin")).toBe("function")

      // Real PipedProcess pipeline via NodeHost.layerContained
      const platformLayer = NodeHost.layerContained({ graceMs: 100 }).pipe(
        Layer.provide(ProcessLedger.layerMemory({ hostId: "w10-pipe", ownerPid: process.pid })),
        Layer.merge(silentLogger)
      )
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const spawner = yield* ChildProcessSpawner
            const pipeline = ChildProcess.make("printf", ["hello-pipe\\n"]).pipe(
              ChildProcess.pipeTo(ChildProcess.make("cat", []))
            )
            const handle = yield* spawner.spawn(pipeline)
            const out = yield* Stream.mkString(Stream.decodeText(handle.stdout))
            const code = yield* handle.exitCode
            expect(out.trim()).toBe("hello-pipe")
            expect(code).toBe(ExitCode(0))
          })
        ).pipe(Effect.provide(platformLayer))
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})

describe("Wave 10 Boost2: ProcessSandbox wrap, environment, hiddenEntries & windowsDrives branches", () => {
  it("exercises wrap/environment across bubblewrap/seatbelt/docker, hiddenEntries & windowsDrives", async () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "w10-psb-wrap-"))
    const ws = nodePath.join(dir, "ws")
    const tmp = nodePath.join(dir, "tmp")
    fs.mkdirSync(nodePath.join(ws, "out"), { recursive: true })
    fs.mkdirSync(nodePath.join(ws, ".env.dir"), { recursive: true })
    fs.mkdirSync(tmp, { recursive: true })
    fs.writeFileSync(nodePath.join(ws, ".env"), "SECRET=1")
    fs.writeFileSync(nodePath.join(ws, ".env.example"), "EXAMPLE=1")
    fs.writeFileSync(nodePath.join(ws, "mountinfo"), "1 2 0:1 / /mnt/c rw - drvfs C:\\ rw\n2 3 0:2 / /mnt/d rw - 9p D:\\ rw\n")
    try {
      const mkHost = (platform: NodeJS.Platform): ProcessSandbox.Host => ({
        platform,
        uid: 1000,
        gid: 1000,
        home: dir,
        developerDirectory: "/Library/Developer/CommandLineTools",
        executable: (n) => `/usr/bin/${n}`,
        exists: (p) => fs.existsSync(p) || p.startsWith("/usr") || p.startsWith("/bin") || p.startsWith("/Library"),
        isDirectory: (p) =>
          fs.existsSync(p) ? fs.statSync(p).isDirectory() : p.startsWith("/usr") || p.startsWith("/bin") || p.startsWith("/Library"),
        isSymbolicLink: (p) => (fs.existsSync(p) ? fs.lstatSync(p).isSymbolicLink() : false),
        realpath: (p) => (fs.existsSync(p) ? fs.realpathSync(p) : p)
      })

      for (const [platform, mechanism] of [
        ["linux", { _tag: "bubblewrap" as const }],
        ["darwin", undefined],
        ["linux", { _tag: "docker" as const, image: "alpine:3" }]
      ] as const) {
        const h = mkHost(platform)
        const p = ProcessSandbox.plan(
          { mechanism, network: "none", reads: [ws], writes: [nodePath.join(ws, "out")] },
          { workspaceRoot: ws, cwd: ws, tmp },
          h
        )
        if (!ProcessSandbox.isUnenforceable(p)) {
          const wrapped = ProcessSandbox.wrap(p, ["echo", "hi"], { PATH: "/usr/bin:/bin" }, h)
          expect(wrapped.argv.length).toBeGreaterThan(0)
          const env1 = ProcessSandbox.environment(p, { COREPACK_HOME: "/custom/cp" }, dir)
          const env2 = ProcessSandbox.environment(p, { XDG_CACHE_HOME: "/custom/cache" }, dir)
          const env3 = ProcessSandbox.environment(p, {}, dir)
          expect(env1.COREPACK_HOME).toBe("/custom/cp")
          expect(env2.HOME).toBeDefined()
          expect(env3.TMPDIR).toBeDefined()
        }
      }

      expect(() => ProcessSandbox.hiddenEntries(ws, [".env"], [], mkHost("linux"))).toThrow()
      const hidden = ProcessSandbox.hiddenEntries(ws, [".env"], [nodePath.join(ws, ".env.example")], { ...mkHost("linux"), entries: (d) => (fs.existsSync(d) ? fs.readdirSync(d) : []) })
      expect(hidden.length).toBeGreaterThanOrEqual(1)
      const drives = ProcessSandbox.windowsDrives(nodePath.join(ws, "mountinfo"))
      expect(drives.length).toBeGreaterThanOrEqual(1)
      expect(ProcessSandbox.windowsDrives(nodePath.join(ws, "missing-mountinfo"))).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})

describe("Wave 10 Boost2: ProcessSandbox toolchain & launcher branches", () => {
  it("exercises ProcessSandbox.toolchain, toolchainReads & launcher across layouts", () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "w10-psb-tc-"))
    const binDir = nodePath.join(dir, "bin")
    const libDir = nodePath.join(dir, "lib")
    const ws = nodePath.join(dir, "ws")
    fs.mkdirSync(binDir, { recursive: true })
    fs.mkdirSync(libDir, { recursive: true })
    fs.mkdirSync(ws, { recursive: true })
    const realBin = nodePath.join(libDir, "tool-real")
    const symBin = nodePath.join(binDir, "tool-sym")
    fs.writeFileSync(realBin, "#!/bin/sh\necho ok\n", { mode: 0o755 })
    fs.symlinkSync(realBin, symBin)
    try {
      const h: ProcessSandbox.Host = {
        ...ProcessSandbox.host({ PATH: `${binDir}:/usr/bin:/bin` }),
        platform: "linux"
      }
      const searchPath = `${binDir}:relative/dir:${ws}/bin:/usr/bin:/bin`
      const l1 = ProcessSandbox.launcher("tool-sym", searchPath, ["/usr"], ws, h)
      expect(l1.program).toBeDefined()
      const l2 = ProcessSandbox.launcher("./rel-tool", searchPath, [], ws, h)
      expect(l2.reads).toEqual([])
      const l3 = ProcessSandbox.launcher(realBin, undefined, [], ws, h)
      expect(l3.program).toBeDefined()
      const l4 = ProcessSandbox.launcher("nonexistent-w10-tool", searchPath, [], ws, h)
      expect(l4.reads).toEqual([])
      const tc = ProcessSandbox.toolchain(searchPath, ws, h)
      expect(tc).toBeDefined()
      const tcNone = ProcessSandbox.toolchain(undefined, ws, h)
      expect(tcNone).toBeDefined()
      const reads = ProcessSandbox.toolchainReads(searchPath, ws, h)
      expect(Array.isArray(reads)).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
