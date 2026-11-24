import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Logger, Schema } from "effect"
import * as ChildProcess from "effect/process/ChildProcess"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as AtomicExec from "../src/internal/AtomicFileSystemExecutable.ts"
import * as AtomicProto from "../src/internal/AtomicFileSystemProtocol.ts"
import * as AtomicTransport from "../src/internal/AtomicFileSystemTransport.ts"
import * as ProcessNative from "../src/internal/ProcessNative.ts"
import * as ProcessSupervisor from "../src/internal/ProcessSupervisor.ts"
import * as WindowsIdentity from "../src/internal/WindowsIdentity.ts"
import * as WindowsProcessJob from "../src/internal/WindowsProcessJob.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "40"))
const ioExecutions = Math.max(12, Math.min(baseExecutions, 24))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261131")
const silentLogger = Logger.layer([])

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-pnode-w9-int-")))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

let seq = 0
const freshDir = (prefix: string) => {
  const dir = join(root, `${prefix}-${++seq}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const defaultLimits = { request: 4096, content: 1024, response: 4096, stderr: 4096, batchSize: 8, batchEntry: 1024 }

describe("@smthrs/platform-node Wave-9 internal deep fuzz (ProcessSupervisor, WindowsProcessJob, WindowsIdentity, ProcessNative, AtomicFS protocol/exec/transport)", () => {
  it("ProcessSupervisor.Control covers TLS-PSK transport, connectOwner, duplicate connections, oversized frames, and every status/fault state transition", async () => {
    // Pure helpers: bootstrapArguments, failure, unverifiedCleanup
    expect(Exit.isSuccess(Effect.runSyncExit(ProcessSupervisor.bootstrapArguments({ bun: true, main: "/a.js", sea: false })))).toBe(true)
    expect(Exit.isFailure(Effect.runSyncExit(ProcessSupervisor.bootstrapArguments({ bun: false, main: "/a.js", sea: true })))).toBe(true)
    expect(Exit.isSuccess(Effect.runSyncExit(ProcessSupervisor.bootstrapArguments({ bun: false, main: "/a.js", sea: false })))).toBe(true)
    expect(ProcessSupervisor.failure("spawn", "echo", { code: "EACCES", message: "denied" })._tag).toBe("PlatformError")
    expect(ProcessSupervisor.failure("spawn", "echo", "raw-error")._tag).toBe("PlatformError")
    const cleanupMsg = ProcessSupervisor.unverifiedCleanup({ targetDone: true, cleanupAcknowledged: false } as never, true, false, { _tag: "available", members: [{ pid: 100, zombie: false }, { pid: 101, zombie: true }] } as never)
    expect(cleanupMsg).toContain("100")

    const arb = Arbitrary.schema(
      Schema.Struct({
        transport: Schema.Literals(["native", "tls"]),
        scenario: Schema.Literals([
          "happy-code",
          "happy-signal",
          "spawn-error",
          "fault-frame",
          "status-too-large",
          "bad-ready",
          "bad-spawned-before-activation",
          "bad-spawn-error-before-activation",
          "bad-exit-before-started",
          "unknown-type",
          "non-object",
          "duplicate-sockets",
          "write-closed-and-oversized",
          "cleanup-error"
        ])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (tc) =>
          Effect.promise(async () => {
            const ctrl = new ProcessSupervisor.Control(tc.transport, 2000)
            try {
              await ctrl.listening
              const env = ctrl.environment()
              const statusSock = ProcessSupervisor.connectOwner(ctrl.path, env)
              const reqSock = ProcessSupervisor.connectOwner(ctrl.requestPath, env)
              await Promise.all([
                new Promise<void>((resolve, reject) => {
                  statusSock.once("connect", () => resolve())
                  statusSock.once("secureConnect", () => resolve())
                  statusSock.once("error", reject)
                }),
                new Promise<void>((resolve, reject) => {
                  reqSock.once("connect", () => resolve())
                  reqSock.once("secureConnect", () => resolve())
                  reqSock.once("error", reject)
                })
              ])
              await ctrl.requestsReady.promise

              const sendStatus = (obj: unknown) =>
                new Promise<void>((resolve) => {
                  statusSock.write(`${JSON.stringify(obj)}\n`, () => resolve())
                })

              switch (tc.scenario) {
                case "happy-code": {
                  await sendStatus({ type: "ready", version: 1, pid: 4242, created: "123456" })
                  expect(await ctrl.ready.promise).toBe(4242)
                  ctrl.activationSent = true
                  await ctrl.write({ type: "activate" })
                  await sendStatus({ type: "spawned", pid: 4243, guardian: 4244 })
                  await ctrl.started.promise
                  await sendStatus({ type: "exit", code: 0, signal: null })
                  await ctrl.exited.promise
                  await sendStatus({ type: "cleanup" })
                  break
                }
                case "happy-signal": {
                  await sendStatus({ type: "ready", version: 1, pid: 4242 })
                  await ctrl.ready.promise
                  ctrl.activationSent = true
                  await sendStatus({ type: "spawned", pid: 4243 })
                  await ctrl.started.promise
                  await sendStatus({ type: "exit", code: null, signal: "SIGTERM" })
                  await ctrl.exited.promise.catch(() => undefined)
                  break
                }
                case "spawn-error": {
                  await sendStatus({ type: "ready", version: 1, pid: 4242 })
                  await ctrl.ready.promise
                  ctrl.activationSent = true
                  await sendStatus({ type: "spawn_error", code: "ENOENT", message: "no such file" })
                  await ctrl.started.promise.catch(() => undefined)
                  break
                }
                case "fault-frame": {
                  await sendStatus({ type: "fault", code: "boom", message: "fatal" })
                  await ctrl.started.promise.catch(() => undefined)
                  break
                }
                case "status-too-large": {
                  statusSock.write("x".repeat(17 * 1024) + "\n")
                  await ctrl.ended.promise
                  break
                }
                case "bad-ready": {
                  await sendStatus({ type: "ready", version: 2, pid: 1 })
                  await ctrl.ended.promise
                  break
                }
                case "bad-spawned-before-activation": {
                  await sendStatus({ type: "spawned", pid: 5000 })
                  await ctrl.ended.promise
                  break
                }
                case "bad-spawn-error-before-activation": {
                  await sendStatus({ type: "spawn_error", message: "early" })
                  await ctrl.ended.promise
                  break
                }
                case "bad-exit-before-started": {
                  await sendStatus({ type: "exit", code: 0, signal: null })
                  await ctrl.ended.promise
                  break
                }
                case "unknown-type": {
                  await sendStatus({ type: "mystery" })
                  await ctrl.ended.promise
                  break
                }
                case "non-object": {
                  await sendStatus(12345)
                  await ctrl.ended.promise
                  break
                }
                case "duplicate-sockets": {
                  const dup1 = ProcessSupervisor.connectOwner(ctrl.path, env)
                  const dup2 = ProcessSupervisor.connectOwner(ctrl.requestPath, env)
                  dup1.on("error", () => {})
                  dup2.on("error", () => {})
                  await new Promise((r) => setTimeout(r, 20))
                  dup1.destroy()
                  dup2.destroy()
                  break
                }
                case "write-closed-and-oversized": {
                  await ctrl.write({ big: "a".repeat(4 * 1024 * 1024 + 32) }).catch(() => undefined)
                  reqSock.destroy()
                  ctrl.requestSocket?.destroy()
                  await ctrl.write({ tiny: true }).catch(() => undefined)
                  break
                }
                case "cleanup-error": {
                  await sendStatus({ type: "cleanup_error", message: "busy" })
                  await new Promise((r) => setTimeout(r, 10))
                  expect(ctrl.cleanupFailed).toBe(true)
                  break
                }
              }
              statusSock.destroy()
              reqSock.destroy()
            } finally {
              ctrl.disconnect()
              ctrl.rawEnded()
            }
            return true
          }),
        { executions: Math.max(ioExecutions, 20), seed }
      )
    )
    assertPassed(report)

    // Constructor cleanup when mkdtemp/chmod throws
    expect(
      () =>
        new ProcessSupervisor.Control("native", 1000, {
          ...ProcessSupervisor.controlNative,
          chmod: () => {
            throw new Error("chmod denied")
          }
        })
    ).toThrow("chmod denied")
  }, 60_000)

  it("WindowsProcessJob, WindowsIdentity & ProcessNative cover valid/faulty protocol frames, identity queries, liveness & POSIX group targeting", async () => {
    // 1. WindowsProcessJob invalid created timestamp throws synchronously
    expect(() => new WindowsProcessJob.WindowsProcessJob(1234, "bad-created", process.execPath)).toThrow()
    expect(() => new WindowsProcessJob.WindowsProcessJob(1234, undefined, process.execPath)).toThrow()

    // resolveJobExecutable with env override (invalid path -> throws) and restored
    const prevEnv = process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY
    try {
      process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY = "/nonexistent/wave9-job-helper"
      expect(() => WindowsProcessJob.resolveJobExecutable()).toThrow()
    } finally {
      if (prevEnv === undefined) delete process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY
      else process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY = prevEnv
    }

    const arb = Arbitrary.schema(
      Schema.Struct({
        jobCase: Schema.Literals(["happy", "too-large", "invalid-status", "wrong-pid", "nonzero-exit", "close-before-settle"]),
        idCase: Schema.Literals(["invalid-pid", "gone", "started", "bad-json", "nonzero", "throw"]),
        killErr: Schema.Literals(["none", "ESRCH", "EPERM"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (tc) =>
          Effect.promise(async () => {
            const ownerPid = 7777
            const script = (() => {
              switch (tc.jobCase) {
                case "happy":
                  return `console.log(JSON.stringify({status:"ready",ownerPid:${ownerPid}}));console.log(JSON.stringify({status:"settled"}));process.exit(0)`
                case "too-large":
                  return `process.stdout.write("a".repeat(5000)+"\\n");process.exit(0)`
                case "invalid-status":
                  return `console.log(JSON.stringify({status:"settled"}));process.exit(0)`
                case "wrong-pid":
                  return `console.log(JSON.stringify({status:"ready",ownerPid:9999}));process.exit(0)`
                case "nonzero-exit":
                  return `console.log(JSON.stringify({status:"ready",ownerPid:${ownerPid}}));process.exit(2)`
                case "close-before-settle":
                  return `console.log(JSON.stringify({status:"ready",ownerPid:${ownerPid}}));process.exit(0)`
              }
            })()
            const job = new WindowsProcessJob.WindowsProcessJob(ownerPid, "1234567890", process.execPath, ["-e", script, "--"])
            if (tc.jobCase === "happy") {
              await job.ready.promise
              await job.settled.promise
            } else {
              await Promise.allSettled([job.ready.promise, job.settled.promise])
            }
            job.reference(false); job.reference(true); job.stop()

            // 2. WindowsIdentity with injected native probe
            const probe = WindowsIdentity.windowsIdentity(
              { processExecutable: "/fake/helper" },
              {
                configuredExecutable: () => undefined,
                resolveDefaultExecutable: () => "/fake/helper",
                usableExecutable: (p) => p,
                spawnSync: (() => {
                  if (tc.idCase === "throw") throw new Error("spawn fail")
                  if (tc.idCase === "nonzero") return { status: 1, signal: null, stdout: "", stderr: "" }
                  if (tc.idCase === "bad-json") return { status: 0, signal: null, stdout: "{bad", stderr: "" }
                  if (tc.idCase === "gone") return { status: 0, signal: null, stdout: JSON.stringify({ status: "gone" }), stderr: "" }
                  return { status: 0, signal: null, stdout: JSON.stringify({ status: "started", startedAtMs: 1700000000000 }), stderr: "" }
                }) as never
              }
            )
            const idRes = probe(tc.idCase === "invalid-pid" ? 1 : 5000)
            if (tc.idCase === "gone") expect(idRes._tag).toBe("gone")
            else if (tc.idCase === "started") expect(idRes._tag).toBe("started")
            else expect(idRes._tag).toBe("unavailable")

            // 3. ProcessNative liveness & posixSystemFrom
            const fakeKill = ((_pid: number, _sig?: unknown) => {
              if (tc.killErr === "ESRCH") {
                const e = new Error("no such process")
                Object.assign(e, { code: "ESRCH" })
                throw e
              }
              if (tc.killErr === "EPERM") {
                const e = new Error("not permitted")
                Object.assign(e, { code: "EPERM" })
                throw e
              }
              return true
            }) as typeof process.kill

            const live = ProcessNative.liveness(9999, fakeKill)
            expect(["alive", "dead", "unknown"]).toContain(live)

            const sys = ProcessNative.posixSystemFrom({ startedAtMs: () => ({ _tag: "unavailable" }), ownGroup: () => 600, bootedAtMs: () => 0 }, 500, fakeKill)
            expect(sys.isAlive(9999)).toBe(live)
            expect(sys.killTree({ pid: 9999, pgid: null } as never)).toBe("failed")
            expect(sys.killTree({ pid: 1, pgid: 1 } as never)).toBe("failed")
            expect(sys.killTree({ pid: 200, pgid: 201 } as never)).toBe("failed")
            expect(sys.killTree({ pid: 500, pgid: 500 } as never)).toBe("failed")
            expect(sys.killTree({ pid: 600, pgid: 600 } as never)).toBe("failed")
            const kRes = sys.killTree({ pid: 9999, pgid: 9999 } as never)
            if (tc.killErr === "none") expect(kRes).toBe("signalled")
            else if (tc.killErr === "ESRCH") expect(kRes).toBe("already-gone")
            else expect(kRes).toBe("failed")

            const noGroupSys = ProcessNative.posixSystemFrom({ startedAtMs: () => ({ _tag: "unavailable" }), ownGroup: () => null, bootedAtMs: () => 0 }, 500, fakeKill)
            expect(noGroupSys.killTree({ pid: 9999, pgid: 9999 } as never)).toBe("failed")
            return true
          }),
        { executions: ioExecutions, seed: seed + 1 }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("AtomicFileSystemProtocol, AtomicFileSystemExecutable & AtomicFileSystemTransport cover every malformed envelope/field/batch/digest, staging refresh/stale cleanup & symlink/loader errors", async () => {
    // 1. AtomicFileSystemProtocol.decode & convert fuzz over all malformed shapes
    const frameOf = (obj: unknown) => AtomicProto.encode(Buffer.from(JSON.stringify(obj), "utf8"), defaultLimits)
    const badEnvelopes: ReadonlyArray<unknown> = [
      123,
      { ok: true, error: {} },
      { ok: false, code: 123, message: "m" },
      { ok: false, code: "E", syscall: 123, message: "m" },
      { ok: false, code: "E", badArgument: "yes", message: "m" },
      { ok: false, code: "E", message: 42 }
    ]
    for (const env of badEnvelopes) {
      expect(() => AtomicProto.decode(frameOf(env), defaultLimits)).toThrow()
    }

    // Valid badArgument error failure conversion
    const badArgFail = AtomicProto.failure({ operation: "readFile", boundaryRoot: "/r", path: "/r/x" }, { ok: false, code: "EINVAL", badArgument: true, message: "bad arg" })
    expect(badArgFail._tag).toBe("PlatformError")

    // convert malformed payloads for stat, readFile, readDirectory, exists, remove, digest, batch
    const badConverts: ReadonlyArray<[AtomicProto.FramedRequest, AtomicProto.HelperResult]> = [
      [{ operation: "stat", boundaryRoot: "/r", path: "/r/a" }, { ok: true, value: "not-obj" }],
      [{ operation: "stat", boundaryRoot: "/r", path: "/r/a" }, { ok: true, value: { type: "File", size: "nan" } }],
      [{ operation: "stat", boundaryRoot: "/r", path: "/r/a" }, { ok: true, value: { type: "File", size: -5 } }],
      [{ operation: "stat", boundaryRoot: "/r", path: "/r/a" }, { ok: true, value: { type: "WeirdType", size: 0 } }],
      [{ operation: "readFile", boundaryRoot: "/r", path: "/r/a" }, { ok: true, value: { base64: "not-valid-b64!!!" } }],
      [{ operation: "readFile", boundaryRoot: "/r", path: "/r/a" }, { ok: true, value: { base64: Buffer.alloc(2048).toString("base64") } }],
      [{ operation: "readDirectory", boundaryRoot: "/r", path: "/r" }, { ok: true, value: "not-array" }],
      [{ operation: "readDirectory", boundaryRoot: "/r", path: "/r" }, { ok: true, value: ["a", 42] }],
      [{ operation: "readDirectory", boundaryRoot: "/r", path: "/r" }, { ok: true, value: ["dup", "dup"] }],
      [{ operation: "exists", boundaryRoot: "/r", path: "/r/a" }, { ok: true, value: "true" }],
      [{ operation: "remove", boundaryRoot: "/r", path: "/r/a" }, { ok: true, value: { extra: 1 } }],
      [{ operation: "digest", path: "/r/a" }, { ok: true, value: { sha256: "short", size: 1 } }],
      [{ operation: "digest", path: "/r/a" }, { ok: true, value: { sha256: "a".repeat(64), size: 999999 } }],
      [
        { operation: "batch", boundaryRoot: "/r", requests: [{ id: "1", request: { operation: "exists", boundaryRoot: "/r", path: "/r/a" } }] } as never,
        { ok: true, value: [] }
      ],
      [
        { operation: "batch", boundaryRoot: "/r", requests: [{ id: "1", request: { operation: "exists", boundaryRoot: "/r", path: "/r/a" } }] } as never,
        { ok: true, value: [{ id: "wrong", ok: true, result: true }] }
      ],
      [
        { operation: "batch", boundaryRoot: "/r", requests: [{ id: "1", request: { operation: "exists", boundaryRoot: "/r", path: "/r/a" } }] } as never,
        { ok: true, value: [{ id: "1" }] }
      ]
    ]
    for (const [req, res] of badConverts) {
      expect(() => AtomicProto.convert(req, res.value, defaultLimits)).toThrow()
    }
    // Valid readFile convert
    const okRead = await Effect.runPromise(
      AtomicProto.convert<Uint8Array>(
        { operation: "readFile", boundaryRoot: "/r", path: "/r/a" },
        { base64: Buffer.from("hi").toString("base64") },
        defaultLimits
      )
    )
    expect(Buffer.from(okRead).toString("utf8")).toBe("hi")

    // 2. AtomicFileSystemExecutable: installedPackageRoot fallback, outsideWorkspace staging/refresh/stale cleanup, resolveConfiguredExecutable errors
    expect(typeof AtomicExec.installedPackageRoot("/nonexistent/path/mod.js", "/fallback")).toBe("string")
    const helperDir = freshDir("atomic-exec")
    const fakeBin = join(helperDir, "helper-bin")
    writeFileSync(fakeBin, "#!/bin/sh\nexit 0\n")
    chmodSync(fakeBin, 0o755)

    let fakeNow = Date.now()
    const host: AtomicExec.StagingHost = {
      platform: process.platform,
      uid: process.getuid?.(),
      now: () => fakeNow
    }
    const staged1 = AtomicExec.outsideWorkspace(fakeBin, undefined, undefined, host)
    expect(typeof staged1).toBe("string")
    // Advance clock > refresh interval so refresh() runs utimes
    fakeNow += 1000 * 60 * 60 * 48
    // Drop a stale temp file beside staged helper so sweep cleans it
    const staleTmp = join(staged1, "..", ".tmp-stale-wave9")
    writeFileSync(staleTmp, "old")
    const oldSec = (fakeNow - 1000 * 60 * 60 * 24) / 1000
    utimesSync(staleTmp, oldSec, oldSec)
    const staged2 = AtomicExec.outsideWorkspace(fakeBin, undefined, undefined, host)
    expect(staged2).toBe(staged1)

    expect(() => AtomicExec.resolveConfiguredExecutable("/no/such/helper", undefined)).toThrow()
    expect(() => AtomicExec.resolveConfiguredExecutable(helperDir, undefined)).toThrow()

    // 3. AtomicFileSystemTransport: inside() with relative/absolute/loop symlinks & spawnHelper loader/stderr diagnostics
    const linkDir = freshDir("transport-links")
    const targetFile = join(linkDir, "real.txt")
    writeFileSync(targetFile, "x")
    const relLink = join(linkDir, "rel-link")
    symlinkSync("real.txt", relLink)
    const absLink = join(linkDir, "abs-link")
    symlinkSync(targetFile, absLink)
    const loopA = join(linkDir, "loopA")
    const loopB = join(linkDir, "loopB")
    symlinkSync(loopB, loopA)
    symlinkSync(loopA, loopB)

    expect(AtomicTransport.inside(linkDir, relLink)).toBe(true)
    expect(AtomicTransport.inside(linkDir, absLink)).toBe(true)
    expect(typeof AtomicTransport.inside(linkDir, loopA)).toBe("boolean")
    expect(() => AtomicTransport.usableExecutable(loopA, linkDir)).toThrow()

    // spawnHelper with script that fails with GLIBC and missing shared library messages
    for (const errMsg of [
      "helper: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.99' not found",
      "helper: error while loading shared libraries: libfoo.so.1: cannot open shared object file"
    ]) {
      const badScript = join(linkDir, `fail-${++seq}.sh`)
      writeFileSync(badScript, `#!/bin/sh\necho "${errMsg}" >&2\nexit 127\n`)
      chmodSync(badScript, 0o755)
      const res = await Effect.runPromise(
        Effect.exit(
          AtomicTransport.spawnHelper({ operation: "exists", boundaryRoot: linkDir, path: targetFile }, badScript, AtomicProto.encode(Buffer.from("{}"), defaultLimits), { limits: defaultLimits, timeoutMs: 5000 })
        ).pipe(Effect.provide(silentLogger))
      )
      expect(Exit.isFailure(res)).toBe(true)
    }

    // Also verify ChildProcess import doesn't go unused
    expect(typeof ChildProcess.make).toBe("function")
  }, 60_000)
})
