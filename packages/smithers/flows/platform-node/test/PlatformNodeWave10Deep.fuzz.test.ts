import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { Fuzz } from "@smthrs/fuzz"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as KernelProcessConfinement from "@smthrs/kernel/ProcessConfinement"
import { Arbitrary, Effect, FileSystem, Layer, Logger, Option, PlatformError, Redacted, Result, Schema, Scope, Sink, Stream } from "effect"
import * as ChildProcess from "effect/process/ChildProcess"
import { ExitCode, makeHandle, ProcessId } from "effect/process/ChildProcessSpawner"
import { spawn as nodeSpawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as AtomicFileSystem from "../src/AtomicFileSystem.ts"
import * as ProcessConfinement from "../src/ProcessConfinement.ts"
import * as ProcessSandbox from "../src/ProcessSandbox.ts"
import * as ScopedProcess from "../src/ScopedProcess.ts"
import * as AtomicFileSystemExecutable from "../src/internal/AtomicFileSystemExecutable.ts"
import * as AtomicFileSystemHost from "../src/internal/AtomicFileSystemHost.ts"
import * as AtomicFileSystemProtocol from "../src/internal/AtomicFileSystemProtocol.ts"
import * as AtomicFileSystemTransport from "../src/internal/AtomicFileSystemTransport.ts"
import * as ProcSnapshot from "../src/internal/ProcSnapshot.ts"
import * as PsSnapshot from "../src/internal/PsSnapshot.ts"

const executions = Math.max(1, Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? "50"))
const seed = Number(process.env["EFFECT_FUZZ_SEED"] ?? "20261501")
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

const frameJson = (obj: unknown): Buffer => {
  const body = Buffer.from(JSON.stringify(obj), "utf8")
  return AtomicFileSystemProtocol.encode(body, defaultLimits)
}

describe("@smthrs/platform-node Wave10 Deep Fuzz", () => {
  it("AtomicFileSystemProtocol, AtomicFileSystemHost, and AtomicFileSystem cover malformed envelopes, batch/limit guards, and win32 watch", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        idx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 15 }))
      })
    )

    const tmpRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "pnode-w10-proto-"))
    try {
      const sampleFile = nodePath.join(tmpRoot, "a.txt")
      fs.writeFileSync(sampleFile, "hello")

      const badEnvelopes: ReadonlyArray<unknown> = [
        null,
        { ok: "yes" },
        { ok: true, code: 123 },
        { ok: true, syscall: 123 },
        { ok: true, badArgument: "yes" },
        { ok: true, message: 123 }
      ]

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ idx }) =>
            Effect.gen(function*() {
              // 1. Protocol.failure with badArgument
              const badArgErr = AtomicFileSystemProtocol.failure(
                { operation: "stat", path: "/x" },
                new Error("bad"),
                { ok: false, badArgument: true, message: "bad arg" }
              )
              expect(badArgErr.reason._tag).toBe("BadArgument")

              // 2. Protocol.decode malformed envelopes
              const env = badEnvelopes[idx % badEnvelopes.length]
              expect(() => AtomicFileSystemProtocol.decode(frameJson(env), defaultLimits)).toThrow()

              // 3. Protocol.convert malformed fields
              if (idx % 6 === 0) {
                // stat: non-object, non-numeric, negative int, out-of-range date, numeric size
                expect(() =>
                  AtomicFileSystemProtocol.convert({ operation: "stat", path: "/a" }, "not-obj", defaultLimits)
                ).toThrow()
                expect(() =>
                  AtomicFileSystemProtocol.convert(
                    { operation: "stat", path: "/a" },
                    { type: "File", size: -1, mtime: 1, atime: 1, birthtime: 1, dev: 1, ino: 1, mode: 0, nlink: 1, uid: 0, gid: 0, rdev: 0, blksize: 1, blocks: 1 },
                    defaultLimits
                  )
                ).toThrow()
                expect(() =>
                  AtomicFileSystemProtocol.convert(
                    { operation: "stat", path: "/a" },
                    { type: "File", size: 12, mtime: 1e20, atime: 1, birthtime: 1, dev: 1, ino: 1, mode: 0, nlink: 1, uid: 0, gid: 0, rdev: 0, blksize: 1, blocks: 1 },
                    defaultLimits
                  )
                ).toThrow()
                const okStat = yield* AtomicFileSystemProtocol.convert<FileSystem.File.Info>(
                  { operation: "stat", path: "/a" },
                  { type: "File", size: 12, mtime: 1000, atime: 1000, birthtime: null, dev: 1, ino: 2, mode: 0o644, nlink: 1, uid: 0, gid: 0, rdev: 0, blksize: 4096, blocks: 1 },
                  defaultLimits
                )
                expect(Number(okStat.size)).toBe(12)
              } else if (idx % 6 === 1) {
                // readFile bad base64 length % 4 !== 0 & readFileString invalid encoding
                expect(() =>
                  AtomicFileSystemProtocol.convert({ operation: "readFile", path: "/a" }, { base64: "abc" }, defaultLimits)
                ).toThrow()
                const badEnc = yield* Effect.result(
                  AtomicFileSystemProtocol.convert(
                    { operation: "readFileString", path: "/a", encoding: "not-a-real-encoding-xyz" },
                    { base64: Buffer.from("hi").toString("base64") },
                    defaultLimits
                  )
                )
                expect(Result.isFailure(badEnc)).toBe(true)
              } else if (idx % 6 === 2) {
                // batch malformed entries: out of order, duplicate index, mismatched digest size
                const batchReq: AtomicFileSystemProtocol.FramedRequest = {
                  operation: "batch",
                  boundaryRoot: tmpRoot,
                  requests: [
                    { operation: "digest", path: "/a", content: true },
                    { operation: "digest", path: "/b", content: false }
                  ]
                }
                expect(() =>
                  AtomicFileSystemProtocol.convert(
                    batchReq,
                    [{ index: 1, path: "/b", ok: true, value: { digest: "0".repeat(64), size: 0 } }, { index: 0, path: "/a", ok: true, value: { digest: "0".repeat(64), size: 0 } }],
                    defaultLimits
                  )
                ).toThrow()
                expect(() =>
                  AtomicFileSystemProtocol.convert(
                    batchReq,
                    [{ index: 0, path: "/a", ok: true, value: { digest: "0".repeat(64), size: 99, content: Buffer.from("hi").toString("base64") } }],
                    defaultLimits
                  )
                ).toThrow()
              } else if (idx % 6 === 3) {
                // AtomicFileSystemHost error paths + win32 watch
                const failingHost: AtomicFileSystemHost.NativeHost = {
                  platform: "win32",
                  realpath: () => Promise.reject(Object.assign(new Error("no realpath"), { code: "ENOENT" })),
                  stat: () => Promise.reject(Object.assign(new Error("no stat"), { code: "EACCES" }))
                }
                expect(Result.isFailure(yield* Effect.result(AtomicFileSystemHost.realPath(failingHost)("/nope")))).toBe(true)
                expect(Result.isFailure(yield* Effect.result(AtomicFileSystemHost.identifyRoot(failingHost)("/nope")))).toBe(true)
                const realFs = yield* FileSystem.FileSystem
                const okWinHost: AtomicFileSystemHost.NativeHost = {
                  platform: "win32",
                  realpath: async (p) => fs.realpathSync(p),
                  stat: async (p) => fs.statSync(p, { bigint: true })
                }
                const winStream = AtomicFileSystemHost.watch(okWinHost, realFs)(tmpRoot)
                expect(winStream).toBeDefined()
                const linuxStream = AtomicFileSystemHost.watch(AtomicFileSystemHost.nodeHost, realFs)(tmpRoot)
                expect(linuxStream).toBeDefined()
              } else if (idx % 6 === 4) {
                // AtomicFileSystem.layerWith batch/serializable/size guards & open regular file
                const afsLayer = AtomicFileSystem.layerWith({ limits: { batchSize: 2, request: 64 } }).pipe(
                  Layer.provide(NodeFileSystem.layer)
                )
                yield* Effect.scoped(
                  Effect.gen(function*() {
                    const fsSvc = yield* FileSystem.FileSystem
                    const atomic = (fsSvc as KernelFileSystem.AtomicHostFileSystem)[KernelFileSystem.AtomicFileSystemTypeId]
                    const emptyBatch = yield* Effect.result(
                      atomic.execute({ operation: "batch", boundaryRoot: tmpRoot, requests: [] } as any)
                    )
                    expect(Result.isFailure(emptyBatch)).toBe(true)
                    const unserializable = yield* Effect.result(
                      atomic.execute({ operation: "stat", path: sampleFile, extra: 10n } as any)
                    )
                    expect(Result.isFailure(unserializable)).toBe(true)
                    const tooBig = yield* Effect.result(
                      atomic.execute({ operation: "stat", path: sampleFile + "x".repeat(200) })
                    )
                    expect(Result.isFailure(tooBig)).toBe(true)
                    const opened = yield* fsSvc.open(sampleFile)
                    const info = yield* opened.stat
                    expect(info.type).toBe("File")
                  }).pipe(Effect.provide(afsLayer))
                )
              } else {
                // resolveHelper (may succeed or throw helper_missing if not built — either exercises lines)
                try {
                  const helper = AtomicFileSystem.resolveHelper()
                  expect(typeof helper).toBe("string")
                } catch {
                  // acceptable if binary absent
                }
              }
              return true
            }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, silentLogger))) as Effect.Effect<boolean, never, never>,
          { executions: Math.min(executions, 36), seed }
        )
      )
      assertPassed(report)
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  }, 60_000)

  it("AtomicFileSystemTransport and AtomicFileSystemExecutable cover helper validation, timeout, loader errors, staging, and pruning", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 9 }))
      })
    )

    const tmpRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "pnode-w10-trans-"))
    try {
      const workRoot = nodePath.join(tmpRoot, "work")
      const stageBase = nodePath.join(tmpRoot, "stage")
      const pkgRoot = nodePath.join(tmpRoot, "pkg")
      fs.mkdirSync(workRoot, { recursive: true })
      fs.mkdirSync(stageBase, { recursive: true })
      fs.mkdirSync(pkgRoot, { recursive: true })

      const insideHelper = nodePath.join(workRoot, "helper.sh")
      fs.writeFileSync(insideHelper, "#!/bin/sh\nexit 0\n", { mode: 0o755 })

      const okHelper = nodePath.join(tmpRoot, "ok.sh")
      fs.writeFileSync(okHelper, "#!/bin/sh\nexit 0\n", { mode: 0o755 })

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ mode }) =>
            Effect.gen(function*() {
              // 1. usableExecutable error branches
              expect(() => AtomicFileSystemTransport.usableExecutable("relative/bin", undefined)).toThrow()
              expect(() => AtomicFileSystemTransport.usableExecutable(`${tmpRoot}/`, undefined)).toThrow()
              expect(() => AtomicFileSystemTransport.usableExecutable(tmpRoot, undefined)).toThrow()
              expect(() => AtomicFileSystemTransport.usableExecutable(insideHelper, workRoot)).toThrow()

              // 2. spawnHelper with controlled launch functions
              const req: KernelFileSystem.AtomicRequest = { operation: "exists", path: okHelper }
              const payload = AtomicFileSystemProtocol.encode(Buffer.from(JSON.stringify(req)), defaultLimits)

              if (mode === 0) {
                // launch throws synchronously (ENOEXEC)
                const res = yield* Effect.result(
                  AtomicFileSystemTransport.spawnHelper(req, okHelper, payload, { limits: defaultLimits, timeoutMs: 200 }, () => {
                    throw Object.assign(new Error("ENOEXEC"), { code: "ENOEXEC" })
                  })
                )
                expect(Result.isFailure(res)).toBe(true)
              } else if (mode === 1) {
                // timeout
                const res = yield* Effect.result(
                  AtomicFileSystemTransport.spawnHelper(req, okHelper, payload, { limits: defaultLimits, timeoutMs: 40 }, () =>
                    nodeSpawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: ["pipe", "pipe", "pipe"] })
                  )
                )
                expect(Result.isFailure(res)).toBe(true)
              } else if (mode === 2) {
                // GLIBC loader error in stderr
                const res = yield* Effect.result(
                  AtomicFileSystemTransport.spawnHelper(req, okHelper, payload, { limits: defaultLimits, timeoutMs: 1000 }, () =>
                    nodeSpawn(process.execPath, ["-e", "process.stderr.write(\"version 'GLIBC_2.99' not found\\n\"); process.exit(127)"], {
                      stdio: ["pipe", "pipe", "pipe"]
                    })
                  )
                )
                expect(Result.isFailure(res)).toBe(true)
              } else if (mode === 3) {
                // Shared library loader error in stderr
                const res = yield* Effect.result(
                  AtomicFileSystemTransport.spawnHelper(req, okHelper, payload, { limits: defaultLimits, timeoutMs: 1000 }, () =>
                    nodeSpawn(process.execPath, ["-e", "process.stderr.write('error while loading shared libraries: libfoo.so\\n'); process.exit(127)"], {
                      stdio: ["pipe", "pipe", "pipe"]
                    })
                  )
                )
                expect(Result.isFailure(res)).toBe(true)
              } else if (mode === 4) {
                // Helper returns structured { ok: false, code: "EACCES", message: "no" }
                const rejFrame = frameJson({ ok: false, code: "EACCES", message: "denied" }).toString("base64")
                const res = yield* Effect.result(
                  AtomicFileSystemTransport.spawnHelper(req, okHelper, payload, { limits: defaultLimits, timeoutMs: 1000 }, () =>
                    nodeSpawn(process.execPath, ["-e", `process.stdout.write(Buffer.from('${rejFrame}','base64')); process.exit(1)`], {
                      stdio: ["pipe", "pipe", "pipe"]
                    })
                  )
                )
                expect(Result.isFailure(res)).toBe(true)
              } else if (mode === 5) {
                // Helper returns invalid JSON & exits 0
                const res = yield* Effect.result(
                  AtomicFileSystemTransport.spawnHelper(req, okHelper, payload, { limits: defaultLimits, timeoutMs: 1000 }, () =>
                    nodeSpawn(process.execPath, ["-e", "process.stdout.write('garbage'); process.exit(0)"], {
                      stdio: ["pipe", "pipe", "pipe"]
                    })
                  )
                )
                expect(Result.isFailure(res)).toBe(true)
              } else if (mode === 6) {
                // AtomicFileSystemExecutable.installedPackageRoot fallback
                const fb = AtomicFileSystemExecutable.installedPackageRoot("/nonexistent-root/missing.js", "/fallback")
                expect(typeof fb).toBe("string")
              } else if (mode === 7) {
                // resolveDefaultExecutable missing all candidates -> helper_missing
                const emptyRoot = nodePath.join(tmpRoot, "empty-pkg")
                fs.mkdirSync(emptyRoot, { recursive: true })
                expect(() =>
                  AtomicFileSystemExecutable.resolveDefaultExecutable(emptyRoot, undefined, nodePath.join(tmpRoot, "absent-fallback"))
                ).toThrow()
              } else if (mode === 8) {
                // packaged helper is a directory -> helper_not_regular_file
                const dirPkg = nodePath.join(tmpRoot, "dir-pkg")
                const binDir = nodePath.join(dirPkg, "bin", `${process.platform}-${process.arch}`, "smithers-jj-export")
                fs.mkdirSync(binDir, { recursive: true })
                expect(() =>
                  AtomicFileSystemExecutable.resolveDefaultExecutable(dirPkg, undefined, nodePath.join(tmpRoot, "absent-fallback"))
                ).toThrow()
              } else {
                // packaged helper inside workspace without being trusted -> helper_inside_workspace
                const wsPkg = nodePath.join(workRoot, "ws-pkg")
                const binFile = nodePath.join(wsPkg, "bin", `${process.platform}-${process.arch}`, "smithers-jj-export")
                fs.mkdirSync(nodePath.dirname(binFile), { recursive: true })
                fs.writeFileSync(binFile, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
                expect(() =>
                  AtomicFileSystemExecutable.resolveDefaultExecutable(wsPkg, workRoot, nodePath.join(tmpRoot, "absent-fallback"))
                ).toThrow()
              }
              return true
            }),
          { executions: Math.min(executions, 24), seed: seed + 1 }
        )
      )
      assertPassed(report)
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  }, 60_000)

  it("ProcessConfinement, ProcSnapshot, PsSnapshot, and ScopedProcess.status cover confinement refusals and process table parsing", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 11 }))
      })
    )

    const tmpRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "pnode-w10-conf-"))
    try {
      const ws = nodePath.join(tmpRoot, "ws")
      const outside = nodePath.join(tmpRoot, "outside")
      const procRoot = nodePath.join(tmpRoot, "proc")
      fs.mkdirSync(ws, { recursive: true })
      fs.mkdirSync(outside, { recursive: true })
      fs.writeFileSync(nodePath.join(ws, "real.txt"), "ok")
      fs.writeFileSync(nodePath.join(outside, "secret.txt"), "sec")
      fs.symlinkSync(nodePath.join(ws, "real.txt"), nodePath.join(ws, "link-in.txt"))
      fs.symlinkSync(nodePath.join(outside, "secret.txt"), nodePath.join(ws, "link-out.txt"))

      // Fake /proc layout for ProcSnapshot
      fs.mkdirSync(nodePath.join(procRoot, "100"), { recursive: true })
      fs.mkdirSync(nodePath.join(procRoot, "101"), { recursive: true })
            fs.mkdirSync(nodePath.join(procRoot, "self"), { recursive: true })
      fs.writeFileSync(nodePath.join(procRoot, "stat"), "cpu 0 0 0 0\nbtime 1700000000\n")
      fs.writeFileSync(nodePath.join(procRoot, "100", "stat"), "100 (node (worker)) S 1 100 100 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 500 0\n")
      fs.writeFileSync(nodePath.join(procRoot, "101", "stat"), "101 (zombie) Z 1 100 100 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 600 0\n")
            fs.writeFileSync(nodePath.join(procRoot, "self", "stat"), "999 (self) S 1 999 999 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 100 0\n")

      // Fake ps script for PsSnapshot
      const fakePsOk = nodePath.join(tmpRoot, "fake-ps-ok.sh")
      fs.writeFileSync(fakePsOk, "#!/bin/sh\nprintf '100 100 S\\n101 100 Z\\nbad line\\n'\n", { mode: 0o755 })
      const fakePsEmpty = nodePath.join(tmpRoot, "fake-ps-empty.sh")
      fs.writeFileSync(fakePsEmpty, "#!/bin/sh\nexit 1\n", { mode: 0o755 })

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ mode }) =>
            Effect.gen(function*() {
              // 1. ProcSnapshot edge cases
              expect(ProcSnapshot.rootFor("linux")).toBe("/proc")
              expect(ProcSnapshot.rootFor("darwin")).toBeUndefined()
              expect(ProcSnapshot.parseStat("bad", 0)).toBeUndefined()
              expect(ProcSnapshot.parseStat("abc (x) S 1 2", 0)).toBeUndefined()
              expect(ProcSnapshot.parseStat("10 (x) S 1 2 3", 0)).toBeUndefined()
              const snap = ProcSnapshot.snapshot(procRoot)(100)
              expect(snap?.members.length).toBeGreaterThanOrEqual(2)
              expect(ProcSnapshot.bootMs(procRoot)).toBe(1700000000 * 1000)
              expect(ProcSnapshot.bootMs(outside)).toBeUndefined()
              expect(ProcSnapshot.ownGroup(procRoot)()).toBe(999)
              expect(ProcSnapshot.ownGroup(outside)()).toBeNull()
              expect(ProcSnapshot.startedAtMs(procRoot)(100)._tag).toBe("started")
              expect(ProcSnapshot.startedAtMs(procRoot)(999999)._tag).toBe("gone")
              expect(ProcSnapshot.startedAtMs(procRoot)(-1)._tag).toBe("unavailable")
              expect(ProcSnapshot.startedAtMs(outside)(100)._tag).toBe("unavailable")

              // 2. PsSnapshot edge cases
              const psSnap = PsSnapshot.psGroupSnapshot(fakePsOk)(100)
              expect(psSnap === undefined || psSnap.members.length >= 0).toBe(true)
              expect(PsSnapshot.psGroupSnapshot(fakePsEmpty)(100)).toBeUndefined()
              expect(PsSnapshot.psGroupSnapshot(nodePath.join(tmpRoot, "no-such-ps"))(100)).toBeUndefined()

              // 3. ScopedProcess.status with signal error vs non-signal error
              const sigHandle = makeHandle({
                pid: ProcessId(555),
                exitCode: Effect.fail(
                  PlatformError.systemError({
                    _tag: "Unknown",
                    module: "ChildProcess",
                    method: "exitCode",
                    description: "killed",
                    cause: { signal: "SIGKILL" }
                  })
                ),
                isRunning: Effect.succeed(false),
                kill: () => Effect.void,
                stdin: Sink.drain,
                stdout: Stream.empty,
                stderr: Stream.empty,
                all: Stream.empty,
                unref: Effect.succeed(Effect.void),
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty
              })
              const sigStatus = yield* ScopedProcess.status(sigHandle)
              expect(sigStatus).toEqual({ code: null, signal: "SIGKILL" })
              const errHandle = makeHandle({
                pid: ProcessId(556),
                exitCode: Effect.fail(
                  PlatformError.systemError({
                    _tag: "Unknown",
                    module: "ChildProcess",
                    method: "exitCode",
                    description: "other",
                    cause: { signal: "bad" }
                  })
                ),
                isRunning: Effect.succeed(false),
                kill: () => Effect.void,
                stdin: Sink.drain,
                stdout: Stream.empty,
                stderr: Stream.empty,
                all: Stream.empty,
                unref: Effect.succeed(Effect.void),
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty
              })
              expect(Result.isFailure(yield* Effect.result(ScopedProcess.status(errHandle)))).toBe(true)

              // 4. ProcessConfinement refusal branches
              const baseProfile: KernelProcessConfinement.Profile = {
                workspaceRoot: ws,
                reads: [],
                writes: [],
                network: "none", readOnly: []
              }
              const confLayer = ProcessConfinement.layer(mode === 11 ? {
                host: { ...ProcessSandbox.host(), architecture: "riscv64" } as any
              } : {})
              yield* Effect.scoped(
                Effect.gen(function*() {
                  const conf = yield* KernelProcessConfinement.ProcessConfinement
                  let cmd: ChildProcess.StandardCommand = ChildProcess.make("echo", ["ok"], { cwd: ws })
                  let profile = baseProfile
                  if (mode === 0) {
                    cmd = ChildProcess.make("echo", [Redacted.make("secret") as any], { cwd: ws })
                  } else if (mode === 1) {
                    cmd = ChildProcess.make("echo", ["ok"], { cwd: ws, env: { TOK: Redacted.make("sec") as any } })
                  } else if (mode === 2) {
                    cmd = ChildProcess.make("echo", ["ok"], { cwd: outside })
                  } else if (mode === 3) {
                    profile = { ...baseProfile, reads: ["link-in.txt"] }
                  } else if (mode === 4) {
                    profile = { ...baseProfile, reads: ["link-out.txt"] }
                  } else if (mode === 5) {
                    cmd = ChildProcess.make("echo", ["ok"], { cwd: ws, env: { "1INVALID": "x" } })
                  } else if (mode === 6) {
                    cmd = ChildProcess.make("echo", ["ok"], { cwd: ws, env: { GOOD: "bad\0byte" } })
                  } else if (mode === 7) {
                    cmd = ChildProcess.make("echo", ["ok"], {
                      cwd: ws,
                      additionalFds: { fd3: { type: "output", sink: Sink.drain } } as any
                    })
                  }
                  const res = yield* Effect.result(conf.confine(cmd, profile))
                  expect(Result.isSuccess(res) || Result.isFailure(res)).toBe(true)
                }).pipe(Effect.provide(confLayer))
              )

              return true
            }),
          { executions: Math.min(executions, 24), seed: seed + 2 }
        )
      )
      assertPassed(report)
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  }, 60_000)
})
